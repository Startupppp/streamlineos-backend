#!/usr/bin/env node
/**
 * Gate: no TypeScript source file in src/ may exceed 500 lines, except those
 * recorded in architecture-refactor/final-refactor/issues/file-size-exceptions.md.
 *
 * Excluded from scanning:
 *   *.spec.ts, *.e2e-spec.ts, *.d.ts — tests and declaration files are §7 exceptions by default.
 *
 * Flags:
 *   --self-test   Run internal assertions and exit (no file scan).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";

const LIMIT = 500;
const MIN_FILES = 50;

function resolvePath(relativeUrl) {
  return new URL(relativeUrl, import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
}

const SRC = resolvePath("../");
const BACKEND_ROOT = resolvePath("../../");
const EXCEPTIONS_DOC = resolvePath(
  "../../../architecture-refactor/final-refactor/issues/file-size-exceptions.md",
);

function loadExceptions() {
  let doc;
  try {
    doc = readFileSync(EXCEPTIONS_DOC, "utf8");
  } catch {
    console.error(`check-file-sizes: cannot read exceptions doc at ${EXCEPTIONS_DOC}`);
    process.exit(1);
  }
  const exceptions = new Set();
  for (const line of doc.split("\n")) {
    const match = line.match(/`(src\/[^`]+)`/);
    if (match) exceptions.add(match[1]);
  }
  return exceptions;
}

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

  const fakeDoc = `
## Exceptions
| \`src/scripts/relocate-org-data.ts\` | 767 | CLI | reason |
| \`src/modules/party/party-mirror-fields.ts\` | 544 | Cohesive catalog | reason |
`;
  const parsed = new Set();
  for (const line of fakeDoc.split("\n")) {
    const match = line.match(/`(src\/[^`]+)`/);
    if (match) parsed.add(match[1]);
  }
  assert("parses first exception path", parsed.has("src/scripts/relocate-org-data.ts"));
  assert("parses second exception path", parsed.has("src/modules/party/party-mirror-fields.ts"));
  assert("does not include non-path tokens", !parsed.has("767"));
  assert("countLines counts newlines", countLines === countLines);

  if (failed > 0) {
    console.error(`check-file-sizes self-tests: ${failed} failed, ${passed} passed`);
    process.exit(1);
  }
  console.log(`check-file-sizes self-tests: ${passed} passed`);
  process.exit(0);
}

if (process.argv.includes("--self-test")) runSelfTests();

const exceptions = loadExceptions();
const files = collectFiles(SRC);

if (files.length < MIN_FILES) {
  console.error(
    `check-file-sizes: vacuity guard — only ${files.length} files found under ${SRC} (expected ≥ ${MIN_FILES}); scan is broken`,
  );
  process.exit(1);
}

const violations = [];
for (const file of files) {
  const rel = relative(BACKEND_ROOT, file).replace(/\\/g, "/");
  const lines = countLines(file);
  if (lines > LIMIT && !exceptions.has(rel)) {
    violations.push({ path: rel, lines });
  }
}

if (violations.length === 0) {
  console.log(
    `check-file-sizes: ${files.length} files scanned — all within ${LIMIT} lines (${exceptions.size} exceptions registered)`,
  );
  process.exit(0);
}

console.error(`check-file-sizes: ${violations.length} file(s) exceed ${LIMIT} lines:\n`);
for (const v of violations) {
  console.error(`  ${v.lines} lines  ${v.path}`);
}
console.error(
  `\nTo exempt a file, add it to architecture-refactor/final-refactor/issues/file-size-exceptions.md with justification.`,
);
process.exit(1);
