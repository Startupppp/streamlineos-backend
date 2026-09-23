import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import postgres from "postgres";
import { assertProductionSafeTarget, runTargetGuardSelfTest } from "./lib/production-host-guard.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const MIGRATIONS = path.join(ROOT, "migrations");
const JOURNAL = path.join(MIGRATIONS, "meta", "_journal.json");



const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const tagArg = args.find((a) => a.startsWith("--tag="))?.slice("--tag=".length);

if (args.includes("--self-test")) runTargetGuardSelfTest("run-pending-migrations");

const url = process.env.DATABASE_URL ?? process.env.DB;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const _migGuard = assertProductionSafeTarget(url, process.env.ALLOW_PRODUCTION_MIGRATION);
if (!_migGuard.allowed) {
  console.error(`run-pending-migrations BLOCKED — ${_migGuard.reason}`);
  process.exit(2);
}

/**
 * TLS follows the connection string instead of being forced on.
 *
 * `ssl: "require"` was hardcoded, so this runner could not talk to a database
 * reached over `sslmode=disable` at all — it threw before it read anything.
 * The same hardcoding in `verify-migration-chain.mjs`'s watermark reader is
 * why check (f) silently skipped on every local run: the throw was swallowed
 * and reported as "no watermark".
 */
function sslFor(connectionString) {
  return /[?&]sslmode=disable\b/.test(connectionString) ? false : "require";
}

const { createScriptSql } = await import("./lib/script-sql-client.mjs");
const sql = await createScriptSql({
  url,
  ssl: sslFor(url),
  connection: { prepare: false, max: 1, ssl: sslFor(url), onnotice: () => {} },
});

/**
 * The same search path `db-bootstrap.mjs`, `replay-chain-cold.mjs` and
 * `migration-proof.mjs` set. This runner set none, and it is the only one that
 * runs every migration down one session.
 *
 * Two failures came out of that, both measured replaying the merged chain onto
 * a database at main's head. `0579_tenant_fks_build_schemas` references
 * `ticket_comments` unqualified, which lives in `build_events`, so it died with
 * "relation does not exist" — the same file applies cleanly through psql once
 * the path is set. And a migration issuing its own top-level `SET search_path`
 * (0619, 0653, 0655 do) left it set for every migration after it, because a
 * plain SET outlives the transaction that ran it. Setting the path at the start
 * of each migration fixes the first and contains the second.
 */
const MIGRATION_SEARCH_PATH = '"$user", public, build_events, app';

function statementsOf(text) {
  if (text.includes("--> statement-breakpoint"))
    return text.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
  return [text];
}

async function applyOne(entry, when) {
  const file = path.join(MIGRATIONS, `${entry.tag}.sql`);
  if (!fs.existsSync(file)) throw new Error(`missing file ${entry.tag}.sql`);
  const text = fs.readFileSync(file, "utf8");
  const hash = crypto.createHash("sha256").update(text).digest("hex");
  const already = await sql`select 1 from drizzle.__drizzle_migrations where hash = ${hash} limit 1`;
  if (already.length) {
    console.log(`  = ${entry.tag} already recorded, skipping`);
    return "skipped";
  }
  const concurrent = /CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(text);
  if (dryRun) {
    console.log(`  ~ ${entry.tag} would apply (${statementsOf(text).length} stmts${concurrent ? ", CONCURRENTLY -> no txn" : ""})`);
    return "dry";
  }
  if (concurrent) {
    await sql.unsafe(`SET search_path = ${MIGRATION_SEARCH_PATH}`);
    for (const stmt of statementsOf(text)) await sql.unsafe(stmt);
    await sql`insert into drizzle.__drizzle_migrations (hash, created_at) values (${hash}, ${when})`;
  } else {
    await sql.begin(async (tx) => {
      await tx.unsafe(`SET search_path = ${MIGRATION_SEARCH_PATH}`);
      await tx.unsafe(text);
      await tx`insert into drizzle.__drizzle_migrations (hash, created_at) values (${hash}, ${when})`;
    });
  }
  console.log(`  + ${entry.tag} applied`);
  return "applied";
}

try {
  const journal = JSON.parse(fs.readFileSync(JOURNAL, "utf8"));
  const [{ mx }] = await sql`select coalesce(max(created_at), 0) mx from drizzle.__drizzle_migrations`;
  const watermark = Number(mx);
  let queue;
  if (tagArg) {
    const entry = journal.entries.find((e) => e.tag === tagArg) ?? { tag: tagArg };
    queue = [[entry, entry.when ?? watermark + 1]];
    console.log(`Running explicit tag: ${tagArg}`);
  } else {
    /**
     * Every entry, in journal array order — NOT the ones whose `when` beats the
     * watermark.
     *
     * The watermark filter was a silent data-loss bug, and a measured one. The
     * journal has 32 entries whose `when` sits strictly below the running
     * maximum and 6 more equal to it, all inherited from parallel branches
     * merging. Under the old filter, applying `0557_relationship_states_deal_fk`
     * made 15 later entries permanently unselectable — the whole 0520–0524
     * billing block, 0540–0544 HR, 0565, 0575, 0580–0582 — and applying `0559`
     * cost another 17, including organization placement, the employment
     * sensitive-field envelope encryption, and the agent-token ceiling. Nothing
     * failed. The run reported success and those migrations were simply never
     * offered again.
     *
     * `applyOne` already refuses anything whose file hash is recorded, which is
     * the guard that actually prevents double application — and it is what the
     * other three appliers in this repository have always relied on. The
     * watermark is now reported for context and decides nothing.
     */
    queue = journal.entries.map((e) => [e, e.when]);
    const behind = journal.entries.filter((e) => e.when <= watermark).length;
    console.log(
      `watermark=${watermark} | queued=${queue.length} (${behind} at or below the watermark, ` +
        `which the hash guard will skip if applied and apply if not)`,
    );
  }
  for (const [entry, when] of queue) {
    try {
      await applyOne(entry, when);
    } catch (err) {
      console.error(`\n  ! ${entry.tag} FAILED — rolled back`);
      console.error(`    ${err.message}`);
      if (err.position) console.error(`    at position ${err.position}`);
      if (err.detail) console.error(`    detail: ${err.detail}`);
      if (err.hint) console.error(`    hint: ${err.hint}`);
      process.exitCode = 1;
      break;
    }
  }
} finally {
  await sql.end();
}
