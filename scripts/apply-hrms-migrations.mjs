import postgres from "postgres";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const url = process.env.DATABASE_URL ?? process.env.DB;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const HRMS = /^02(0[1-9]|1[0-9]|2[0-5])_/;
const only = process.argv[2];

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql") && HRMS.test(f) && (!only || f.startsWith(only)))
  .sort();

const sql = postgres(url, {
  max: 1,
  ssl: url.includes("neon.tech") || url.includes("sslmode=require") ? "require" : undefined,
  prepare: false,
  idle_timeout: 5,
});

const results = [];
for (const file of files) {
  const content = readFileSync(join(migrationsDir, file), "utf8");
  try {
    await sql.unsafe(content);
    results.push({ file, ok: true });
    console.log(`OK   ${file}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ file, ok: false, error: message });
    console.error(`FAIL ${file} :: ${message}`);
  }
}

await sql.end({ timeout: 5 });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} applied.`);
if (failed.length > 0) {
  console.log("FAILURES:");
  for (const f of failed) console.log(`  ${f.file}: ${f.error}`);
  process.exit(2);
}
