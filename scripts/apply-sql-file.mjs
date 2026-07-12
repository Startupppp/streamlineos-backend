import postgres from "postgres";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const url = process.env.DATABASE_URL ?? process.env.DB;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Usage: node scripts/apply-sql-file.mjs <migration-file.sql> [...more]");
  process.exit(1);
}

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

for (const file of files) {
  if (!existsSync(join(migrationsDir, file))) {
    console.error(`NOT FOUND ${file}`);
    process.exit(1);
  }
}

const sql = postgres(url, {
  max: 1,
  ssl: url.includes("neon.tech") || url.includes("sslmode=require") ? "require" : undefined,
  prepare: false,
  idle_timeout: 5,
});

let failed = 0;
for (const file of files) {
  const content = readFileSync(join(migrationsDir, file), "utf8");
  try {
    await sql.unsafe(content);
    console.log(`OK   ${file}`);
  } catch (err) {
    failed += 1;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FAIL ${file} :: ${message}`);
  }
}

await sql.end({ timeout: 5 });
process.exit(failed > 0 ? 2 : 0);
