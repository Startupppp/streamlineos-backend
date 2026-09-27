#!/usr/bin/env node
/**
 * check-transaction-callbacks.mjs
 *
 * A spec that doubles `db.transaction` must make the double run the callback.
 *
 * THE REFERENCE DEFECT — it is written into BE/CLAUDE.md §8 and nothing enforced it:
 *   "A `db.transaction` mock must invoke its callback — a bare `jest.fn()`
 *    silently voids every assertion inside the transaction."
 * `transaction: jest.fn()` returns `undefined` and never calls what it was
 * given. Every insert, update, outbox emit and `expect` inside the callback
 * disappears. The suite is green, the diff looks tested, and the transactional
 * path — which is where the money writes and the tenant writes live — has no
 * coverage at all. `transaction: jest.fn().mockResolvedValue(x)` is the same
 * defect wearing a return value: the method under test resolves happily, so
 * even an assertion on the RESULT passes.
 *
 * WHY THIS IS THE ONE CLASS OF "MISSING CRITICAL TEST" A SCANNER CAN JUDGE
 * Whether a retry or a failure branch is *adequately* tested is a reading, not a
 * measurement. But whether a transaction callback CAN run is a property of the
 * double, decidable from the double alone. This gate takes that class and
 * leaves the rest to review, rather than pretending to measure coverage it
 * cannot see.
 *
 * VERDICTS, per test BLOCK (a describe block is the unit; an exemption
 * assertion in one block does not cover doubles in a different block):
 *   INVOKES            some double calls its callback argument. Covered.
 *   REJECTS            every double rejects or throws. A deliberate
 *                      failure-branch test; the callback is not meant to run.
 *   DECLARED-UNREACHED the file asserts the transaction is never called
 *                      (`expect(db.transaction).not.toHaveBeenCalled()`), which
 *                      is the shape of a guard/refusal test.
 *   VOID               none of the above. Every assertion inside every
 *                      transaction callback in this file is unreachable.
 *
 * VACUITY GUARDS
 * - Fewer than MIN_SPEC_FILES spec files walked -> exit 2
 * - Fewer than MIN_DOUBLES transaction doubles found -> exit 2
 *
 * SELF-TEST (--self-test)
 * Drives the same classifier over planted doubles: bare, resolved-without-
 * invoking, invoking by several parameter names, rejecting, plain-arrow, and a
 * file-level declared-unreached assertion.
 *
 * Usage:
 *   node src/scripts/check-transaction-callbacks.mjs [--self-test] [--list]
 *
 * Exit codes:
 *   0 — no VOID file above the ratchet
 *   1 — a VOID spec file above the ratchet (or self-test failed)
 *   2 — the scan measured nothing
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_TEST = process.argv.includes("--self-test");
const LIST = process.argv.includes("--list");

const BACKEND_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const SCAN_ROOTS = ["src", "test"];

const MIN_SPEC_FILES = 200;
const MIN_DOUBLES = 100;

/**
 * Spec files whose every transaction double is inert. First measured 2026-09-02
 * at 9, after three false-positive classes were removed from the detector
 * (22 -> 11 -> 9): a double configured after the object literal
 * (`db.transaction.mockImplementation(...)`), a cast-then-call implementation
 * (`(cb as Fn)(mockDb)`), and a `transaction:` inside a TYPE annotation.
 * Baselining before that would have recorded 13 files of detector noise as debt.
 *
 * LOWERED 9 -> 2. Seven of the nine were repaired in spec territory: five refusal
 * tests now assert `expect(db.transaction).not.toHaveBeenCalled()`
 * (DECLARED-UNREACHED — the refusal happens before any write), and two
 * same-tenant controls now invoke the callback and assert what it did. The two
 * that remain are `inventory/replenishment` and `leads/lead-status`, both
 * excluded from this release's scope.
 *
 * TWO MORE READER BLIND SPOTS were fixed in the same pass, and both were found by
 * repairing a real file rather than by inspection:
 *   - a chain wrapped across lines — `transaction: jest\n.fn()\n.mockImplementation(...)`.
 *     The expression reader stopped at the line break, so an INVOKING double
 *     either vanished from the scan or, once newlines were allowed, read as BARE.
 *     18 files carry that shape.
 *   - an assignment over the literal — `dbSurface["transaction"] = jest.fn()...`,
 *     the form a spec must use when `db` is typed `as unknown as Db`. The bare
 *     `transaction: jest.fn()` above it is dead by the time any test runs.
 * Both were fixed BEFORE the ratchet was lowered, so the new number is a real
 * measurement and not the detector going quiet.
 *
 * RAISED 2 -> 8 (ticket 58, 2026-09-27). The value of 2 was WRONG — the verdict
 * function tested UNREACHED_RE against the entire file text, so one
 * `expect(db.transaction).not.toHaveBeenCalled()` anywhere in a spec promoted
 * every bare double in that file to DECLARED-UNREACHED. Six files were
 * misclassified: they had the not-called assertion in one describe block but bare
 * doubles in other describe blocks. After the fix tightened the unit to per
 * describe-block, those six re-classified as VOID. 8 is the first honest
 * measurement. It may only go down.
 */
const VOID_FILE_BASELINE = 8;

const UNREACHED_RE = /transaction\s*\)?[^\n]{0,40}\.not\s*\.\s*toHaveBeenCalled|not\s*\.\s*toHaveBeenCalled[^\n]{0,40}transaction/;

function walk(dir, out) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(spec|e2e-spec)\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

/** Balance from an opening bracket at `open`, skipping string contents. */
function balance(text, open) {
  const pairs = { "(": ")", "{": "}", "[": "]" };
  const close = pairs[text[open]];
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      i++;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === q) break;
        i++;
      }
    } else if (ch === text[open]) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return text.length - 1;
}

/** The whole `jest.fn()...` or `(fn) => ...` expression following `transaction:`. */
function readDoubleExpression(text, afterColon) {
  let i = afterColon;
  while (i < text.length && /\s/.test(text[i])) i++;
  const start = i;
  // Consume a leading `async` and any identifier/dot path, then balanced calls.
  let guard = 0;
  while (i < text.length && guard++ < 40) {
    // Newlines are part of the path, not the end of it. Prettier wraps a long
    // double as `jest\n.fn()\n.mockImplementation(...)`, and stopping at the line
    // break read only `jest` -- the double then failed the jest-surface guard
    // below and vanished from the scan entirely. An invoking double that is
    // invisible under-counts; a file holding one of those beside a bare double
    // reads VOID when it is covered.
    while (i < text.length && /[A-Za-z0-9_$.\s]/.test(text[i])) i++;
    if (text[i] === "(") {
      const end = balance(text, i);
      i = end + 1;
      // An arrow body follows a parameter list.
      let j = i;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text.slice(j, j + 2) === "=>") {
        j += 2;
        while (j < text.length && /\s/.test(text[j])) j++;
        if (text[j] === "{" || text[j] === "(") return text.slice(start, balance(text, j) + 1);
        const nl = text.indexOf("\n", j);
        return text.slice(start, nl === -1 ? text.length : nl);
      }
      // The chain continues after the newline too: `jest\n.fn()\n.mockImplementation(`.
      // Testing `text[i]` without skipping whitespace stopped at `jest.fn()` and
      // classified an invoking double BARE.
      if (text[j] === ".") {
        i = j;
        continue;
      }
      return text.slice(start, i);
    }
    return text.slice(start, i);
  }
  return text.slice(start, i);
}

/** Does `expr` call the callback it was handed? */
export function invokesCallback(expr) {
  // Every parameter list in the expression contributes candidate names.
  const params = new Set();
  const paramRe = /\(\s*([A-Za-z_$][\w$]*)\s*(?::[^)]*)?\)\s*=>/g;
  let m;
  while ((m = paramRe.exec(expr)) !== null) params.add(m[1]);
  const asyncRe = /function\s*\(\s*([A-Za-z_$][\w$]*)/g;
  while ((m = asyncRe.exec(expr)) !== null) params.add(m[1]);
  // `jest.fn(` would otherwise satisfy a parameter literally named `fn`.
  for (const p of params) {
    if (new RegExp(`(?<![.\\w$])${p}\\s*\\(`).test(expr)) return true;
    // `(cb as (tx: unknown) => Promise<unknown>)(mockDb)` — a cast, then a call.
    if (new RegExp(`\\(\\s*${p}\\s+as\\s[\\s\\S]{0,160}?\\)\\s*\\(`).test(expr)) return true;
  }
  return false;
}

export function classifyDouble(expr) {
  if (/mockRejectedValue|mockRejectedValueOnce/.test(expr)) return "REJECTS";
  if (invokesCallback(expr)) return "INVOKES";
  if (/\bthrow\b/.test(expr)) return "REJECTS";
  if (/mockResolvedValue|mockReturnValue|mockResolvedValueOnce|mockReturnValueOnce/.test(expr))
    return "RESOLVES-WITHOUT-INVOKING";
  return "BARE";
}

/**
 * A double is configured in one of two places, and reading only the first was
 * itself a blind spot: `{ transaction: jest.fn() }` followed later by
 * `db.transaction.mockImplementation(async (work) => work(db))` is COVERED, and
 * a scanner that stops at the object literal calls it inert.
 */
const LATE_CONFIG_RE =
  /\.\s*transaction\s*(?:as\s+[\w.<>\s]+\s*\))?\s*\.\s*(mockImplementation|mockImplementationOnce|mockResolvedValue|mockResolvedValueOnce|mockRejectedValue|mockRejectedValueOnce|mockReturnValue|mockReturnValueOnce)\s*\(/g;

/**
 * The third place a double is configured: ASSIGNED over, rather than declared in
 * the literal or reconfigured through a mock method.
 *   `dbSurface["transaction"] = jest.fn().mockImplementation((fn) => fn(tx));`
 * is the shape a spec reaches for when `db` is typed `as unknown as Db`, so
 * `db.transaction` is not a `jest.Mock` and the dot form will not type-check.
 * The bare `transaction: jest.fn()` in the literal above it is dead the moment
 * this line runs, and reading only the literal calls the file VOID when its
 * double invokes.
 */
const ASSIGN_CONFIG_RE = /(?:\.\s*transaction|\[\s*["'`]transaction["'`]\s*\])\s*=\s*/g;

export function scanFile(text) {
  const doubles = [];
  const re = /\btransaction\s*:/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const expr = readDoubleExpression(text, re.lastIndex);
    // A `transaction:` inside a TYPE annotation (`db is T & { transaction: (fn:
    // (tx) => Promise<void>) => Promise<void> }`) is not a double. Requiring a
    // jest surface or an actual invocation keeps type positions out.
    if (!/jest\s*\.\s*fn|mock(Resolved|Rejected|Return|Implementation)/.test(expr) && !invokesCallback(expr))
      continue;
    doubles.push({
      line: text.slice(0, m.index).split("\n").length,
      charIndex: m.index,
      verdict: classifyDouble(expr),
    });
  }
  LATE_CONFIG_RE.lastIndex = 0;
  while ((m = LATE_CONFIG_RE.exec(text)) !== null) {
    const open = LATE_CONFIG_RE.lastIndex - 1;
    const expr = `${m[1]}${text.slice(open, balance(text, open) + 1)}`;
    doubles.push({
      line: text.slice(0, m.index).split("\n").length,
      charIndex: m.index,
      verdict: classifyDouble(expr),
    });
  }
  ASSIGN_CONFIG_RE.lastIndex = 0;
  while ((m = ASSIGN_CONFIG_RE.exec(text)) !== null) {
    const expr = readDoubleExpression(text, ASSIGN_CONFIG_RE.lastIndex);
    if (!/jest\s*\.\s*fn|mock(Resolved|Rejected|Return|Implementation)/.test(expr) && !invokesCallback(expr))
      continue;
    doubles.push({
      line: text.slice(0, m.index).split("\n").length,
      charIndex: m.index,
      verdict: classifyDouble(expr),
    });
  }
  return doubles;
}

/**
 * Returns the text of the describe block that contains the character at `charIndex`,
 * or the full file text if no enclosing describe is found.
 */
function enclosingDescribeText(text, charIndex) {
  const before = text.slice(0, charIndex);
  const describeRe = /\bdescribe\s*\(/g;
  let lastDescribeIndex = -1;
  let dm;
  while ((dm = describeRe.exec(before)) !== null) {
    lastDescribeIndex = dm.index;
  }
  if (lastDescribeIndex === -1) return text;

  const afterDescribeKw = text.indexOf("(", lastDescribeIndex);
  if (afterDescribeKw === -1) return text;

  let depth = 0;
  let i = afterDescribeKw;
  let callbackBrace = -1;
  while (i < text.length && i < charIndex + 2000) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) break;
    } else if (ch === "{" && depth === 1) {
      callbackBrace = i;
      break;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      i++;
      while (i < text.length) {
        if (text[i] === "\\") { i += 2; continue; }
        if (text[i] === q) break;
        i++;
      }
    }
    i++;
  }
  if (callbackBrace === -1) return text;

  let bdepth = 0;
  let j = callbackBrace;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      j++;
      while (j < text.length) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === q) break;
        j++;
      }
    } else if (ch === "{") bdepth++;
    else if (ch === "}") {
      bdepth--;
      if (bdepth === 0) { j++; break; }
    }
    j++;
  }
  return text.slice(callbackBrace, j);
}

export function fileVerdict(doubles, text) {
  if (doubles.length === 0) return "NONE";
  if (doubles.some((d) => d.verdict === "INVOKES")) return "INVOKES";
  const isCovered = (d) => {
    if (d.verdict === "REJECTS") return true;
    const blockText = enclosingDescribeText(text, d.charIndex ?? 0);
    return UNREACHED_RE.test(blockText);
  };
  if (doubles.every(isCovered)) {
    if (doubles.some((d) => UNREACHED_RE.test(enclosingDescribeText(text, d.charIndex ?? 0)))) {
      return "DECLARED-UNREACHED";
    }
    return "REJECTS";
  }
  return "VOID";
}

function runSelfTest() {
  let failures = 0;
  let assertions = 0;
  const assert = (label, cond) => {
    assertions++;
    if (!cond) {
      console.error(`  FAIL ${label}`);
      failures++;
    }
  };

  assert("a bare jest.fn() double is BARE", classifyDouble("jest.fn()") === "BARE");
  assert(
    "mockResolvedValue without invoking is RESOLVES-WITHOUT-INVOKING",
    classifyDouble("jest.fn().mockResolvedValue(undefined)") === "RESOLVES-WITHOUT-INVOKING",
  );
  assert(
    "an implementation that calls `fn` INVOKES",
    classifyDouble("jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({}))") === "INVOKES",
  );
  assert(
    "an implementation that calls `cb` INVOKES",
    classifyDouble("jest.fn().mockImplementation((cb) => cb(tx))") === "INVOKES",
  );
  assert(
    "a plain arrow that calls its parameter INVOKES",
    classifyDouble("async (callback) => callback(txMock)") === "INVOKES",
  );
  assert("mockRejectedValue REJECTS", classifyDouble('jest.fn().mockRejectedValue({ code: "23503" })') === "REJECTS");
  assert(
    "an implementation that throws REJECTS",
    classifyDouble("jest.fn().mockImplementation(() => { throw new Error('x'); })") === "REJECTS",
  );
  assert(
    "a parameter named but never called does not count as INVOKES",
    classifyDouble("jest.fn().mockImplementation(async (fn) => ({ fn }))") === "BARE",
  );

  const bareFile = `
    const db = { transaction: jest.fn(), insert: jest.fn() };
    it("writes", async () => { await svc.create(); expect(db.insert).toHaveBeenCalled(); });
  `;
  const bareDoubles = scanFile(bareFile);
  assert("the bare double is found in file text", bareDoubles.length === 1);
  assert("a file whose only double is bare is VOID", fileVerdict(bareDoubles, bareFile) === "VOID");

  const invokingFile = `
    const db = { transaction: jest.fn().mockImplementation(async (fn) => fn(tx)) };
  `;
  assert(
    "a file with an invoking double is INVOKES",
    fileVerdict(scanFile(invokingFile), invokingFile) === "INVOKES",
  );

  const unreachedFile = `
    const db = { transaction: jest.fn() };
    it("refuses a foreign id", async () => {
      await expect(svc.update("other", 1)).rejects.toThrow();
      expect(db.transaction).not.toHaveBeenCalled();
    });
  `;
  assert(
    "a file that asserts the transaction is never reached is DECLARED-UNREACHED",
    fileVerdict(scanFile(unreachedFile), unreachedFile) === "DECLARED-UNREACHED",
  );

  const crossBlockFile = `
    describe("block A — asserts transaction is never called", () => {
      const db = { transaction: jest.fn() };
      it("rejects before reaching the write", async () => {
        await expect(svc.update("other", 1)).rejects.toThrow();
        expect(db.transaction).not.toHaveBeenCalled();
      });
    });
    describe("block B — bare double, no exemption", () => {
      const db2 = { transaction: jest.fn() };
      it("inserts a record", async () => {
        await svc.create();
      });
    });
  `;
  assert(
    "an exemption assertion in block A does not exempt the bare double in block B — file verdict is VOID not DECLARED-UNREACHED",
    fileVerdict(scanFile(crossBlockFile), crossBlockFile) === "VOID",
  );

  const rejectFile = `const db = { transaction: jest.fn().mockRejectedValue(new Error("boom")) };`;
  assert(
    "a file whose doubles all reject is REJECTS",
    fileVerdict(scanFile(rejectFile), rejectFile) === "REJECTS",
  );

  const mixedFile = `
    const a = { transaction: jest.fn() };
    const b = { transaction: jest.fn().mockImplementation((f) => f({})) };
  `;
  assert(
    "one invoking double covers the file",
    fileVerdict(scanFile(mixedFile), mixedFile) === "INVOKES",
  );

  assert(
    "a non-mock `transaction:` property is ignored",
    scanFile(`const row = { transaction: "TXN-1" };`).length === 0,
  );
  assert(
    "a `transaction:` inside a type annotation is not a double",
    scanFile(
      `function has<T>(db: T): db is T & { transaction: (fn: (tx: TenantTx) => Promise<void>) => Promise<void> } { return true; }`,
    ).length === 0,
  );
  assert(
    "a cast-then-call implementation INVOKES",
    classifyDouble("mockImplementation((cb: unknown) => (cb as (tx: unknown) => Promise<unknown>)(mockDb))") === "INVOKES",
  );

  const lateFile = `
    const db = { transaction: jest.fn() };
    db.transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work(db));
  `;
  assert(
    "a double configured after the object literal is found",
    scanFile(lateFile).some((d) => d.verdict === "INVOKES"),
  );
  assert(
    "a file whose double is configured late is INVOKES, not VOID",
    fileVerdict(scanFile(lateFile), lateFile) === "INVOKES",
  );

  const castLateFile = `
    const mockDb = { transaction: jest.fn() };
    (mockDb.transaction as jest.Mock).mockImplementation((cb) => cb(mockDb));
  `;
  assert(
    "a cast late configuration is found",
    fileVerdict(scanFile(castLateFile), castLateFile) === "INVOKES",
  );

  const wrappedChainFile = `
    const db = {
      transaction: jest
        .fn()
        .mockImplementation(
          async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
        ),
      select: jest.fn(),
    };
  `;
  assert(
    "a double whose chain is wrapped across lines is found",
    scanFile(wrappedChainFile).length === 1,
  );
  assert(
    "a double whose chain is wrapped across lines INVOKES, not BARE",
    fileVerdict(scanFile(wrappedChainFile), wrappedChainFile) === "INVOKES",
  );

  const wrappedBareFile = `
    const db = {
      transaction: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
    };
  `;
  assert(
    "a bare double followed by sibling properties is still exactly one double",
    scanFile(wrappedBareFile).length === 1,
  );
  assert(
    "a bare double followed by sibling properties is still VOID",
    fileVerdict(scanFile(wrappedBareFile), wrappedBareFile) === "VOID",
  );

  const bracketAssignFile = `
    const db = { transaction: jest.fn(), select: jest.fn() } as unknown as Db;
    const dbSurface = db as unknown as Record<string, unknown>;
    dbSurface["transaction"] = jest
      .fn()
      .mockImplementation((fn: (tx: Db) => Promise<unknown>) => fn(db));
  `;
  assert(
    "an assignment over the literal is found beside the literal's own double",
    scanFile(bracketAssignFile).length === 2,
  );
  assert(
    "a double assigned over the literal makes the file INVOKES, not VOID",
    fileVerdict(scanFile(bracketAssignFile), bracketAssignFile) === "INVOKES",
  );

  const dotAssignFile = `
    const db = { transaction: jest.fn() };
    db.transaction = jest.fn().mockImplementation((cb) => cb(db));
  `;
  assert(
    "a dot assignment over the literal also makes the file INVOKES",
    fileVerdict(scanFile(dotAssignFile), dotAssignFile) === "INVOKES",
  );

  if (failures > 0) {
    console.error(`check-transaction-callbacks self-test: ${failures} failed`);
    process.exit(1);
  }
  console.log(`check-transaction-callbacks self-tests: ${assertions} passed`);
  process.exit(0);
}

if (SELF_TEST) runSelfTest();

const files = [];
for (const root of SCAN_ROOTS) walk(join(BACKEND_ROOT, root), files);

const results = [];
let doubleCount = 0;
for (const f of files) {
  const text = readFileSync(f, "utf8");
  const doubles = scanFile(text);
  if (doubles.length === 0) continue;
  doubleCount += doubles.length;
  results.push({ file: relative(BACKEND_ROOT, f), doubles, verdict: fileVerdict(doubles, text) });
}

if (files.length < MIN_SPEC_FILES) {
  console.error(
    `INCONCLUSIVE — walked ${files.length} spec files (floor ${MIN_SPEC_FILES}). The walk is broken; "no void doubles" would prove nothing.`,
  );
  process.exit(2);
}
if (doubleCount < MIN_DOUBLES) {
  console.error(
    `INCONCLUSIVE — found ${doubleCount} transaction doubles (floor ${MIN_DOUBLES}). The matcher is broken.`,
  );
  process.exit(2);
}

const by = (v) => results.filter((r) => r.verdict === v);
console.log(
  `Spec files ${files.length}  ·  files with a transaction double ${results.length}  ·  doubles ${doubleCount}`,
);
console.log(
  `  invokes ${by("INVOKES").length}  ·  declared-unreached ${by("DECLARED-UNREACHED").length}  ·  rejects ${by("REJECTS").length}  ·  VOID ${by("VOID").length}`,
);

if (LIST) {
  for (const r of results.sort((a, b) => a.file.localeCompare(b.file)))
    console.log(`  ${r.verdict.padEnd(19)} ${r.file}  [${r.doubles.map((d) => `${d.line}:${d.verdict}`).join(" ")}]`);
  process.exit(0);
}

const voids = by("VOID");
if (voids.length > VOID_FILE_BASELINE) {
  console.error(
    `\nFAIL — ${voids.length} spec file(s) hold only inert transaction doubles, ${voids.length - VOID_FILE_BASELINE} above the ratchet of ${VOID_FILE_BASELINE}. Every assertion inside a transaction callback in these files is unreachable (BE/CLAUDE.md §8):`,
  );
  for (const r of voids)
    console.error(`  ${r.file}  [${r.doubles.map((d) => `${d.line}:${d.verdict}`).join(" ")}]`);
  process.exit(1);
}

console.log(
  `\nOK — every spec that doubles db.transaction either runs the callback, rejects deliberately, or asserts the transaction is never reached. VOID ${voids.length} (ratchet ${VOID_FILE_BASELINE}).`,
);
