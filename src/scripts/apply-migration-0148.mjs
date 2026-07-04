import { createRequire } from "module";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const require = createRequire(import.meta.url);
const dotenv = require("dotenv");
dotenv.config({ path: ".env" });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error("No DATABASE_URL"); process.exit(1); }

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);
const migrationPath = join(__dir, "../../migrations/0148_payroll_integration_fixes.sql");

const rawSql = readFileSync(migrationPath, "utf-8");

const postgres = (await import("postgres")).default;
const sql = postgres(DATABASE_URL, { ssl: "require", max: 1 });

const statements = rawSql
  .split("--> statement-breakpoint")
  .map(s => s.trim())
  .filter(s => s.length > 0 && !s.startsWith("--"));

console.log(`Applying ${statements.length} statements from 0148_payroll_integration_fixes.sql ...`);

for (let i = 0; i < statements.length; i++) {
  const stmt = statements[i];
  const isAlterTypeEnum = /^\s*ALTER\s+TYPE\s+\S+\s+ADD\s+VALUE/i.test(stmt);
  try {
    if (isAlterTypeEnum) {
      await sql.unsafe(`BEGIN ISOLATION LEVEL SERIALIZABLE; ${stmt}; COMMIT;`).catch(async () => {
        await sql.unsafe("ROLLBACK");
        await sql.unsafe(stmt);
      });
    } else {
      await sql.unsafe(stmt);
    }
    process.stdout.write(".");
  } catch (err) {
    const msg = err.message ?? "";
    if (msg.includes("already exists") || msg.includes("does not exist")) {
      process.stdout.write("s");
    } else {
      console.error(`\nFailed at statement ${i + 1}:\n${stmt.slice(0, 200)}`);
      console.error(msg);
      await sql.end();
      process.exit(1);
    }
  }
}

console.log("\nAll statements applied. Verifying ...");

const colCheck = await sql`
  SELECT column_name, table_name
  FROM information_schema.columns
  WHERE table_schema = 'public'
  AND (
    (table_name = 'payroll_runs' AND column_name = 'closed_by')
    OR (table_name = 'payroll_bank_batches' AND column_name = 'file_key')
  )
  ORDER BY table_name, column_name
`;
console.log("NEW_COLUMNS:", JSON.stringify(colCheck.map(r => `${r.table_name}.${r.column_name}`)));

const droppedTables = await sql`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public'
  AND table_name IN ('payroll_custom_templates','payroll_lock_events','payslip_publish_events')
`;
if (droppedTables.length > 0) {
  console.error("ERROR: tables still exist:", droppedTables.map(r => r.table_name));
  await sql.end();
  process.exit(1);
}
console.log("DROPPED_TABLES: confirmed absent");

const enumVals = await sql`
  SELECT enumlabel FROM pg_enum
  JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
  WHERE pg_type.typname = 'payroll_run_event_type'
  ORDER BY enumsortorder
`;
const vals = enumVals.map(r => r.enumlabel);
if (!vals.includes("CLOSED")) {
  console.error("ERROR: CLOSED not found in payroll_run_event_type enum:", vals);
  await sql.end();
  process.exit(1);
}
console.log("ENUM_VALUES:", JSON.stringify(vals));

await sql.end();
console.log("Migration 0148 applied and verified.");
