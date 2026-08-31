#!/usr/bin/env node
/**
 * Gate: drizzle.__drizzle_migrations must agree with migrations/meta/_journal.json.
 *
 * Drizzle decides what to apply by TIMESTAMP, not by hash: it takes
 * max(created_at) as the watermark and runs every journal entry whose `when`
 * exceeds it. Three ledger states break that silently, all while the run
 * prints success:
 *
 *   ORPHAN    a row whose created_at matches no journal entry — the migration
 *             was applied and its journal entry later removed. Harmless until
 *             one of them holds the watermark, at which point it pins the
 *             watermark to a migration nobody can find.
 *   DUPLICATE two rows for the same journal entry — the same migration
 *             recorded twice, so the ledger no longer counts what ran.
 *   SKIPPED   a journal entry at or below the watermark with no row. It will
 *             never apply on this database, and nothing will ever say so.
 *
 * Hash is deliberately NOT the join key. Editing an applied migration changes
 * its hash while the row stays valid, so a hash-keyed check reports live rows
 * as orphans and would delete the only thing preventing re-application.
 *
 * Usage:  node src/scripts/check-migration-ledger.mjs
 * Exit:   0 clean · 1 violation, missing DATABASE_URL, or self-test failure
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const JOURNAL = join(SCRIPT_DIR, "../../migrations/meta/_journal.json");

function classify(entries, rows) {
  const whens = new Set(entries.map((e) => String(e.when)));
  const orphans = rows.filter((r) => !whens.has(String(r.created_at)));

  const seen = new Set();
  const duplicates = [];
  for (const row of rows) {
    const key = String(row.created_at);
    if (!whens.has(key)) continue;
    if (seen.has(key)) duplicates.push(row);
    else seen.add(key);
  }

  const watermark = rows.length ? Math.max(...rows.map((r) => Number(r.created_at))) : 0;
  const applied = new Set(rows.map((r) => String(r.created_at)));
  const skipped = entries.filter((e) => e.when <= watermark && !applied.has(String(e.when)));
  const pending = entries.filter((e) => e.when > watermark);

  return { orphans, duplicates, skipped, pending, watermark };
}

function runSelfTests() {
  const entries = [
    { tag: "0001_a", when: 100 },
    { tag: "0002_b", when: 200 },
    { tag: "0003_c", when: 300 },
  ];

  const clean = classify(entries, [
    { id: 1, created_at: 100 },
    { id: 2, created_at: 200 },
  ]);
  if (clean.orphans.length || clean.duplicates.length || clean.skipped.length) {
    process.stderr.write("SELF-TEST FAIL: a clean ledger was flagged\n");
    process.exit(1);
  }
  if (clean.pending.length !== 1) {
    process.stderr.write("SELF-TEST FAIL: did not count the one pending entry\n");
    process.exit(1);
  }

  const withOrphan = classify(entries, [
    { id: 1, created_at: 100 },
    { id: 2, created_at: 150 },
  ]);
  if (withOrphan.orphans.length !== 1) {
    process.stderr.write("SELF-TEST FAIL: known orphan row was not flagged\n");
    process.exit(1);
  }

  const withDuplicate = classify(entries, [
    { id: 1, created_at: 100 },
    { id: 2, created_at: 100 },
  ]);
  if (withDuplicate.duplicates.length !== 1) {
    process.stderr.write("SELF-TEST FAIL: known duplicate row was not flagged\n");
    process.exit(1);
  }

  const withSkip = classify(entries, [
    { id: 1, created_at: 100 },
    { id: 2, created_at: 300 },
  ]);
  if (withSkip.skipped.length !== 1 || withSkip.skipped[0].tag !== "0002_b") {
    process.stderr.write("SELF-TEST FAIL: known skipped entry was not flagged\n");
    process.exit(1);
  }

  const hashDrift = classify(entries, [
    { id: 1, created_at: 100, hash: "edited-after-apply" },
    { id: 2, created_at: 200, hash: "edited-after-apply" },
  ]);
  if (hashDrift.orphans.length > 0) {
    process.stderr.write("SELF-TEST FAIL: hash drift on an applied row was misread as an orphan\n");
    process.exit(1);
  }

  process.stdout.write("Self-tests passed.\n");
}

runSelfTests();

if (process.argv.includes("--self-test")) process.exit(0);

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write("DATABASE_URL is not set — the ledger cannot be read. Failing closed.\n");
  process.exit(1);
}

const { default: postgres } = await import("postgres");
const sql = postgres(url, { prepare: false, max: 1 });

try {
  const journal = JSON.parse(readFileSync(JOURNAL, "utf8"));
  const rows = await sql`select id, created_at from drizzle.__drizzle_migrations`;
  const { orphans, duplicates, skipped, pending, watermark } = classify(journal.entries, rows);

  process.stdout.write(
    `Ledger: ${rows.length} applied row(s) against ${journal.entries.length} journal entr(ies).\n` +
    `Watermark ${watermark}; ${pending.length} migration(s) pending.\n`,
  );

  const failures = [];
  if (orphans.length) failures.push(`${orphans.length} orphan row(s): ${orphans.map((o) => o.id).join(", ")}`);
  if (duplicates.length) failures.push(`${duplicates.length} duplicate row(s): ${duplicates.map((d) => d.id).join(", ")}`);
  if (skipped.length) failures.push(`${skipped.length} entr(ies) below the watermark that will NEVER apply: ${skipped.map((s) => s.tag).join(", ")}`);

  if (failures.length) {
    process.stderr.write("\ncheck:migration-ledger FAILED\n");
    for (const line of failures) process.stderr.write(`  ${line}\n`);
    process.exit(1);
  }

  process.stdout.write("No orphan, duplicate or unreachable entries. Gate passed.\n");
} finally {
  await sql.end();
}
