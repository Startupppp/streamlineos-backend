/**
 * apply-0000-workaround.mjs
 *
 * Apply the first migration (0000_light_vance_astro.sql) with an extended lock_timeout
 * of 120s, which is required on cold Neon endpoints.  The standard 10s lock_timeout
 * in replay-chain-cold.mjs consistently fails with PG 55P03 for this 997 KB, 4456-statement
 * migration.
 *
 * Records completion in drizzle.__replay so that replay-chain-cold.mjs will skip it on the
 * subsequent full-chain run.
 *
 * Usage:
 *   COLD_DATABASE_URL=postgresql://… node src/scripts/apply-0000-workaround.mjs
 */
import fs from "node:fs";
import process from "node:process";
import postgres from "postgres";

const url = process.env.COLD_DATABASE_URL;
if (!url) {
  process.stderr.write("COLD_DATABASE_URL is required\n");
  process.exit(2);
}

const JOURNAL_PATH = "migrations/meta/_journal.json";
const journal = JSON.parse(fs.readFileSync(JOURNAL_PATH, "utf8"));
const firstEntry = journal.entries[0];
if (!firstEntry) {
  process.stderr.write("Journal has no entries\n");
  process.exit(1);
}
const tag = firstEntry.tag;
const file = `migrations/${tag}.sql`;
if (!fs.existsSync(file)) {
  process.stderr.write(`Migration file not found: ${file}\n`);
  process.exit(1);
}

process.stdout.write(`Applying ${tag} with lock_timeout=120s\n`);

const sql = postgres(url, {
  prepare: false,
  max: 1,
  onnotice: () => {},
  idle_timeout: 0,
  connect_timeout: 120,
});

const parts = fs
  .readFileSync(file, "utf8")
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

process.stdout.write(`Statements: ${parts.length}\n`);

const started = Date.now();

try {
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS drizzle`);
  await sql.unsafe(
    `CREATE TABLE IF NOT EXISTS drizzle.__replay (tag text primary key, at timestamptz default now())`,
  );

  const existing = await sql`SELECT 1 FROM drizzle.__replay WHERE tag = ${tag}`;
  if (existing.length > 0) {
    process.stdout.write(`${tag} already in __replay — skipping\n`);
    process.exit(0);
  }

  await sql.begin(async (tx) => {
    await tx.unsafe("SET statement_timeout = 0");
    await tx.unsafe("SET lock_timeout = '120s'");
    let i = 0;
    for (const stmt of parts) {
      await tx.unsafe(stmt);
      i++;
      if (i % 500 === 0)
        process.stdout.write(`  progress: ${i}/${parts.length} at ${Math.round((Date.now() - started) / 1000)}s\n`);
    }
    await tx`INSERT INTO drizzle.__replay (tag) VALUES (${tag}) ON CONFLICT DO NOTHING`;
  });

  const elapsed = Math.round((Date.now() - started) / 1000);
  const [t] = await sql`SELECT count(*)::int n FROM pg_tables WHERE schemaname = 'public'`;
  process.stdout.write(`${tag}: APPLIED ${parts.length} statements in ${elapsed}s\n`);
  process.stdout.write(`Public tables after 0000: ${t.n}\n`);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`FAIL ${tag}: ${msg}\n`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
