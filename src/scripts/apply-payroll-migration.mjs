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
const migrationPath = join(__dir, "../../migrations/0147_payroll_domain.sql");

const rawSql = readFileSync(migrationPath, "utf-8");

const postgres = (await import("postgres")).default;
const sql = postgres(DATABASE_URL, { ssl: "require", max: 1 });

const statements = rawSql
  .split("--> statement-breakpoint")
  .map(s => s.trim())
  .filter(s => s.length > 0 && !s.startsWith("--"));

console.log(`Applying ${statements.length} statements from 0147_payroll_domain.sql ...`);

for (let i = 0; i < statements.length; i++) {
  const stmt = statements[i];
  try {
    await sql.unsafe(stmt);
    process.stdout.write(".");
  } catch (err) {
    console.error(`\nFailed at statement ${i + 1}:\n${stmt.slice(0, 200)}`);
    console.error(err.message);
    await sql.end();
    process.exit(1);
  }
}

console.log("\nAll statements applied. Verifying tables...");

const tables = await sql`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public'
  AND table_name IN (
    'payroll_policies','payroll_runs','payroll_run_employees',
    'salary_components','employee_salary_profiles','payroll_templates',
    'payroll_inputs','payroll_run_events','payslip_publications','payroll_tax_windows'
  )
  ORDER BY table_name
`;
console.log("VERIFIED_TABLES:", JSON.stringify(tables.map(r => r.table_name)));

const enums = await sql`
  SELECT typname FROM pg_type
  WHERE typtype = 'e'
  AND typname IN (
    'payroll_run_status','payroll_template_category','payroll_input_source',
    'payroll_run_event_type','payslip_publication_status','payroll_tax_window_status'
  )
  ORDER BY typname
`;
console.log("VERIFIED_ENUMS:", JSON.stringify(enums.map(r => r.typname)));

await sql.end();
console.log("Migration 0147 applied and verified.");
