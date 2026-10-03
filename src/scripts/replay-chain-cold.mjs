/**
 * Replay the whole migration journal into a blank database, in array order.
 *
 * This exists because `apply-chain-cold.mjs` does not finish. It stalls mid-chain — observed
 * twice, at journal positions 322 and 366 — with the server connection idle and the client
 * sending nothing, so a cold bootstrap could never be completed and none of the ordering defects
 * underneath it were visible. This runner replaced it and finished the full 562-entry chain in
 * about seventeen minutes.
 *
 * Two things make it work where the other does not. Each migration runs in its own transaction
 * with `statement_timeout = 0`, because several are heavy catalog DO-blocks that Neon otherwise
 * cancels on a cold build. And progress is recorded in `drizzle.__replay` rather than the Drizzle
 * ledger, so a killed run resumes instead of restarting — which matters when one pass takes
 * seventeen minutes.
 *
 * Array order, not `when`, is what governs a cold replay: a repair migration is positioned in the
 * array before the file that needs it while carrying a `when` above the production watermark, so
 * production still treats it as pending. The two answer different questions.
 *
 * Usage — the target must already exist, be empty, and have the five required extensions
 * (vector, pg_trgm, btree_gist, pgcrypto, uuid-ossp) created first:
 *
 *   COLD_DATABASE_URL=postgresql://… node src/scripts/replay-chain-cold.mjs
 *
 * Exit 0 when every entry applied; exit 1 with a per-migration failure list otherwise.
 */
import fs from "node:fs";
import process from "node:process";
import postgres from "postgres";
import { usesConcurrentIndex } from "./lib/concurrent-migration.mjs";
import { grantAppRoleDefaultPrivileges } from "./lib/app-role-default-privileges.mjs";

// See db-bootstrap.mjs: migration 0431 pins search_path on the role `neondb_owner`, so the
// unqualified `current_org_id()` calls in 0619 and its siblings resolve only under that name.
const MIGRATION_SEARCH_PATH = '"$user", public, build_events, app';

const url = process.env.COLD_DATABASE_URL;
if (!url) {
  process.stderr.write(
    "COLD_DATABASE_URL is required, and it must point at a BLANK database — never the live one.\n",
  );
  process.exit(2);
}

const sql = postgres(url, {
  prepare: false,
  max: 1,
  onnotice: () => {},
  idle_timeout: 0,
  connect_timeout: 60,
});
const journal = JSON.parse(fs.readFileSync("migrations/meta/_journal.json", "utf8"));
const started = Date.now();
let applied = 0;
let skipped = 0;
const failures = [];

try {
  await grantAppRoleDefaultPrivileges(sql);
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS drizzle`);
  await sql.unsafe(
    `CREATE TABLE IF NOT EXISTS drizzle.__replay (tag text primary key, at timestamptz default now())`,
  );
  const done = new Set((await sql`SELECT tag FROM drizzle.__replay`).map((r) => r.tag));

  for (const entry of journal.entries) {
    if (done.has(entry.tag)) {
      skipped++;
      continue;
    }
    const file = `migrations/${entry.tag}.sql`;
    if (!fs.existsSync(file)) {
      failures.push(`${entry.tag}: FILE MISSING`);
      continue;
    }
    const parts = fs
      .readFileSync(file, "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    const concurrent = parts.some((stmt) => usesConcurrentIndex(stmt));
    try {
      if (concurrent) {
        await sql.unsafe("SET statement_timeout = 0");
        await sql.unsafe("SET lock_timeout = '10s'");
        await sql.unsafe(`SET search_path = ${MIGRATION_SEARCH_PATH}`);
        for (const stmt of parts) await sql.unsafe(stmt);
        await sql`INSERT INTO drizzle.__replay (tag) VALUES (${entry.tag}) ON CONFLICT DO NOTHING`;
      } else {
        await sql.begin(async (tx) => {
          await tx.unsafe("SET statement_timeout = 0");
          await tx.unsafe("SET lock_timeout = '10s'");
          await tx.unsafe(`SET search_path = ${MIGRATION_SEARCH_PATH}`);
          for (const stmt of parts) await tx.unsafe(stmt);
          await tx`INSERT INTO drizzle.__replay (tag) VALUES (${entry.tag}) ON CONFLICT DO NOTHING`;
        });
      }
      applied++;
      if (applied % 25 === 0)
        process.stdout.write(
          `  ${applied} applied (${skipped} pre-done) at ${Math.round((Date.now() - started) / 1000)}s — last ${entry.tag}\n`,
        );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`${entry.tag}: ${msg.slice(0, 200)}`);
      process.stdout.write(`  FAIL ${entry.tag}: ${msg.slice(0, 140)}\n`);
    }
  }

  const [t] = await sql`SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'`;
  process.stdout.write(
    `\nRESULT: applied=${applied} skipped=${skipped} failures=${failures.length} tables=${t.n} in ${Math.round((Date.now() - started) / 1000)}s\n`,
  );
  if (failures.length > 0) {
    process.stdout.write("FAILURES:\n");
    for (const f of failures) process.stdout.write("  " + f + "\n");
  }
  process.exitCode = failures.length > 0 ? 1 : 0;
} finally {
  await sql.end();
}
