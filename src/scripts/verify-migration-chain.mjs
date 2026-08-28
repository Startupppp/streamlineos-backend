/**
 * verify-migration-chain.mjs
 *
 * Single-pass CI guard for the migration chain. Exits non-zero if any of:
 *   a) An .sql file under migrations/ is absent from the journal and not on the allowlist.
 *   b) Two or more .sql files share the same numeric prefix (first segment before '_').
 *   c) A journal entry's `when` timestamp is not strictly greater than the one before it.
 *   d) A journal entry names a file that does not exist on disk.
 *   e) The last reported chain_gaps count (read from the chain-gaps marker file) is > 0.
 *
 * Self-test mode (--self-test) creates a temp fixture tree, exercises all five failure
 * modes against it, asserts each one is caught, then removes the fixture. A guard that
 * has never failed is not a guard.
 *
 * Usage:
 *   node src/scripts/verify-migration-chain.mjs [--migrations=migrations] [--self-test]
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
 * Duplicate numeric prefixes that already exist in applied history. Renaming an
 * applied migration changes its hash and would re-propose it against every
 * database, so these are baselined rather than fixed. Recorded 2026-08-29 — the
 * set is closed, so a NEW collision still fails. Do not extend it to silence a
 * fresh duplicate; rename the new file instead.
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
]);

const CHAIN_GAPS_FILE = resolve(process.cwd(), ".chain-gaps");

function numericPrefix(tag) {
  return tag.split("_")[0] ?? tag;
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

function runChecks(dir, gapsFile = CHAIN_GAPS_FILE) {
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
    if (cur.when <= prev.when) {
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

  function check(dir, gapsFile) {
    return runChecks(dir, gapsFile);
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

  const failures = runChecks(MIGRATIONS_DIR);

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
