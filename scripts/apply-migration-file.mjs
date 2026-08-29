// Apply one or more .sql files to a target Postgres/Neon database.
// Usage:
//   node scripts/apply-migration-file.mjs <file.sql> [more.sql...] [--url <CONNECTION_URL>]
// Falls back to DATABASE_URL (loaded from backend/.env) when --url is omitted.
// Runs each file as a single simple-query batch, so DO $$ blocks and multi-statement
// idempotent migrations apply correctly. Read-only NOTICEs are surfaced.
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as dotenv from "dotenv";

dotenv.config();

const args = process.argv.slice(2);
let url = process.env.DATABASE_URL;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--url") url = args[++i];
  else files.push(args[i]);
}

if (!url) {
  console.error("No target DB: pass --url <CONNECTION_URL> or set DATABASE_URL.");
  process.exit(1);
}
if (files.length === 0) {
  console.error("Usage: apply-migration-file.mjs <file.sql...> [--url <URL>]");
  process.exit(1);
}

const sql = postgres(url, {
  max: 1,
  onnotice: (n) => console.log("NOTICE:", n.message),
});

try {
  const [{ current_database }] = await sql`select current_database()`;
  console.log("Target database:", current_database);
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    console.log(`\n--- applying ${file} ---`);
    await sql.unsafe(content);
    console.log(`OK: ${file}`);
    // Record the hash, or the migration is permanently "pending".
    //
    // Applying a file by hand and not recording it is worse than not applying
    // it: the objects exist, so a later `db:migrate` tries the file again, hits
    // "already exists", and — because drizzle wraps every pending migration in
    // ONE transaction — rolls back the entire batch and swallows the error. That
    // is the trap the inventory handoff documents, and this script was causing
    // it. The hash is sha256 of the file contents, matching drizzle-kit.
    const hash = createHash("sha256").update(content).digest("hex");
    const [already] = await sql`SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = ${hash} LIMIT 1`;
    if (already) {
      console.log(`   (already recorded)`);
    } else {
      await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${hash}, ${Date.now()})`;
      console.log(`   recorded ${hash.slice(0, 12)}…`);
    }
  }
  console.log("\nAll files applied.");
} catch (err) {
  console.error("FAILED:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await sql.end();
}
