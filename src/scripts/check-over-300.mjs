#!/usr/bin/env node
/**
 * Ratchet gate: count of backend production TypeScript files over 300 lines
 * must not increase beyond the baseline set on 2026-08-31.
 *
 * Scans: src/**\/*.ts excluding *.spec.ts, *.e2e-spec.ts, *.d.ts (same scope as check-file-sizes.mjs).
 * Passes when actual count <= BASELINE. Fails when it increases.
 * To lower the baseline after a split, decrement BASELINE and commit.
 *
 * Flags:
 *   --self-test   Run internal assertions and exit (no file scan).
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const LIMIT = 300;
const BASELINE = 394;
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
