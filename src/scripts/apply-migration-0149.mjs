import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const require = createRequire(import.meta.url);
const dotenv = require("dotenv");
dotenv.config({ path: ".env" });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error("No DATABASE_URL"); process.exit(1); }

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);
const migrationPath = join(__dir, "../../migrations/0149_country_standard_templates.sql");

const postgres = (await import("postgres")).default;
const sql = postgres(DATABASE_URL, { ssl: "require", max: 1 });

const stmt = "ALTER TYPE payroll_template_category ADD VALUE 'COUNTRY_STANDARD'";

console.log("Applying migration 0149: ADD VALUE COUNTRY_STANDARD to payroll_template_category ...");

try {
  await sql.unsafe(stmt);
  process.stdout.write(".");
} catch (err) {
  const msg = (err && err.message) ?? "";
  if (msg.includes("already exists")) {
    process.stdout.write("s (already exists, skipping)");
  } else {
    console.error("\nFailed:", msg);
    await sql.end();
    process.exit(1);
  }
}

console.log("\nVerifying enum values ...");

const enumVals = await sql`
  SELECT enumlabel FROM pg_enum
  JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
  WHERE pg_type.typname = 'payroll_template_category'
  ORDER BY enumsortorder
`;
const vals = enumVals.map(r => r.enumlabel);
if (!vals.includes("COUNTRY_STANDARD")) {
  console.error("ERROR: COUNTRY_STANDARD not found in payroll_template_category enum:", vals);
  await sql.end();
  process.exit(1);
}
console.log("ENUM_VALUES:", JSON.stringify(vals));

await sql.end();
console.log("Migration 0149 applied and verified.");
