/**
 * check-replay-ledger.mjs
 *
 * Compare the drizzle.__replay table (written by replay-chain-cold.mjs) against the
 * migration journal to verify ledger state after a cold bootstrap.
 *
 * Note: drizzle.__drizzle_migrations is written by `db:migrate` only, not by
 * replay-chain-cold.mjs.  Use this script for cold-replay databases.
 *
 * Usage:
 *   COLD_DATABASE_URL=postgresql://… node src/scripts/check-replay-ledger.mjs
 */
import fs from "node:fs";
import process from "node:process";
import postgres from "postgres";

const url = process.env.COLD_DATABASE_URL;
if (!url) {
  process.stderr.write("COLD_DATABASE_URL is required\n");
  process.exit(2);
}

const journal = JSON.parse(fs.readFileSync("migrations/meta/_journal.json", "utf8"));
const journalTags = new Set(journal.entries.map((e) => e.tag));

const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {}, connect_timeout: 60 });
try {
  const replayRows = await sql`SELECT tag FROM drizzle.__replay ORDER BY tag`.catch(() => []);
  const replayTags = new Set(replayRows.map((r) => r.tag));

  const applied = [...journalTags].filter((t) => replayTags.has(t));
  const notApplied = [...journalTags].filter((t) => !replayTags.has(t));
  const orphans = [...replayTags].filter((t) => !journalTags.has(t));

  const [t] = await sql`SELECT count(*)::int n FROM pg_tables WHERE schemaname = 'public'`;

  process.stdout.write(`Journal entries: ${journal.entries.length}\n`);
  process.stdout.write(`Applied (in __replay): ${applied.length}\n`);
  process.stdout.write(`Not applied (failed or skipped): ${notApplied.length}\n`);
  process.stdout.write(`Orphan rows (in __replay but not in journal): ${orphans.length}\n`);
  process.stdout.write(`Public tables: ${t.n}\n`);

  if (notApplied.length > 0) {
    process.stdout.write(`Not-applied tags:\n`);
    for (const tag of notApplied) process.stdout.write(`  ${tag}\n`);
  }
  if (orphans.length > 0) {
    process.stdout.write(`Orphan tags:\n`);
    for (const tag of orphans) process.stdout.write(`  ${tag}\n`);
  }

  const hasIssues = notApplied.length > 0 || orphans.length > 0;
  process.stdout.write(`LEDGER STATE: ${hasIssues ? "HAS ISSUES" : "CLEAN"}\n`);
  process.exitCode = hasIssues ? 1 : 0;
} finally {
  await sql.end();
}
