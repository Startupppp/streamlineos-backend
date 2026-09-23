#!/usr/bin/env node
/**
 * check-replay-ledger.mjs
 *
 * Compare the drizzle.__replay table (written by replay-chain-cold.mjs) against the
 * migration journal to verify ledger state after a cold bootstrap.
 *
 * Note: drizzle.__drizzle_migrations is written by `db:migrate` only, not by
 * replay-chain-cold.mjs.  Use this script for cold-replay databases.
 *
 * ---------------------------------------------------------------------------
 * 2026-09-04 (v2 ticket 30). This gate shipped a FAKE self-test: package.json
 * wired `check:replay-ledger:self-test` to `--self-test`, and the file had never
 * heard of the flag. With COLD_DATABASE_URL unset the "self-test" exited 2
 * because the URL was missing; with it set it silently ran the LIVE gate a
 * second time. Either way it asserted nothing about the detector, which is the
 * whole point of a self-test. Three more defects went with it:
 *
 *   1. Both sides were collapsed into a Set before comparison, so a journal
 *      carrying the SAME TAG TWICE was indistinguishable from one carrying it
 *      once. A duplicate tag is exactly the shape a bad merge produces.
 *   2. A ZERO-ENTRY journal reported "LEDGER STATE: CLEAN" and exited 0 — 0 of 0
 *      entries applied, 0 orphans. A ledger over nothing is not a clean ledger,
 *      it is a missing journal.
 *   3. `SELECT tag FROM drizzle.__replay ... .catch(() => [])` swallowed an
 *      absent table into "every entry not applied", reporting a real defect (1)
 *      for what is a missing prerequisite (2).
 *
 * The comparison is a pure function now, so the self-test plants each class in a
 * fixture and asserts the specific verdict rather than a non-zero exit.
 *
 * Usage:
 *   COLD_DATABASE_URL=postgresql://… node src/scripts/check-replay-ledger.mjs
 *   node src/scripts/check-replay-ledger.mjs --self-test
 *
 * Exit codes:
 *   0 ledger clean · 1 ledger has issues · 2 INCONCLUSIVE (prerequisite absent)
 */
import fs from "node:fs";
import process from "node:process";

const SELF_TEST = process.argv.includes("--self-test");

/** The journal, resolved from THIS FILE rather than from the caller's cwd. */
const JOURNAL_URL = new URL("../../migrations/meta/_journal.json", import.meta.url);

/**
 * Compare a journal's entries against the tags found in drizzle.__replay.
 *
 * `journalEntries` is the raw array, NOT a set: collapsing it first is how a
 * duplicated tag became invisible.
 */
export function classifyLedger(journalEntries, replayTags) {
  const tags = journalEntries.map((e) => e.tag);
  const seen = new Set();
  const duplicates = new Set();
  for (const tag of tags) {
    if (seen.has(tag)) duplicates.add(tag);
    seen.add(tag);
  }
  const replay = new Set(replayTags);
  const applied = [...seen].filter((t) => replay.has(t)).sort();
  const notApplied = [...seen].filter((t) => !replay.has(t)).sort();
  const orphans = [...replay].filter((t) => !seen.has(t)).sort();
  const duplicateTags = [...duplicates].sort();

  // A journal with no entries is not a clean ledger. Every count below is zero
  // and every comparison vacuously holds, which is precisely the shape this
  // release keeps finding: a green tick over an empty corpus.
  if (journalEntries.length === 0)
    return {
      journalCount: 0,
      uniqueCount: 0,
      applied,
      notApplied,
      orphans,
      duplicateTags,
      verdict: "INCONCLUSIVE",
      why: "the journal declares zero entries, so 'every entry applied' compares nothing",
      exitCode: 2,
    };

  const hasIssues = notApplied.length > 0 || orphans.length > 0 || duplicateTags.length > 0;
  return {
    journalCount: journalEntries.length,
    uniqueCount: seen.size,
    applied,
    notApplied,
    orphans,
    duplicateTags,
    verdict: hasIssues ? "HAS ISSUES" : "CLEAN",
    why: null,
    exitCode: hasIssues ? 1 : 0,
  };
}

function runSelfTest() {
  let passed = 0;
  const failures = [];
  const assert = (label, condition) => {
    if (condition) passed++;
    else failures.push(label);
  };

  const entries = (...tags) => tags.map((tag) => ({ idx: 0, when: 0, tag, breakpoints: true }));

  // --- control: a ledger that really is clean ---
  const clean = classifyLedger(entries("0000_a", "0001_b", "0002_c"), ["0000_a", "0001_b", "0002_c"]);
  assert("a fully applied journal is CLEAN", clean.verdict === "CLEAN");
  assert("a clean ledger exits 0", clean.exitCode === 0);
  assert("a clean ledger counts every entry as applied", clean.applied.length === 3);
  assert("a clean ledger reports nothing not-applied", clean.notApplied.length === 0);
  assert("a clean ledger reports no orphan", clean.orphans.length === 0);

  // --- planted class 1: a journal entry with no __replay row ---
  const missing = classifyLedger(entries("0000_a", "0001_b"), ["0000_a"]);
  assert("a journal entry with no __replay row is detected", missing.notApplied.includes("0001_b"));
  assert("it is reported as HAS ISSUES", missing.verdict === "HAS ISSUES");
  assert("it exits 1, a real finding, not 2", missing.exitCode === 1);
  assert("and it is NOT miscounted as an orphan", missing.orphans.length === 0);

  // --- planted class 2: a __replay row with no journal entry ---
  const orphan = classifyLedger(entries("0000_a"), ["0000_a", "9999_ghost"]);
  assert("a __replay row with no journal entry is detected", orphan.orphans.includes("9999_ghost"));
  assert("an orphan row exits 1", orphan.exitCode === 1);
  assert("and it is NOT miscounted as not-applied", orphan.notApplied.length === 0);

  // --- planted class 3: a duplicate tag in the journal ---
  // Both sides used to be collapsed into a Set before comparison, so this was
  // indistinguishable from a journal carrying the tag once.
  const dup = classifyLedger(entries("0000_a", "0001_b", "0001_b"), ["0000_a", "0001_b"]);
  assert("a duplicated journal tag is detected", dup.duplicateTags.includes("0001_b"));
  assert("a duplicated tag exits 1", dup.exitCode === 1);
  assert(
    "the duplicate is not laundered by the applied count — 3 entries, 2 unique",
    dup.journalCount === 3 && dup.uniqueCount === 2,
  );
  assert(
    "a duplicate alone is enough: nothing is missing and nothing is orphaned",
    dup.notApplied.length === 0 && dup.orphans.length === 0,
  );

  // --- planted class 4: a zero-entry journal is INCONCLUSIVE, never a pass ---
  const empty = classifyLedger([], []);
  assert("a zero-entry journal is INCONCLUSIVE", empty.verdict === "INCONCLUSIVE");
  assert("a zero-entry journal exits 2, never 0", empty.exitCode === 2);
  assert("and it says why", (empty.why ?? "").includes("zero entries"));
  assert(
    "an empty journal with orphan replay rows is still INCONCLUSIVE, not merely 'has issues'",
    classifyLedger([], ["0000_a"]).exitCode === 2,
  );

  // --- the real journal, so a moved or emptied journal fails here too ---
  let realEntries;
  try {
    realEntries = JSON.parse(fs.readFileSync(JOURNAL_URL, "utf8")).entries;
  } catch {
    realEntries = null;
  }
  assert("the repository's own journal is readable from this script's own location", Array.isArray(realEntries));
  assert(
    "the repository's own journal is not empty, so the live run cannot be vacuous",
    Array.isArray(realEntries) && realEntries.length > 0,
  );
  assert(
    "the repository's own journal carries no duplicate tag",
    Array.isArray(realEntries) && classifyLedger(realEntries, realEntries.map((e) => e.tag)).duplicateTags.length === 0,
  );

  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`  FAIL: ${f}\n`);
    process.stderr.write(`check-replay-ledger self-tests: ${failures.length} failed, ${passed} passed\n`);
    process.exit(1);
  }
  process.stdout.write(`check-replay-ledger self-tests: ${passed} passed\n`);
  process.exit(0);
}

if (SELF_TEST) runSelfTest();

const url = process.env.COLD_DATABASE_URL;
if (!url) {
  process.stderr.write("INCONCLUSIVE — COLD_DATABASE_URL is required; no ledger was compared.\n");
  process.exit(2);
}

const journal = JSON.parse(fs.readFileSync(JOURNAL_URL, "utf8"));
const { createScriptSql } = await import("./lib/script-sql-client.mjs");

const sql = await createScriptSql({ url, connection: { prepare: false, max: 1, onnotice: () => {}, connect_timeout: 60 } });
try {
  let replayRows;
  try {
    replayRows = await sql`SELECT tag FROM drizzle.__replay ORDER BY tag`;
  } catch (err) {
    // An absent drizzle.__replay is a MISSING PREREQUISITE, not a ledger with
    // every entry unapplied. Reporting it as exit 1 made a cold database that
    // had never been replayed look like a broken one.
    process.stderr.write(
      `INCONCLUSIVE — drizzle.__replay could not be read, so no comparison was made: ${String(err)}\n`,
    );
    process.exit(2);
  }

  const result = classifyLedger(
    journal.entries,
    replayRows.map((r) => r.tag),
  );

  process.stdout.write(`Journal entries: ${result.journalCount}\n`);
  process.stdout.write(`Unique journal tags: ${result.uniqueCount}\n`);
  process.stdout.write(`Applied (in __replay): ${result.applied.length}\n`);
  process.stdout.write(`Not applied (failed or skipped): ${result.notApplied.length}\n`);
  process.stdout.write(`Orphan rows (in __replay but not in journal): ${result.orphans.length}\n`);
  process.stdout.write(`Duplicate journal tags: ${result.duplicateTags.length}\n`);

  const [t] = await sql`SELECT count(*)::int n FROM pg_tables WHERE schemaname = 'public'`;
  process.stdout.write(`Public tables: ${t.n}\n`);

  if (result.notApplied.length > 0) {
    process.stdout.write(`Not-applied tags:\n`);
    for (const tag of result.notApplied) process.stdout.write(`  ${tag}\n`);
  }
  if (result.orphans.length > 0) {
    process.stdout.write(`Orphan tags:\n`);
    for (const tag of result.orphans) process.stdout.write(`  ${tag}\n`);
  }
  if (result.duplicateTags.length > 0) {
    process.stdout.write(`Duplicate tags (the journal names each of these more than once):\n`);
    for (const tag of result.duplicateTags) process.stdout.write(`  ${tag}\n`);
  }

  process.stdout.write(`LEDGER STATE: ${result.verdict}\n`);
  if (result.why !== null) process.stderr.write(`  ${result.why}\n`);
  process.exitCode = result.exitCode;
} finally {
  await sql.end();
}
