/**
 * verify-migration-chain.mjs
 *
 * Single-pass CI guard for the migration chain. Exits non-zero if any of:
 *   a) An .sql file under migrations/ is absent from the journal and not on the allowlist.
 *   b) Two or more .sql files share the same numeric prefix (first segment before '_').
 *   c) A journal entry's `when` timestamp is not strictly greater than the one before it,
 *      unless that exact adjacent pair is listed in HISTORICAL_TIMESTAMP_REGRESSIONS.
 *   d) A journal entry names a file that does not exist on disk.
 *   e) The last reported chain_gaps count (read from the chain-gaps marker file) is > 0.
 *   f) The applied watermark in drizzle.__drizzle_migrations is ahead of every journal
 *      entry, which silently disables the migrator for everyone. Checked only when a
 *      database is reachable.
 *
 * Self-test mode (--self-test) creates a temp fixture tree, exercises every failure mode
 * against the real check function, asserts each one is caught AND that the clean case is
 * not reported, then removes the fixture. A guard that has never failed is not a guard.
 *
 * Usage:
 *   node src/scripts/verify-migration-chain.mjs [--migrations=migrations] [--self-test]
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sslForConnectionString } from "./lib/repo-roots.mjs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const argv = process.argv.slice(2);
const SELF_TEST = argv.includes("--self-test");
const MIGRATIONS_DIR = resolve(
  process.cwd(),
  (argv.find((a) => a.startsWith("--migrations=")) ?? "--migrations=migrations").slice(
    "--migrations=".length,
  ),
);

/**
 * These files INTENTIONALLY have no journal entry.
 * Must stay unjournalled; add them here, never journal them.
 */
const DELIBERATE_ALLOWLIST = new Set([
  "0478_invoice_line_items_column_drop",
  "0482_candidate_resume_column_drop",
  "0488_hr_people_drop_identity_cols",
  "0472_outbox_inbox_aggregate_fence",
]);

/**
 * Duplicate numeric prefixes that already exist in applied history.
 *
 * The rule is unchanged and the set is still CLOSED: a NEW collision must fail,
 * and the fix for one is to rename the new file, never to add a line here. What
 * changed is the reason, because the reason recorded here until 2026-09-10 was
 * false and pointed at the wrong fix.
 *
 * It said renaming an applied migration changes its hash and would re-propose it
 * against every database. It does not. All four appliers in this repository —
 * run-pending-migrations.mjs:45, apply-journalled-migration.mjs:44,
 * apply-chain-cold.mjs:46 and db-bootstrap.mjs:22 — hash the FILE CONTENT and
 * nothing else. The tag never enters the hash, and `drizzle.__drizzle_migrations`
 * stores only (hash, created_at), so a renamed migration on a database that
 * already has it matches by hash and is skipped. Renaming is hash-safe. (Editing
 * a migration's BODY is not — including its comments — which is the neighbouring
 * fact this one was probably confused with.)
 *
 * The true reason to baseline an old collision and rename a new one is reference,
 * not hashing. A tag that has been applied somewhere is quoted in runbooks, in
 * `db:apply-one --tag=`, in rollback manifests and in cross-session notes;
 * renaming it silently invalidates all of them, and the numeric prefix decides
 * nothing at runtime anyway — the journal array is the authoritative order. A
 * collision caught before it is applied has none of those references yet, so
 * renaming costs nothing. That asymmetry is the policy.
 *
 * Recorded 2026-08-29, rationale corrected 2026-09-10.
 */
const HISTORICAL_DUPLICATE_PREFIXES = new Set([
  "0300",
  "0370",
  "0371",
  "0372",
  "0374",
  "0375",
  "0379",
  "0420",
  "0426",
  "0430",
  "0431",
  "0432",
  "0700",
  "0701",
]);

/**
 * Adjacent journal pairs whose `when` regresses and that are already applied.
 *
 * Keyed on the exact pair "prev -> cur", not on the entry alone, so an entry that
 * gains a different predecessor is checked again. The set is CLOSED like the one
 * above: a new regression on an unapplied entry is fixed by restamping it into the
 * gap between its neighbours, never by adding a line here.
 *
 * Every pair below comes from the 2026-09-11 merge of integration/crm-ts into the
 * inventory branch. Array order is the cold-build order (each crm/ts entry follows
 * its own-lane predecessor, and the 0591b/0649b/0676b/0677b/0678b chain repairs carry
 * a deliberately far-future `when`), while `when` comes from each lane's own clock.
 * In every pair the later entry is applied (hash or `when` present on Neon or the
 * local inventory/CRM ledgers), and check:migration-ledger joins on `when`, so
 * restamping it would orphan ledger rows. The one pair with an unapplied side
 * (0674a -> 0659b) has no gap to move into. check:migration-discipline carries
 * the same 16 as `journal-order:` baseline entries, each with where it is applied.
 */
const HISTORICAL_TIMESTAMP_REGRESSIONS = new Set([
  "0465_accounting_documents -> 0232_repair_crm_activity_grants",
  "0470_ar_document_pdf_cache -> 0471_platform_waitlist",
  "0472a_activities_deal_fk -> 0270_activities_thread_window",
  "0473a_accounting_attachments_permissions -> 0261_crm_connectors",
  "0271a_waitlist_admission -> 0269_mailbox_push_secret",
  "0520a_relationship_state -> 0278_drop_legacy_identity_tables",
  "0557_relationship_states_deal_fk -> 0472_outbox_inbox_aggregate_fence",
  "0559_data_quality_autonomous_decision -> 0478_invoice_line_items_column_drop",
  "0591b_gl_ap_ar_bank_tax_chain_repair -> 0527_po_batching_policy",
  "0649b_inv_carton_shipment_chain_repair -> 0589_inventory_drop_reason_codes",
  "0676b_inv_compliance_documents_chain_repair -> 0610_agent_tokens_membership_and_ceiling",
  "0677b_feedback_cycle_responses_policy_repair -> 0611_delegations_and_overrides_expand_membership",
  "0678b_feedback_cycle_responses_rls_complete -> 0613_delegations_and_overrides_drop_user_columns",
  "0674a_subprocessor_subscribers_tenant_index -> 0659b_timesheets_lifecycle_seq_and_attendance_draft",
  "0659b_timesheets_lifecycle_seq_and_attendance_draft -> 0656_communication_tenant_rls",
  "0915_inventory_client_keys_follow_the_party_map -> 0466_drop_legacy_accounting",
]);

const CHAIN_GAPS_FILE = resolve(process.cwd(), ".chain-gaps");

function numericPrefix(tag) {
  return tag.split("_")[0] ?? tag;
}

/**
 * Returns the highest created_at in drizzle.__drizzle_migrations, or null when no
 * database is reachable — CI runs this guard without one, and an absent database
 * must skip check (f) rather than fail it.
 */
async function readAppliedWatermark() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  try {
    const { default: postgres } = await import("postgres");
    const sql = postgres(url, { prepare: false, max: 1, ssl: sslForConnectionString(url), onnotice: () => {} });
    try {
      const rows = await sql`SELECT max(created_at) AS mx FROM drizzle.__drizzle_migrations`;
      const mx = rows[0]?.mx;
      return mx === null || mx === undefined ? null : Number(mx);
    } finally {
      await sql.end();
    }
  } catch {
    return null;
  }
}

function readJournal(dir) {
  return JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8"));
}

function collectSqlFiles(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.replace(/\.sql$/, ""))
    .sort();
}

function isPendingPath(tag, dir) {
  return tag.includes("/") || existsSync(join(dir, "pending", tag + ".sql"));
}

function runChecks(
  dir,
  gapsFile = CHAIN_GAPS_FILE,
  appliedWatermark = null,
  timestampBaseline = HISTORICAL_TIMESTAMP_REGRESSIONS,
) {
  const journal = readJournal(dir);
  const entries = journal.entries ?? [];
  const journalled = new Set(entries.map((e) => e.tag));

  const sqlFiles = collectSqlFiles(dir);
  const failures = [];

  // (a) Unjournalled files not on allowlist
  for (const tag of sqlFiles) {
    if (!journalled.has(tag) && !DELIBERATE_ALLOWLIST.has(tag)) {
      failures.push(`(a) UNJOURNALLED  ${tag}`);
    }
  }

  // (b) Duplicate numeric prefixes
  const prefixToTags = {};
  for (const tag of sqlFiles) {
    const p = numericPrefix(tag);
    (prefixToTags[p] ??= []).push(tag);
  }
  for (const [prefix, tags] of Object.entries(prefixToTags)) {
    if (tags.length > 1 && !HISTORICAL_DUPLICATE_PREFIXES.has(prefix)) {
      failures.push(`(b) DUPLICATE PREFIX  ${prefix}: ${tags.join(", ")}`);
    }
  }

  // (c) Timestamp regressions — when must be strictly increasing
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1];
    const cur = entries[i];
    if (cur.when <= prev.when && !timestampBaseline.has(`${prev.tag} -> ${cur.tag}`)) {
      failures.push(
        `(c) TIMESTAMP REGRESSION  ${cur.tag} (when=${cur.when}) <= ${prev.tag} (when=${prev.when})`,
      );
    }
  }

  // (d) Journal entry with no file on disk
  const diskSet = new Set(sqlFiles);
  for (const entry of entries) {
    if (!diskSet.has(entry.tag) && !isPendingPath(entry.tag, dir)) {
      failures.push(`(d) ORPHAN ENTRY  ${entry.tag} — in journal but no .sql file on disk`);
    }
  }

  // (f) The applied watermark is ahead of the journal.
  //
  // Stock drizzle-kit decides what to run by comparing each entry's `when` against
  // the highest created_at already in drizzle.__drizzle_migrations. A row recorded
  // with a timestamp above every journal entry therefore disables that migrator for
  // everyone: it reports success while applying nothing, and the tables those
  // migrations were meant to create or protect never appear.
  //
  // `db:migrate` no longer runs stock drizzle-kit — it runs
  // run-pending-migrations.mjs, which queues every entry and lets the file-hash
  // guard decide, so it SEES work below the watermark. This check still matters for
  // two reasons: the condition means the database and the journal were built by
  // different lineages and neither describes the other, and anything still invoking
  // `drizzle-kit migrate` directly (a CI step, a runbook, a habit) is silently
  // applying nothing. Measured on the shared Neon branch 2026-09-10: 140 of 434
  // journalled migrations unapplied, and the watermark dated 2027-02-19 — a FUTURE
  // timestamp, which is how it got above every entry in the first place.
  //
  // Checked only when a database is reachable, because CI has none.
  if (appliedWatermark !== null && entries.length > 0) {
    const journalMax = Math.max(...entries.map((e) => e.when));
    if (appliedWatermark > journalMax) {
      failures.push(
        `(f) WATERMARK AHEAD OF JOURNAL  applied max created_at=${appliedWatermark} ` +
          `(${new Date(appliedWatermark).toISOString()}) exceeds the newest journal entry ` +
          `when=${journalMax} (${new Date(journalMax).toISOString()}) — every entry below it is ` +
          `silently skipped by stock drizzle-kit, which still reports success. db:migrate now uses run-pending-migrations.mjs and is unaffected; run it with --dry-run to see what this database is actually missing.`,
      );
    }
  }

  // (e) chain_gaps > 0  (read from the marker file written by a recent bootstrap run)
  if (existsSync(gapsFile)) {
    const raw = readFileSync(gapsFile, "utf8").trim();
    const gaps = Number(raw);
    if (!Number.isFinite(gaps) || gaps > 0) {
      failures.push(`(e) CHAIN GAPS  ${raw} gap(s) — cold rebuild references objects the chain never creates`);
    }
  }

  return failures;
}

function selfTest() {
  const tmp = join(tmpdir(), `migrate-chain-selftest-${process.pid}`);
  mkdirSync(join(tmp, "meta"), { recursive: true });

  let passed = 0;
  let failed = 0;

  function assert(label, failures, expectedFailureLike) {
    const hit = failures.some((f) => f.includes(expectedFailureLike));
    if (hit) {
      console.log(`  PASS  ${label}`);
      passed++;
    } else {
      console.error(`  FAIL  ${label} — expected failure containing "${expectedFailureLike}"`);
      console.error(`         got: ${JSON.stringify(failures)}`);
      failed++;
    }
  }

  function writeJournal(entries) {
    writeFileSync(join(tmp, "meta", "_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries }));
  }

  function writeSql(name, content = "SELECT 1;") {
    writeFileSync(join(tmp, name + ".sql"), content);
  }

  function check(dir, gapsFile, appliedWatermark) {
    return runChecks(dir, gapsFile, appliedWatermark);
  }

  console.log("Self-test: (a) unjournalled file");
  {
    writeJournal([{ idx: 0, version: "7", when: 1000, tag: "0001_alpha", breakpoints: false }]);
    writeSql("0001_alpha");
    writeSql("0002_beta"); // unjournalled and NOT on allowlist
    const failures = check(tmp);
    assert("unjournalled non-allowlisted file caught", failures, "(a)");
    rmSync(join(tmp, "0002_beta.sql"));
  }

  console.log("Self-test: (b) duplicate numeric prefix");
  {
    writeJournal([
      { idx: 0, version: "7", when: 1000, tag: "0001_alpha", breakpoints: false },
      { idx: 1, version: "7", when: 2000, tag: "0001_beta", breakpoints: false },
    ]);
    writeSql("0001_alpha");
    writeSql("0001_beta");
    const failures = check(tmp);
    assert("duplicate prefix caught", failures, "(b)");
    rmSync(join(tmp, "0001_beta.sql"));
    writeJournal([{ idx: 0, version: "7", when: 1000, tag: "0001_alpha", breakpoints: false }]);
  }

  console.log("Self-test: (c) timestamp regression");
  {
    writeJournal([
      { idx: 0, version: "7", when: 2000, tag: "0001_alpha", breakpoints: false },
      { idx: 1, version: "7", when: 1000, tag: "0002_gamma", breakpoints: false }, // goes backwards
    ]);
    writeSql("0002_gamma");
    const failures = check(tmp);
    assert("timestamp regression caught", failures, "(c)");
    rmSync(join(tmp, "0002_gamma.sql"));
    writeJournal([{ idx: 0, version: "7", when: 1000, tag: "0001_alpha", breakpoints: false }]);
  }

  console.log("Self-test: (c) a baselined pair is exempt, and only that pair");
  {
    writeJournal([
      { idx: 0, version: "7", when: 2000, tag: "0001_alpha", breakpoints: false },
      { idx: 1, version: "7", when: 1000, tag: "0002_gamma", breakpoints: false },
    ]);
    writeSql("0002_gamma");
    const exempt = runChecks(tmp, undefined, null, new Set(["0001_alpha -> 0002_gamma"]));
    if (exempt.some((f) => f.includes("(c)"))) {
      console.error("  FAIL  a regression listed as its exact pair must not be reported");
      failed++;
    } else {
      console.log("  PASS  a regression listed as its exact pair is not reported");
      passed++;
    }
    const otherPair = runChecks(tmp, undefined, null, new Set(["0009_other -> 0002_gamma"]));
    assert("the same entry after a different predecessor is still caught", otherPair, "(c)");
    rmSync(join(tmp, "0002_gamma.sql"));
    writeJournal([{ idx: 0, version: "7", when: 1000, tag: "0001_alpha", breakpoints: false }]);
  }

  console.log("Self-test: (d) orphan journal entry");
  {
    writeJournal([
      { idx: 0, version: "7", when: 1000, tag: "0001_alpha", breakpoints: false },
      { idx: 1, version: "7", when: 2000, tag: "0003_missing", breakpoints: false }, // no file
    ]);
    const failures = check(tmp);
    assert("orphan entry caught", failures, "(d)");
    writeJournal([{ idx: 0, version: "7", when: 1000, tag: "0001_alpha", breakpoints: false }]);
  }

  console.log("Self-test: (f) applied watermark ahead of the journal");
  {
    writeJournal([{ idx: 0, version: "7", when: 1000, tag: "0001_alpha", breakpoints: false }]);
    writeSql("0001_alpha");
    assert("watermark ahead of journal caught", check(tmp, undefined, 9999), "(f)");
    const level = check(tmp, undefined, 1000);
    if (level.some((x) => x.includes("(f)"))) {
      console.error("  FAIL  a watermark equal to the newest entry must not be reported");
      failed++;
    } else {
      console.log("  PASS  a watermark equal to the newest entry is not reported");
      passed++;
    }
    const none = check(tmp, undefined, null);
    if (none.some((x) => x.includes("(f)"))) {
      console.error("  FAIL  check (f) must be skipped when no database is reachable");
      failed++;
    } else {
      console.log("  PASS  check (f) is skipped when no database is reachable");
      passed++;
    }
  }

  console.log("Self-test: (e) chain gaps marker");
  {
    const gapsFile = join(tmp, ".chain-gaps-selftest");

    writeFileSync(gapsFile, "42");
    assert("chain gaps caught", check(tmp, gapsFile), "(e)");

    writeFileSync(gapsFile, "not-a-number");
    assert("unparseable gap count caught", check(tmp, gapsFile), "(e)");

    writeFileSync(gapsFile, "0");
    const clean = check(tmp, gapsFile);
    if (clean.some((f) => f.includes("(e)"))) {
      console.error("  FAIL  zero gaps must not be reported as a failure");
      failed++;
    } else {
      console.log("  PASS  zero gaps is not reported as a failure");
      passed++;
    }

    rmSync(gapsFile);
  }

  rmSync(tmp, { recursive: true });

  console.log(`\nSelf-test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

async function main() {
  if (SELF_TEST) {
    selfTest();
    return;
  }

  if (!existsSync(MIGRATIONS_DIR)) {
    console.error(`Migrations directory not found: ${MIGRATIONS_DIR}`);
    process.exitCode = 1;
    return;
  }

  const failures = runChecks(MIGRATIONS_DIR, CHAIN_GAPS_FILE, await readAppliedWatermark());

  if (failures.length === 0) {
    console.log("PASS  migration chain verified — no issues found");
    return;
  }

  console.error(`FAIL  migration chain has ${failures.length} issue(s):\n`);
  for (const f of failures) console.error(`  ${f}`);
  process.exitCode = 1;
}

main().catch((e) => {
  console.error("VERIFY FAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
