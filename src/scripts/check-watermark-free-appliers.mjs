#!/usr/bin/env node
/**
 * Every migration applier must iterate the journal array and guard double application
 * by file hash or applied-set membership. None may select by a created_at watermark.
 * db-bootstrap.mjs deliberately guards on created_at set membership rather than hash,
 * and records why: joining on sha256(file) made two runners build different databases
 * from one journal. Both forms are correct; only the watermark is not.
 *
 * This is the invariant `journal-order` was reaching for and could not express.
 * drizzle-kit selected migrations with `created_at > max(applied)`, which on this
 * journal skips 727 of 876 entries, and `run-pending-migrations.mjs` records the
 * measured consequence: applying 0557 once made 15 later entries permanently
 * unselectable and 0559 cost another 17, with no failure reported. `db:migrate` now
 * runs that applier instead, so `when` decides nothing anywhere — and a non-monotonic
 * `when` is harmless exactly as long as that stays true.
 *
 * Ordering by array position is required and checked; ordering by `when` is the defect.
 *
 *   node src/scripts/check-watermark-free-appliers.mjs
 *   node src/scripts/check-watermark-free-appliers.mjs --self-test
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = resolve(HERE, "..", "..");
const SELF_TEST = process.argv.includes("--self-test");

const APPLIERS = [
  { path: "src/scripts/run-pending-migrations.mjs", resumable: true },
  { path: "src/scripts/db-bootstrap.mjs", resumable: true },
  { path: "src/scripts/apply-chain-cold.mjs", resumable: true },
  { path: "src/scripts/migration-plan.mjs", resumable: true },
  { path: "src/scripts/replay-chain-cold.mjs", resumable: false },
];

const WATERMARK_SELECTION = [
  /\.filter\(\s*\([^)]*\)\s*=>\s*[a-zA-Z_.]*\.when\s*>/,
  /entries\.filter\([^)]*when\s*>[^=]/,
  /where\s+created_at\s*>/i,
  /created_at\s*>\s*\$?\{?\s*watermark/i,
];

export function findWatermarkSelection(source) {
  const hits = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    for (const pattern of WATERMARK_SELECTION)
      if (pattern.test(line)) hits.push({ line: i + 1, text: line.trim().slice(0, 160) });
  }
  return hits;
}

export function usesIdempotencyGuard(source) {
  const byHash = /where\s+hash\s*=/i.test(source) || /\.has\(\s*hash\s*\)/.test(source);
  const byAppliedSet = /\.has\(\s*(?:String\()?[a-zA-Z_.]*(?:when|created_at|createdAt)/i.test(source);
  const byCanonicalPlanner = /planMigrations\s*\(/.test(source);
  return byHash || byAppliedSet || byCanonicalPlanner;
}

function main() {
  const failures = [];
  let checked = 0;

  for (const { path: relative, resumable } of APPLIERS) {
    const path = join(BACKEND_ROOT, relative);
    if (!existsSync(path)) {
      failures.push(`${relative}: applier is missing — remove it from the list or restore it`);
      continue;
    }
    checked += 1;
    const source = readFileSync(path, "utf8");
    for (const hit of findWatermarkSelection(source))
      failures.push(`${relative}:${hit.line} selects migrations by watermark — ${hit.text}`);
    if (resumable && !usesIdempotencyGuard(source))
      failures.push(
        `${relative}: no idempotency guard found; a resumable applier must skip by file hash or by applied-set membership, never by watermark`,
      );
  }

  if (checked < APPLIERS.length) failures.push(`only ${checked} of ${APPLIERS.length} appliers were readable`);

  if (failures.length) {
    console.error("check:watermark-free FAILED");
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log(`OK — ${checked} migration applier(s) iterate the journal and guard double application; none selects by watermark.`);
  process.exit(0);
}

function selfTest() {
  const bad = [
    'const queue = journal.entries.filter((e) => e.when > watermark);',
    'const rows = await sql`select * from drizzle.__drizzle_migrations where created_at > ${watermark}`;',
  ];
  const good = [
    'const queue = journal.entries.map((e) => [e, e.when]);',
    'const already = await sql`select 1 from drizzle.__drizzle_migrations where hash = ${hash} limit 1`;',
    '// the watermark is reported for context and decides nothing',
    'console.log(`watermark=${watermark} | queued=${queue.length}`);',
  ];

  let failures = 0;
  for (const sample of bad)
    if (findWatermarkSelection(sample).length === 0) {
      console.error(`FAIL: known-bad sample not detected — ${sample}`);
      failures += 1;
    }
  for (const sample of good)
    if (findWatermarkSelection(sample).length !== 0) {
      console.error(`FAIL: known-good sample flagged — ${sample}`);
      failures += 1;
    }
  for (const guard of ["where hash = ${hash}", "applied.has(String(entry.when))", "appliedWhens.has(created_at)", "planMigrations(journal.entries, ledgerRows)"])
    if (!usesIdempotencyGuard(guard)) {
      console.error(`FAIL: idempotency guard not recognised — ${guard}`);
      failures += 1;
    }
  if (usesIdempotencyGuard("const x = 1;")) {
    console.error("FAIL: idempotency guard recognised where there is none");
    failures += 1;
  }
  if (APPLIERS.length < 5) {
    console.error(`FAIL: applier list has shrunk to ${APPLIERS.length}; a smaller sweep is not a passing sweep`);
    failures += 1;
  }

  if (failures) {
    console.error(`self-test: ${failures} failing checks`);
    process.exit(1);
  }
  console.log(`PASS: watermark-free self-test, ${bad.length + good.length + 4} checks, both directions bite.`);
  process.exit(0);
}

if (SELF_TEST) selfTest();
else main();
