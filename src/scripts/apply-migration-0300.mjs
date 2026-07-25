import { createRequire } from "module";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const require = createRequire(import.meta.url);
const dotenv = require("dotenv");
dotenv.config({ path: ".env" });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("No DATABASE_URL");
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);
const migrationPath = join(__dir, "../../migrations/0300_kb_chunk_content_hash.sql");
const rawSql = readFileSync(migrationPath, "utf-8");

const postgres = (await import("postgres")).default;
const sql = postgres(DATABASE_URL, { ssl: "require", max: 1 });

const statements = rawSql
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter((s) => s.length > 0 && !s.startsWith("--"));

console.log(`Applying ${statements.length} KB statements from 0300 ...`);
let ok = 0;
for (const stmt of statements) {
  const label = stmt.slice(0, 70).replace(/\s+/g, " ");
  try {
    await sql.unsafe(stmt);
    ok++;
    console.log(`  OK: ${label}`);
  } catch (err) {
    console.error(`  FAIL: ${label}\n    -> ${err.message}`);
  }
}
console.log(`Done: ${ok}/${statements.length} applied.`);
await sql.end();
