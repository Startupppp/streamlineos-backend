#!/usr/bin/env node
/**
 * Naming gate: every file and folder under src/ is kebab-case.
 *
 * Root CLAUDE.md §7 requires it for CI case-safety — Windows and macOS resolve
 * `Foo.ts` and `foo.ts` to the same file and Linux does not, so a capitalised
 * path builds locally and fails in CI. Tooling conventions that cannot be
 * renamed (`__tests__`, `__snapshots__`, `@types`) are allowed by name, not by
 * a loose pattern, so a genuinely mis-cased directory still fails.
 *
 * Flags:
 *   --self-test   Feed known-bad fixtures through the classifier and exit.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function resolvePath(rel) {
  return fileURLToPath(new URL(rel, import.meta.url));
}

const SRC = resolvePath("../");
const MIN_ENTRIES = 500;

const FILE_PATTERN = /^[a-z0-9][a-z0-9.-]*$/;
const DIR_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SCANNED_EXTENSIONS = [".ts", ".mjs", ".cjs", ".js", ".json"];

/** Tooling conventions that cannot be renamed without breaking the tool that reads them. */
const ALLOWED_DIRS = new Set(["__tests__", "__snapshots__", "@types"]);

/** path → why the name stands. Never extend to accept a merely convenient name. */
const ALLOWED_FILES = {
  "src/modules/email/templates/registry/_shared.ts":
    "leading underscore marks the one file in a template registry that is not itself a template; every sibling is a template family",
  "src/scripts/__coldboot-prep.mjs":
    "path is recorded verbatim in src/scripts/evidence/s05-evidence-bundle.json; renaming invalidates a captured evidence artifact",
};

export function classifyEntry(name, isDirectory) {
  if (isDirectory) {
    if (ALLOWED_DIRS.has(name)) return "allowed";
    return DIR_PATTERN.test(name) ? "ok" : "violation";
  }
  if (!SCANNED_EXTENSIONS.some((ext) => name.endsWith(ext))) return "skipped";
  return FILE_PATTERN.test(name) ? "ok" : "violation";
}

function walk(dir, rel, acc) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const relative = rel ? `${rel}/${entry}` : entry;
    const isDirectory = statSync(full).isDirectory();
    acc.scanned++;
    const verdict = classifyEntry(entry, isDirectory);
    if (verdict === "violation") acc.violations.push({ path: `src/${relative}`, isDirectory });
    if (isDirectory) walk(full, relative, acc);
  }
  return acc;
}

function runSelfTests() {
  let passed = 0;
  let failed = 0;
  const assert = (label, condition) => {
    if (condition) passed++;
    else {
      console.error(`  FAIL: ${label}`);
      failed++;
    }
  };

  assert("a PascalCase file is a violation", classifyEntry("MyService.ts", false) === "violation");
  assert("a camelCase file is a violation", classifyEntry("myService.ts", false) === "violation");
  assert("a snake_case file is a violation", classifyEntry("my_service.ts", false) === "violation");
  assert(
    "one capital letter anywhere is a violation — this is the CI case-safety failure",
    classifyEntry("build-Qa.service.ts", false) === "violation",
  );
  assert("a spaced file name is a violation", classifyEntry("my service.ts", false) === "violation");
  assert("a kebab-case file passes", classifyEntry("my-service.ts", false) === "ok");
  assert("a dotted kebab file passes", classifyEntry("my.service.spec.ts", false) === "ok");
  assert("a PascalCase directory is a violation", classifyEntry("BuildQa", true) === "violation");
  assert("a snake_case directory is a violation", classifyEntry("build_qa", true) === "violation");
  assert("a kebab-case directory passes", classifyEntry("build-qa", true) === "ok");
  assert("__tests__ is allowed by exact name", classifyEntry("__tests__", true) === "allowed");
  assert(
    "a lookalike double-underscore directory is NOT allowed",
    classifyEntry("__helpers__", true) === "violation",
  );
  assert(
    "a non-source extension is skipped rather than judged",
    classifyEntry("README.md", false) === "skipped",
  );
  assert(
    "ALLOWED_FILES entries all carry a reason",
    Object.values(ALLOWED_FILES).every((v) => typeof v === "string" && v.length > 20),
  );

  assert(
    "the gate resolves a real source tree — a broken resolvePath must fail loudly, not scan nothing",
    existsSync(SRC) && existsSync(join(SRC, "modules")),
  );
  if (failed > 0) {
    console.error(`check-kebab-case self-tests: ${failed} failed, ${passed} passed`);
    process.exit(1);
  }
  console.log(`check-kebab-case self-tests: ${passed} passed`);
  process.exit(0);
}

if (process.argv.includes("--self-test")) runSelfTests();

const result = walk(SRC, "", { scanned: 0, violations: [] });

if (result.scanned < MIN_ENTRIES) {
  console.error(
    `check-kebab-case: vacuity guard — only ${result.scanned} entries found under ${SRC} (expected >= ${MIN_ENTRIES}); the scan is broken`,
  );
  process.exit(1);
}

const unexplained = result.violations.filter((v) => !Object.hasOwn(ALLOWED_FILES, v.path));
const staleAllowances = Object.keys(ALLOWED_FILES).filter(
  (p) => !result.violations.some((v) => v.path === p),
);

console.log(
  `check-kebab-case: scanned ${result.scanned} entries under src — ${unexplained.length} violation(s), ${Object.keys(ALLOWED_FILES).length - staleAllowances.length} of ${Object.keys(ALLOWED_FILES).length} recorded exceptions still present`,
);

if (staleAllowances.length > 0) {
  console.error(`\nRecorded exceptions that no longer exist — remove them:`);
  for (const p of staleAllowances) console.error(`  ${p}`);
}

if (unexplained.length > 0) {
  console.error(`\nNot kebab-case (root CLAUDE.md §7):`);
  for (const v of unexplained) console.error(`  ${v.isDirectory ? "dir " : "file"}  ${v.path}`);
  console.error(`\nTo fix: rename to kebab-case and update every importer.`);
}

process.exit(unexplained.length > 0 || staleAllowances.length > 0 ? 1 : 0);
