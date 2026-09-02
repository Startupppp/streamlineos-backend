#!/usr/bin/env node
/**
 * Gate: no TypeScript source file in src/ may exceed 500 lines, except those
 * recorded in architecture-refactor/final-refactor/issues/file-size-exceptions.md.
 *
 * The registry fails CLOSED. An entry is only an exception when every one of these
 * holds, and any failure fails the gate rather than silently granting or dropping
 * an exemption:
 *   - the row carries all nine columns §7 asks for, none of them blank
 *   - the path is a concrete file, never a glob or a directory
 *   - the file exists on disk
 *   - the recorded line count equals the measured one
 *   - the file still exceeds the limit — a file that falls to 500 or below
 *     automatically loses its exception
 *   - the review date parses as a calendar date
 *
 * Excluded from scanning:
 *   *.spec.ts, *.e2e-spec.ts, *.d.ts — tests and declaration files are §7 exceptions by default.
 *
 * Flags:
 *   --self-test   Run fixture-based assertions and exit (no real file scan).
 */

import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative, extname } from "node:path";
import { WORKSPACE_ROOT, workspaceAvailable, workspaceUnreachableReason } from "./check-repo-paths.mjs";

const LIMIT = 500;
const MIN_FILES = 50;

function resolvePath(relativeUrl) {
  return new URL(relativeUrl, import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
}

const SRC = resolvePath("../");
const BACKEND_ROOT = resolvePath("../../");
// The registry lives in the workspace docs tree, which is a sibling repository on
// a split checkout. Guessing "../../.." resolved outside both repos and the gate
// died on ENOENT rather than measuring anything.
const EXCEPTIONS_DOC = workspaceAvailable
  ? join(WORKSPACE_ROOT, "architecture-refactor", "final-refactor", "issues", "file-size-exceptions.md")
  : null;

/**
 * The nine columns a §7 exception must carry, in order. `Lines` and `Review date`
 * are additionally value-checked; the rest only have to be present and non-empty,
 * because a blank owner or a blank removal trigger is an unreviewed exemption.
 */
const COLUMNS = [
  "path",
  "lines",
  "category",
  "owner",
  "interface",
  "cohesion",
  "alternatives",
  "reviewDate",
  "removalTrigger",
];

/**
 * Only the registry table grants an exception. Matching any backticked `src/…` path
 * in the document would exempt a file merely because the audit trail mentions it —
 * that silently exempted four files, none of which was ever reviewed for the limit.
 * Rows that look like exceptions but are malformed are returned as errors rather than
 * skipped: a typo used to drop an entry to "not an exception", which reads as a
 * violation of the size limit instead of a broken registry.
 */
export function parseExceptions(doc) {
  const entries = new Map();
  const errors = [];
  for (const line of doc.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    const match = cells[1]?.match(/^`([^`]+)`$/);
    if (!match) continue;
    const path = match[1];
    if (!path.startsWith("src/")) continue;

    if (path.includes("*") || path.endsWith("/")) {
      errors.push({ path, error: "wildcard and directory-wide exceptions are not allowed" });
      continue;
    }
    const values = cells.slice(1, 1 + COLUMNS.length);
    if (values.length < COLUMNS.length || values.some((v) => v === undefined || v === "")) {
      errors.push({
        path,
        error: `row must carry all ${COLUMNS.length} columns (${COLUMNS.join(", ")}) with none blank`,
      });
      continue;
    }
    const record = Object.fromEntries(COLUMNS.map((name, i) => [name, values[i]]));
    const lines = Number(record.lines);
    if (!Number.isInteger(lines) || lines <= 0) {
      errors.push({ path, error: `line count "${record.lines}" is not a positive integer` });
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(record.reviewDate) || Number.isNaN(Date.parse(record.reviewDate))) {
      errors.push({ path, error: `review date "${record.reviewDate}" is not an ISO calendar date` });
      continue;
    }
    if (entries.has(path)) {
      errors.push({ path, error: "registered more than once" });
      continue;
    }
    entries.set(path, { ...record, lines });
  }
  return { entries, errors };
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

export function runCheck(srcDir, rootDir, exceptionsPath, { minFiles = MIN_FILES } = {}) {
  let doc;
  try {
    doc = readFileSync(exceptionsPath, "utf8");
  } catch {
    return {
      ok: false, reason: "cannot-read-exceptions",
      message: `cannot read exceptions doc at ${exceptionsPath}`,
      fileCount: 0, violations: [], registryErrors: [], exceptionCount: 0,
    };
  }

  const { entries, errors } = parseExceptions(doc);
  const registryErrors = [...errors];

  for (const [regPath, record] of entries) {
    const fullPath = join(rootDir, regPath);
    let actualLines;
    try {
      actualLines = countLines(fullPath);
    } catch {
      registryErrors.push({ path: regPath, error: "registered path not found on disk" });
      continue;
    }
    if (actualLines !== record.lines) {
      registryErrors.push({
        path: regPath,
        error: `stale line count — registered ${record.lines}, actual ${actualLines}`,
      });
      continue;
    }
    if (actualLines <= LIMIT) {
      registryErrors.push({
        path: regPath,
        error: `exception no longer needed — file is at ${actualLines} lines (within the ${LIMIT}-line limit)`,
      });
    }
  }

  const files = collectFiles(srcDir);

  if (files.length < minFiles) {
    return {
      ok: false, reason: "vacuous-scan",
      message: `vacuity guard — only ${files.length} files found under ${srcDir} (expected ≥ ${minFiles}); scan is broken`,
      fileCount: files.length, violations: [], registryErrors, exceptionCount: entries.size,
    };
  }

  const violations = [];
  for (const file of files) {
    const rel = relative(rootDir, file).replace(/\\/g, "/");
    const lines = countLines(file);
    if (lines > LIMIT && !entries.has(rel)) violations.push({ path: rel, lines });
  }

  if (registryErrors.length > 0) {
    return {
      ok: false, reason: "stale-registry",
      fileCount: files.length, violations, registryErrors, exceptionCount: entries.size,
    };
  }

  return {
    ok: violations.length === 0,
    reason: violations.length > 0 ? "violations" : "ok",
    fileCount: files.length, violations, registryErrors: [], exceptionCount: entries.size,
  };
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

  const row = (path, lines) =>
    `| \`${path}\` | ${lines} | Cohesive catalog | Platform | MAIN() | one flat array | split by letter range rejected | 2026-12-01 | drops to 500 |`;

  const fakeDoc = [
    "## Exceptions",
    "",
    "| Path | Lines | Category | Owner | Interface | Cohesion | Alternatives | Review date | Removal trigger |",
    "|---|---|---|---|---|---|---|---|---|",
    row("src/scripts/relocate-org-data.ts", 767),
    row("src/modules/party/party-mirror-fields.ts", 552),
    "",
    "## Audit trail",
    "- Split `src/modules/chat/chat-message-timeline.service.ts` 239 -> 322 during the cutover.",
    "- `src/scripts/**` are CLI utilities and out of structural scope.",
  ].join("\n");

  const parsed = parseExceptions(fakeDoc);
  assert("parses first exception path", parsed.entries.has("src/scripts/relocate-org-data.ts"));
  assert("parses the recorded line count", parsed.entries.get("src/scripts/relocate-org-data.ts")?.lines === 767);
  assert("parses second exception path", parsed.entries.has("src/modules/party/party-mirror-fields.ts"));
  assert("does not include non-path tokens", !parsed.entries.has("767"));
  assert(
    "a path mentioned only in audit-trail prose is NOT an exception",
    !parsed.entries.has("src/modules/chat/chat-message-timeline.service.ts"),
  );
  assert("a glob in prose is NOT an exception", !parsed.entries.has("src/scripts/**"));
  assert("grants exactly the two table rows", parsed.entries.size === 2);
  assert("a well-formed registry reports no row errors", parsed.errors.length === 0);

  const short = parseExceptions("| `src/modules/x.ts` | 600 |");
  assert("a row missing columns grants nothing", short.entries.size === 0);
  assert("a row missing columns is reported as an error, not skipped", short.errors.length === 1);

  const blank = parseExceptions(
    "| `src/modules/x.ts` | 600 | Cohesive |  | I | C | A | 2026-12-01 | T |",
  );
  assert("a blank owner cell grants nothing", blank.entries.size === 0);
  assert("a blank owner cell is reported as an error", blank.errors.length === 1);

  const wildcard = parseExceptions(row("src/modules/**/*.ts", 600));
  assert("a wildcard path grants nothing", wildcard.entries.size === 0);
  assert("a wildcard path is reported as an error", wildcard.errors.some((e) => e.error.includes("wildcard")));

  const dirWide = parseExceptions(row("src/modules/party/", 600));
  assert("a directory-wide path grants nothing", dirWide.entries.size === 0);
  assert("a directory-wide path is reported as an error", dirWide.errors.length === 1);

  const badDate = parseExceptions(
    "| `src/modules/x.ts` | 600 | Cohesive | Platform | I | C | A | soon | T |",
  );
  assert("a non-date review date grants nothing", badDate.entries.size === 0);
  assert("a non-date review date is reported as an error", badDate.errors.some((e) => e.error.includes("review date")));

  const dupe = parseExceptions([row("src/modules/x.ts", 600), row("src/modules/x.ts", 700)].join("\n"));
  assert("a duplicate registration is reported as an error", dupe.errors.some((e) => e.error.includes("more than once")));

  // The scan and the registry validation against real files on disk. Asserting on the
  // parser alone left a broken collectFiles() reporting zero violations and still passing.
  const tmpRoot = mkdtempSync(join(tmpdir(), "be-chk-fs-"));
  try {
    function writeLines(filePath, n) {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, Array.from({ length: n }, (_, i) => `const x${i} = ${i};`).join("\n") + "\n");
    }
    function makeRegistry(rows) {
      return [
        "## Exceptions", "",
        "| Path | Lines | Category | Owner | Interface | Cohesion | Alternatives | Review date | Removal trigger |",
        "|---|---|---|---|---|---|---|---|---|",
        ...rows.map((r) => row(r.path, r.lines)),
      ].join("\n") + "\n";
    }
    const build = (name, files, rows) => {
      const dir = join(tmpRoot, name);
      for (const [rel, n] of Object.entries(files)) writeLines(join(dir, rel), n);
      writeFileSync(join(dir, "exc.md"), makeRegistry(rows));
      return dir;
    };

    const vacDir = build("vac", { "src/one.ts": 10 }, []);
    const vacRes = runCheck(join(vacDir, "src"), vacDir, join(vacDir, "exc.md"), { minFiles: 5 });
    assert("vacuous scan: ok=false", vacRes.ok === false);
    assert("vacuous scan: reason=vacuous-scan", vacRes.reason === "vacuous-scan");

    const noExcDir = build("no-exc", { "src/modules/big.ts": 501 }, []);
    const noExcRes = runCheck(join(noExcDir, "src"), noExcDir, join(noExcDir, "exc.md"), { minFiles: 1 });
    assert("over-limit with no exception: ok=false", noExcRes.ok === false);
    assert("over-limit with no exception: reason=violations", noExcRes.reason === "violations");
    assert("over-limit with no exception: reports 501 lines", noExcRes.violations.some((v) => v.lines === 501));

    const missingDir = build("missing", { "src/modules/big.ts": 510 },
      [{ path: "src/modules/big.ts", lines: 510 }, { path: "src/modules/gone.ts", lines: 900 }]);
    const missingRes = runCheck(join(missingDir, "src"), missingDir, join(missingDir, "exc.md"), { minFiles: 1 });
    assert("a registered path that no longer exists fails the gate", missingRes.ok === false);
    assert("a missing registered path is named", missingRes.registryErrors.some((e) => e.path.endsWith("gone.ts")));

    const staleDir = build("stale", { "src/modules/big.ts": 510 }, [{ path: "src/modules/big.ts", lines: 520 }]);
    const staleRes = runCheck(join(staleDir, "src"), staleDir, join(staleDir, "exc.md"), { minFiles: 1 });
    assert("stale line count: ok=false", staleRes.ok === false);
    assert("stale line count: reason=stale-registry", staleRes.reason === "stale-registry");
    assert("stale line count: error names the drift", staleRes.registryErrors.some((e) => e.error.includes("stale line count")));

    const shrunkDir = build("shrunk", { "src/modules/small.ts": 490 }, [{ path: "src/modules/small.ts", lines: 490 }]);
    const shrunkRes = runCheck(join(shrunkDir, "src"), shrunkDir, join(shrunkDir, "exc.md"), { minFiles: 1 });
    assert("a file that fell to the limit loses its exception", shrunkRes.ok === false);
    assert(
      "a file that fell to the limit says the exception is no longer needed",
      shrunkRes.registryErrors.some((e) => e.error.includes("no longer needed")),
    );

    const okDir = build("ok", { "src/modules/big.ts": 510, "src/modules/fine.ts": 12 },
      [{ path: "src/modules/big.ts", lines: 510 }]);
    const okRes = runCheck(join(okDir, "src"), okDir, join(okDir, "exc.md"), { minFiles: 1 });
    assert("a complete, accurate exception passes", okRes.ok === true);
    assert("a complete, accurate exception reports reason=ok", okRes.reason === "ok");
    assert("spec and declaration files are excluded from the scan", (() => {
      const d = build("excl", { "src/modules/x.spec.ts": 900, "src/modules/y.e2e-spec.ts": 900, "src/modules/z.d.ts": 900, "src/modules/a.ts": 12 }, []);
      const r = runCheck(join(d, "src"), d, join(d, "exc.md"), { minFiles: 1 });
      return r.ok === true && r.fileCount === 1;
    })());
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }

  assert("the §7 exception registry is reachable in this checkout", EXCEPTIONS_DOC !== null && existsSync(EXCEPTIONS_DOC));
  assert(
    "the real registry parses to at least one exception and no row errors",
    EXCEPTIONS_DOC !== null && existsSync(EXCEPTIONS_DOC) &&
      (() => {
        const p = parseExceptions(readFileSync(EXCEPTIONS_DOC, "utf8"));
        return p.entries.size > 0 && p.errors.length === 0;
      })(),
  );
  assert(
    "counts a trailing-newline file without an off-by-one",
    EXCEPTIONS_DOC !== null && existsSync(EXCEPTIONS_DOC) && countLines(EXCEPTIONS_DOC) > 0,
  );
  assert(
    "the gate resolves a real source tree — a broken resolvePath must fail loudly, not scan nothing",
    existsSync(SRC) && existsSync(join(SRC, "modules")),
  );
  assert(
    "BACKEND_ROOT resolves to the repository root, not somewhere outside it",
    existsSync(join(BACKEND_ROOT, "package.json")),
  );
  if (failed > 0) {
    console.error(`check-file-sizes self-tests: ${failed} failed, ${passed} passed`);
    process.exit(1);
  }
  console.log(`check-file-sizes self-tests: ${passed} passed`);
  process.exit(0);
}

if (process.argv.includes("--self-test")) runSelfTests();

if (EXCEPTIONS_DOC === null) {
  console.error(
    `INCONCLUSIVE — check-file-sizes: the §7 exception registry could not be located, so every exempt file would be reported as a violation.`,
  );
  console.error(`  ${workspaceUnreachableReason()}`);
  process.exit(2);
}

const result = runCheck(SRC, BACKEND_ROOT, EXCEPTIONS_DOC);

if (result.reason === "cannot-read-exceptions") {
  console.error(`check-file-sizes: ${result.message}`);
  process.exit(2);
}

if (result.reason === "vacuous-scan") {
  console.error(`check-file-sizes: ${result.message}`);
  process.exit(1);
}

if (result.reason === "stale-registry") {
  console.error(`check-file-sizes: exception registry is stale — ${result.registryErrors.length} error(s):\n`);
  for (const e of result.registryErrors) console.error(`  ${e.path}: ${e.error}`);
  if (result.violations.length > 0) {
    console.error(`\nAlso ${result.violations.length} unregistered file(s) over ${LIMIT} lines:`);
    for (const v of result.violations) console.error(`  ${v.lines} lines  ${v.path}`);
  }
  console.error(`\nFix: re-measure the affected file(s) and update ${EXCEPTIONS_DOC}. A file at or below ${LIMIT} lines must lose its row.`);
  process.exit(1);
}

if (result.violations.length > 0) {
  console.error(`check-file-sizes: ${result.violations.length} file(s) exceed ${LIMIT} lines:\n`);
  for (const v of result.violations) console.error(`  ${v.lines} lines  ${v.path}`);
  console.error(`\nTo exempt a file, add it to ${EXCEPTIONS_DOC} with the full nine-column record.`);
  process.exit(1);
}

console.log(
  `check-file-sizes: ${result.fileCount} files scanned — all within ${LIMIT} lines (${result.exceptionCount} exceptions registered)`,
);
process.exit(0);
