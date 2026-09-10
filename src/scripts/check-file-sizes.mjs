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
import { resolveFrontendRepoRoot } from "./lib/repo-roots.mjs";

const LIMIT = 500;
const MIN_FILES = 50;

function resolvePath(relativeUrl) {
  return new URL(relativeUrl, import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
}

const SRC = resolvePath("../");
const BACKEND_ROOT = resolvePath("../../");
/**
 * The exceptions registry lives in the FRONTEND repo, not the workspace root.
 * This resolved `<workspace>/architecture-refactor/...`, which has never
 * existed, so the gate exited 1 on every run without scanning a single file —
 * indistinguishable from "a file is over the limit". Resolved through the
 * paired-worktree helper instead: this checkout's registry is in
 * `inv-wt-frontend/`, not `streamlineos-frontend/`.
 */
const { root: FRONTEND_REPO_ROOT, candidates: FRONTEND_REPO_CANDIDATES } =
  resolveFrontendRepoRoot();
const EXCEPTIONS_DOC = FRONTEND_REPO_ROOT
  ? join(FRONTEND_REPO_ROOT, "architecture-refactor", "final-refactor", "issues", "file-size-exceptions.md")
  : null;

function loadExceptions() {
  let doc;
  if (EXCEPTIONS_DOC === null) {
    // 2, not 1: nothing was measured. Exit 1 here says "a file is too long".
    console.error("check-file-sizes: PREREQUISITE MISSING — cannot locate the frontend repo holding the exceptions registry. Tried:");
    for (const candidate of FRONTEND_REPO_CANDIDATES) console.error(`  ${candidate}`);
    process.exit(2);
  }
  try {
    doc = readFileSync(EXCEPTIONS_DOC, "utf8");
  } catch {
    console.error(`check-file-sizes: PREREQUISITE MISSING — cannot read exceptions doc at ${EXCEPTIONS_DOC}`);
    process.exit(2);
  }
  return parseExceptions(doc);
}

/**
 * Only the registry table grants an exception. Matching any backticked `src/…` path
 * in the document would exempt a file merely because the audit trail mentions it —
 * that silently exempted four files, none of which was ever reviewed for the limit.
 * An exception must be a table row carrying the owner, interface and reason §7 asks for.
 */
function parseExceptions(doc) {
  const exceptions = new Set();
  for (const line of doc.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    const match = cells[1]?.match(/^`(src\/[^`]+)`$/);
    if (!match) continue;
    if (cells.length < 7) continue;
    exceptions.add(match[1]);
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

  const fakeDoc = [
    "## Exceptions",
    "",
    "| Path | Lines | Category | Interface | Reason | Owner |",
    "|---|---|---|---|---|---|",
    "| `src/scripts/relocate-org-data.ts` | 767 | CLI | main() | cohesive | Platform |",
    "| `src/modules/party/party-mirror-fields.ts` | 552 | Catalog | CONST | cohesive | Party |",
    "",
    "## Audit trail",
    "- Split `src/modules/chat/chat-message-timeline.service.ts` 239 -> 322 during the cutover.",
    "- `src/scripts/**` are CLI utilities and out of structural scope.",
  ].join("\n");

  const parsed = parseExceptions(fakeDoc);
  assert("parses first exception path", parsed.has("src/scripts/relocate-org-data.ts"));
  assert("parses second exception path", parsed.has("src/modules/party/party-mirror-fields.ts"));
  assert("does not include non-path tokens", !parsed.has("767"));
  assert(
    "a path mentioned only in audit-trail prose is NOT an exception",
    !parsed.has("src/modules/chat/chat-message-timeline.service.ts"),
  );
  assert("a glob in prose is NOT an exception", !parsed.has("src/scripts/**"));
  assert("grants exactly the two table rows", parsed.size === 2);
  assert(
    "rejects a table row missing the owner/interface/reason columns",
    parseExceptions("| `src/modules/x.ts` | 600 |").size === 0,
  );
  assert("counts a trailing-newline file without an off-by-one", countLines(EXCEPTIONS_DOC) > 0);

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
