#!/usr/bin/env node
/**
 * Ratchet gate: count of backend production TypeScript files over 300 lines
 * must not increase beyond the baseline, first set on 2026-08-31, lowered to
 * 392 on 2026-09-03 and to 390 on 2026-09-08, each time by splitting files
 * along a responsibility seam. The baseline may only ever move DOWN.
 *
 * Scans: src/**\/*.ts excluding *.spec.ts, *.e2e-spec.ts, *.d.ts (same scope as check-file-sizes.mjs).
 * Passes when actual count <= BASELINE. Fails when it increases.
 * To lower the baseline after a split, decrement BASELINE and commit.
 *
 * Flags:
 *   --self-test   Run internal assertions and exit (no file scan).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const LIMIT = 300;
/**
 * 394 was set on 2026-08-31. Lowered to 380 on 2026-09-11 after the split
 * programme took the real count from 476 to 380 without registering an
 * exemption, so the ratchet holds the new floor instead of leaving 14 files of
 * silent headroom for a regression to spend.
 *
 * Raised to 413 on 2026-09-11 by the lane merge, not by growth: 380 counted the
 * inventory lane alone, and the CRM/Timesheets/accounting lanes brought files
 * this gate had never measured. Of the 413, 349 are inventory-lane files and 64
 * came from the other lanes; none grew in the merge, and the five files the
 * merge did push past 300 were split back under.
 *
 * origin/main carried 390 for its own tree when it was merged in on 2026-09-11.
 * Neither number describes the merged tree; re-measure it and set this to the
 * measured count.
 */
const BASELINE = 413;
const MIN_FILES = 50;

function resolvePath(rel) {
  return fileURLToPath(new URL(rel, import.meta.url));
}

const SRC = resolvePath("../");
const BACKEND_ROOT = resolvePath("../../");

function collectFiles(dir, files = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectFiles(full, files);
    } else if (
      stat.isFile() &&
      extname(entry) === ".ts" &&
      !entry.endsWith(".d.ts") &&
      !entry.endsWith(".spec.ts") &&
      !entry.endsWith(".e2e-spec.ts")
    ) {
      files.push(full);
    }
  }
  return files;
}

function countLines(filePath) {
  const content = readFileSync(filePath, "utf8");
  const parts = content.split("\n");
  return content.endsWith("\n") ? parts.length - 1 : parts.length;
}

function runSelfTests() {
  let passed = 0;
  let failed = 0;

  function assert(label, condition) {
    if (condition) {
      passed++;
    } else {
      console.error(`  FAIL: ${label}`);
      failed++;
    }
  }

  assert("BASELINE is a positive integer", Number.isInteger(BASELINE) && BASELINE > 0);
  assert("LIMIT is 300", LIMIT === 300);
  assert("MIN_FILES is a positive integer", Number.isInteger(MIN_FILES) && MIN_FILES > 0);

  // The scan itself, against known-bad files on disk. Asserting on the constants
  // alone left a broken collectFiles() reporting zero crossings and still passing.
  const fixture = mkdtempSync(join(tmpdir(), "over-300-self-test-"));
  try {
    mkdirSync(join(fixture, "nested"), { recursive: true });
    writeFileSync(join(fixture, "nested", "over.ts"), "x\n".repeat(301));
    writeFileSync(join(fixture, "exactly-at-limit.ts"), "x\n".repeat(300));
    writeFileSync(join(fixture, "under.ts"), "x\n".repeat(12));
    writeFileSync(join(fixture, "over.spec.ts"), "x\n".repeat(400));
    writeFileSync(join(fixture, "over.e2e-spec.ts"), "x\n".repeat(400));
    writeFileSync(join(fixture, "over.d.ts"), "x\n".repeat(400));
    writeFileSync(join(fixture, "over.js"), "x\n".repeat(400));

    const collected = collectFiles(fixture).map((f) => f.replace(/\\/g, "/"));
    const overLimit = collected.filter((f) => countLines(f) > LIMIT);

    assert("collectFiles recurses into subdirectories", collected.some((f) => f.endsWith("/nested/over.ts")));
    assert("a 301-line file is over the limit", overLimit.some((f) => f.endsWith("/nested/over.ts")));
    assert("a file at exactly 300 lines is not over the limit", !overLimit.some((f) => f.endsWith("/exactly-at-limit.ts")));
    assert("an under-limit file is not counted", !overLimit.some((f) => f.endsWith("/under.ts")));
    assert("countLines does not count the trailing newline as a line", countLines(join(fixture, "under.ts")) === 12);
    assert("spec files are excluded from the scan", !collected.some((f) => f.endsWith(".spec.ts")));
    assert("e2e-spec files are excluded from the scan", !collected.some((f) => f.endsWith(".e2e-spec.ts")));
    assert("declaration files are excluded from the scan", !collected.some((f) => f.endsWith(".d.ts")));
    assert("non-TypeScript files are excluded from the scan", !collected.some((f) => f.endsWith(".js")));
    assert("the vacuity guard would fire on this fixture", collected.length < MIN_FILES);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }

  assert(
    "the gate resolves a real source tree — a broken resolvePath must fail loudly, not scan nothing",
    existsSync(SRC) && existsSync(join(SRC, "modules")),
  );
  assert(
    "BACKEND_ROOT resolves to the repository root, not somewhere outside it",
    existsSync(join(BACKEND_ROOT, "package.json")),
  );
  if (failed > 0) {
    console.error(`check-over-300 self-tests: ${failed} failed, ${passed} passed`);
    process.exit(1);
  }
  console.log(`check-over-300 self-tests: ${passed} passed`);
  process.exit(0);
}

if (process.argv.includes("--self-test")) runSelfTests();

const files = collectFiles(SRC);

if (files.length < MIN_FILES) {
  console.error(
    `check-over-300: vacuity guard — only ${files.length} files found under ${SRC} (expected ≥ ${MIN_FILES}); scan is broken`,
  );
  process.exit(1);
}

const over300 = [];
for (const file of files) {
  const lines = countLines(file);
  if (lines > LIMIT) {
    over300.push({ path: relative(BACKEND_ROOT, file).replace(/\\/g, "/"), lines });
  }
}

const actual = over300.length;

if (actual <= BASELINE) {
  console.log(
    `check-over-300: ${actual} of ${files.length} production files exceed ${LIMIT} lines (baseline ${BASELINE}) — OK`,
  );
  process.exit(0);
}

const increase = actual - BASELINE;
console.error(
  `check-over-300: ${actual} files exceed ${LIMIT} lines — ${increase} above baseline of ${BASELINE}.\n`,
);
console.error(`Files exceeding ${LIMIT} lines (${actual} total):`);
for (const v of over300.sort((a, b) => b.lines - a.lines)) {
  console.error(`  ${v.lines}  ${v.path}`);
}
console.error(
  `\nTo fix: split the new file(s) or, if the count is a genuine exception, decrement BASELINE in this script after justifying in architecture-refactor/final-refactor/issues/file-size-exceptions.md.`,
);
process.exit(1);
