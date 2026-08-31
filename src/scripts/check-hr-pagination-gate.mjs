#!/usr/bin/env node
/**
 * Gate: HR list endpoints must satisfy two invariants:
 *   1. PAGE CAP — no list fetches more than 100 rows (hard cap enforced by
 *      paginateOffset / boundPageLimit / keyset helpers, but callers must
 *      pass a value ≤ 100 and not hard-code larger values directly).
 *   2. CURSOR TIEBREAKER — every list uses a (timestamp, id) keyset, not
 *      bare OFFSET. An offset scan re-reads every preceding row; under RLS
 *      with a large org that is a full tenant scan on every deep page.
 *
 * Detects:
 *   • .offset(  or  offset:  (indicating offset pagination — not cursor)
 *   • .limit(N) where N > 100 as a hard-coded literal
 *
 * Self-tests run first; the gate exits 1 if fewer than MIN_FILES are scanned
 * (vacuity guard — a wrong ROOT path reports zero violations, not zero files).
 *
 * Usage:  node src/scripts/check-hr-pagination-gate.mjs
 * Exit:   0 clean · 1 violation found or vacuity triggered
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(SCRIPT_DIR, "../modules/hr");
const MIN_FILES = 60;

const OFFSET_EXPLICIT = /\.offset\s*\(/;
const OFFSET_NAMED = /\boffset\s*:/;
const OFFSET_SHORTHAND = /^\s*offset\s*[,}]/;
const LIMIT_OVERLARGE = /\.limit\s*\(\s*([0-9]{3,})\s*\)/;

function collectServiceFiles(dir) {
  const files = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      files.push(...collectServiceFiles(full));
    } else if (
      st.isFile() &&
      extname(entry) === ".ts" &&
      entry.endsWith(".service.ts") &&
      !entry.endsWith(".spec.ts")
    ) {
      files.push(full);
    }
  }
  return files;
}

function violations(src, relPath) {
  const lines = src.split("\n");
  const found = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    if (OFFSET_EXPLICIT.test(line)) {
      found.push({ lineNo, kind: "OFFSET", text: line.trim(), file: relPath });
    }
    if (OFFSET_NAMED.test(line)) {
      found.push({ lineNo, kind: "OFFSET-NAMED", text: line.trim(), file: relPath });
    }
    if (OFFSET_SHORTHAND.test(line)) {
      found.push({ lineNo, kind: "OFFSET-SHORTHAND", text: line.trim(), file: relPath });
    }
    const m = LIMIT_OVERLARGE.exec(line);
    if (m) {
      const n = Number(m[1]);
      if (n > 100) {
        found.push({ lineNo, kind: `LIMIT-OVER-100(${n})`, text: line.trim(), file: relPath });
      }
    }
  }
  return found;
}

function runSelfTests() {
  const knownOffsetExplicit = `
    async list() {
      return this.db.select({id: t.id}).from(t).limit(20).offset(offset);
    }
  `;
  const knownOffsetNamed = `
    return this.db.query.t.findMany({ where, limit, offset: offsetVar });
  `;
  const knownOffsetShorthand = `
    return this.db.query.t.findMany({
      where,
      limit,
      offset,
    });
  `;
  const knownOverlargeLimit = `
    return this.db.select().from(t).limit(500);
  `;
  const knownGoodCursor = `
    const rows = await this.db
      .select({ id: t.id })
      .from(t)
      .where(keysetCond)
      .limit(51);
  `;

  const v1 = violations(knownOffsetExplicit, "test");
  if (v1.length === 0) {
    process.stderr.write("SELF-TEST FAIL: known-bad .offset() was not flagged\n");
    process.exit(1);
  }
  const v2 = violations(knownOffsetNamed, "test");
  if (v2.length === 0) {
    process.stderr.write("SELF-TEST FAIL: known-bad offset: named arg was not flagged\n");
    process.exit(1);
  }
  const v2b = violations(knownOffsetShorthand, "test");
  if (v2b.length === 0) {
    process.stderr.write("SELF-TEST FAIL: known-bad offset shorthand in findMany was not flagged\n");
    process.exit(1);
  }
  const v3 = violations(knownOverlargeLimit, "test");
  if (v3.length === 0) {
    process.stderr.write("SELF-TEST FAIL: known-bad .limit(500) was not flagged\n");
    process.exit(1);
  }
  const v4 = violations(knownGoodCursor, "test");
  if (v4.length > 0) {
    process.stderr.write("SELF-TEST FAIL: known-good keyset with limit 51 was incorrectly flagged\n");
    process.exit(1);
  }
  process.stdout.write("Self-tests passed.\n");
}

runSelfTests();

let scannedCount = 0;
const allViolations = [];

const files = collectServiceFiles(ROOT);
for (const file of files) {
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  scannedCount++;
  const relPath = file.replace(ROOT, "").replace(/\\/g, "/");
  const found = violations(src, relPath);
  allViolations.push(...found);
}

if (scannedCount < MIN_FILES) {
  process.stderr.write(
    `VACUITY GUARD: only ${scannedCount} files scanned (expected >= ${MIN_FILES}). ` +
    `Check ROOT path: ${ROOT}\n`,
  );
  process.exit(1);
}

process.stdout.write(`Scanned ${scannedCount} HR service files.\n`);

if (allViolations.length === 0) {
  process.stdout.write("No offset pagination or overlarge limits found. Gate passed.\n");
  process.exit(0);
}

process.stderr.write(`\nFound ${allViolations.length} violation(s):\n\n`);
for (const v of allViolations) {
  process.stderr.write(`  [${v.kind}] ${v.file}:${v.lineNo}\n`);
  process.stderr.write(`    ${v.text}\n`);
}
process.exit(1);
