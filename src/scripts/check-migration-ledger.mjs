#!/usr/bin/env node
/**
 * Gate: drizzle.__drizzle_migrations must agree with migrations/meta/_journal.json.
 *
 * Drizzle decides what to apply by TIMESTAMP, not by hash: it takes
 * max(created_at) as the watermark and runs every journal entry whose `when`
 * exceeds it. Three ledger states break that silently, all while the run
 * prints success:
 *
 *   ORPHAN    a row the journal cannot account for: its created_at matches no
 *             journal entry, or it is a surplus row on a created_at some other
 *             row already occupies. Harmless until one of them holds the
 *             watermark, at which point it pins the watermark to a migration
 *             nobody can find.
 *   DUPLICATE two rows carrying the same file hash — that one migration really
 *             ran twice, wherever the two rows sit in time.
 *   SKIPPED   a journal entry at or below the watermark with no row. It will
 *             never apply on this database, and nothing will ever say so.
 *
 * Hash is deliberately NOT the join key against the journal. Editing an applied
 * migration changes its hash while the row stays valid, so a hash-keyed join
 * reports live rows as orphans and would delete the only thing preventing
 * re-application. Hash is used only as row identity — to tell "this file ran
 * twice" from "two unrelated rows landed on one created_at", which a
 * created_at-keyed duplicate check conflates.
 *
 * Usage:  node src/scripts/check-migration-ledger.mjs
 * Exit:   0 clean · 1 violation, missing DATABASE_URL, or self-test failure
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const JOURNAL = join(SCRIPT_DIR, "../../migrations/meta/_journal.json");

function rowIdentity(row) {
  return row.hash === undefined || row.hash === null ? `when:${row.created_at}` : `hash:${row.hash}`;
}

function classify(entries, rows) {
  const whens = new Set(entries.map((e) => String(e.when)));

  const seenIdentity = new Set();
  const duplicates = [];
  for (const row of rows) {
    const identity = rowIdentity(row);
    if (seenIdentity.has(identity)) duplicates.push(row);
    else seenIdentity.add(identity);
  }
  const duplicateIds = new Set(duplicates.map((d) => d.id));

  const unjournalled = rows.filter((r) => !whens.has(String(r.created_at)));

  const occupied = new Set();
  const surplus = [];
  for (const row of rows) {
    const key = String(row.created_at);
    if (!whens.has(key) || duplicateIds.has(row.id)) continue;
    if (occupied.has(key)) surplus.push(row);
    else occupied.add(key);
  }

  const orphans = [...unjournalled, ...surplus];

  const watermark = rows.length ? Math.max(...rows.map((r) => Number(r.created_at))) : 0;
  const applied = new Set(rows.map((r) => String(r.created_at)));
  const skipped = entries.filter((e) => e.when <= watermark && !applied.has(String(e.when)));
  const pending = entries.filter((e) => e.when > watermark);

  const orphansPinningWatermark = orphans.filter((o) => Number(o.created_at) >= watermark);
  const orphansBelowWatermark = orphans.filter((o) => Number(o.created_at) < watermark);

  return { orphans, orphansPinningWatermark, orphansBelowWatermark, duplicates, skipped, pending, watermark };
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

  const orphanBelow = classify(entries, [
    { id: 1, created_at: 100 },
    { id: 2, created_at: 150 },
    { id: 3, created_at: 300 },
  ]);
  if (orphanBelow.orphansBelowWatermark.length !== 1 || orphanBelow.orphansPinningWatermark.length !== 0) {
    process.stderr.write("SELF-TEST FAIL: an orphan under the watermark must be a note, not a failure\n");
    process.exit(1);
  }

  const orphanPinning = classify(entries, [
    { id: 1, created_at: 100 },
    { id: 2, created_at: 200 },
    { id: 3, created_at: 999 },
  ]);
  if (orphanPinning.orphansPinningWatermark.length !== 1 || orphanPinning.orphansBelowWatermark.length !== 0) {
    process.stderr.write("SELF-TEST FAIL: an orphan holding the watermark must still be fatal\n");
    process.exit(1);
  }

  const orphanBelowStillCatchesSkips = classify(entries, [
    { id: 1, created_at: 100 },
    { id: 2, created_at: 150 },
    { id: 3, created_at: 300 },
  ]);
  if (orphanBelowStillCatchesSkips.skipped.length !== 1 || orphanBelowStillCatchesSkips.skipped[0].tag !== "0002_b") {
    process.stderr.write("SELF-TEST FAIL: noting an orphan must not blind the gate to a stranded entry\n");
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
    { id: 1, created_at: 100, hash: "0001-edited-after-apply" },
    { id: 2, created_at: 200, hash: "0002-edited-after-apply" },
  ]);
  if (hashDrift.orphans.length > 0 || hashDrift.duplicates.length > 0) {
    process.stderr.write("SELF-TEST FAIL: hash drift on an applied row was misread as an orphan or a duplicate\n");
    process.exit(1);
  }

  const reappliedAtAnotherTime = classify(entries, [
    { id: 1, created_at: 100, hash: "same-file" },
    { id: 2, created_at: 200, hash: "same-file" },
  ]);
  if (reappliedAtAnotherTime.duplicates.length !== 1) {
    process.stderr.write(
      "SELF-TEST FAIL: one file recorded twice under two created_at values is a real double-apply and must be fatal — created_at is transaction start, so a genuine re-apply never lands on the same value\n",
    );
    process.exit(1);
  }

  const collisionIsNotAReapply = classify(entries, [
    { id: 1, created_at: 100, hash: "the-journalled-file" },
    { id: 2, created_at: 100, hash: "an-unrelated-reconciliation-row" },
    { id: 3, created_at: 300, hash: "0003-c" },
  ]);
  if (collisionIsNotAReapply.duplicates.length !== 0) {
    process.stderr.write(
      "SELF-TEST FAIL: two different files sharing one created_at were called a double-apply — that is a created_at collision, not one migration running twice\n",
    );
    process.exit(1);
  }
  if (collisionIsNotAReapply.orphansBelowWatermark.length !== 1) {
    process.stderr.write(
      "SELF-TEST FAIL: the surplus row on an occupied created_at must still be reported as an orphan, or correcting the duplicate class would hide it entirely\n",
    );
    process.exit(1);
  }

  const collisionHoldingTheWatermark = classify(entries, [
    { id: 1, created_at: 100, hash: "the-journalled-file" },
    { id: 2, created_at: 300, hash: "0003-c" },
    { id: 3, created_at: 300, hash: "an-unrelated-reconciliation-row" },
  ]);
  if (collisionHoldingTheWatermark.orphansPinningWatermark.length !== 1) {
    process.stderr.write(
      "SELF-TEST FAIL: a surplus row holding the watermark must stay fatal — it pins the watermark to a file the journal cannot name\n",
    );
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

const { createScriptSql } = await import("./lib/script-sql-client.mjs");
const sql = await createScriptSql({ url });

try {
  const journal = JSON.parse(readFileSync(JOURNAL, "utf8"));
  const rows = await sql`select id, hash, created_at from drizzle.__drizzle_migrations order by id`;
  const { orphansPinningWatermark, orphansBelowWatermark, duplicates, skipped, pending, watermark } =
    classify(journal.entries, rows);

  process.stdout.write(
    `Ledger: ${rows.length} applied row(s) against ${journal.entries.length} journal entr(ies).\n` +
    `Watermark ${watermark}; ${pending.length} migration(s) pending.\n`,
  );

  if (orphansBelowWatermark.length)
    process.stdout.write(
      `\nNOTE [orphan-below-watermark] ${orphansBelowWatermark.length} row(s): ` +
      `${orphansBelowWatermark.map((o) => `${o.id}@${o.created_at}`).join(", ")}\n` +
      `  Rows the journal cannot account for: either their created_at matches no entry, or they are surplus\n` +
      `  on a created_at another row already occupies. They cannot strand anything: the watermark is\n` +
      `  ${watermark}, every one of them is below it, and the skipped check above independently proves no\n` +
      `  journal entry is unreachable. This becomes fatal the moment one of them holds the watermark,\n` +
      `  because it would pin the watermark to a migration nobody can find.\n` +
      `  On a collision the gate keeps the lowest id and reports the later one, which is NOT a claim about\n` +
      `  which row the journal actually names — establish that by hashing the .sql files before touching any\n` +
      `  row, or you will repair the legitimate one.\n`,
    );

  const failures = [];
  if (orphansPinningWatermark.length)
    failures.push(
      `${orphansPinningWatermark.length} orphan row(s) AT OR ABOVE the watermark, pinning it to a migration with no journal entry: ` +
      `${orphansPinningWatermark.map((o) => `${o.id}@${o.created_at}`).join(", ")}`,
    );
  if (duplicates.length)
    failures.push(
      `${duplicates.length} row(s) recording a file hash that is already in the ledger — that migration ran twice: ` +
      `${duplicates.map((d) => `${d.id}@${d.created_at}`).join(", ")}`,
    );
  if (skipped.length)
    failures.push(
      `${skipped.length} journal entr(ies) at or below the watermark with no ledger row: ${skipped.map((s) => s.tag).join(", ")}. ` +
      `Diagnose by HASH before concluding anything: the runner queues every journal entry in array order and relies on its own ` +
      `file-hash guard, so a missing row here means the migration is unapplied OR that its journal 'when' was edited away from ` +
      `the created_at its ledger row carries`,
    );

  if (failures.length) {
    process.stderr.write("\ncheck:migration-ledger FAILED\n");
    for (const line of failures) process.stderr.write(`  ${line}\n`);
    process.exit(1);
  }

  process.stdout.write(
    orphansBelowWatermark.length
      ? `Gate passed: no duplicate rows, no unreachable entries, and no orphan holds the watermark. ${orphansBelowWatermark.length} orphan row(s) noted above.\n`
      : "No orphan, duplicate or unreachable entries. Gate passed.\n",
  );
} finally {
  await sql.end();
}
