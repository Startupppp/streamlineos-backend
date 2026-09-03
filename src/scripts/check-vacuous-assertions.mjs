#!/usr/bin/env node
/**
 * check-vacuous-assertions.mjs
 *
 * Finds tests that CANNOT FAIL.
 *
 * WHY THIS EXISTS
 * A skipped test is honest about not running; `check-test-suppressions.mjs`
 * owns that distinction. This gate owns the opposite and more dangerous shape:
 * a test that RUNS, is GREEN, is counted as coverage, and asserts nothing that
 * could ever be false. Measured at the commit that added this gate, seven such
 * tests were live in this repository and four of them named cross-tenant
 * isolation in their own title:
 *
 *   - org-setup-tenant-isolation.spec.ts asserted org isolation behind
 *     `if (memberWhere.mock.calls.length > 0)`. The guard was false: the db
 *     double answered `select().from().where()` while the service calls
 *     `.leftJoin()`, so skipSetup died on a TypeError that a bare `catch {}`
 *     swallowed under the comment "expected - missing membership".
 *   - tax-compliance-tenant-isolation.spec.ts had the same guard with
 *     `else { expect(true).toBe(true); }`. The guard was false because
 *     checkTaxDue returns [] before any query on every day of the year.
 *   - calendar-conflict.service.spec.ts's isolation test called the service
 *     and ended, with no assertion of any kind.
 *   - notification-time-sweeps asserted `expect(wheres.length)
 *     .toBeGreaterThanOrEqual(0)`, which is true of every array.
 *
 * Every one of those was green, and none of them could be made red by deleting
 * the org predicate they claimed to protect.
 *
 * CLASSES
 *   NO_ASSERTION    a test body with no expect(), no supertest `.expect(`, no
 *                   `throw`, and no assert-shaped helper call. Nothing in it
 *                   can fail.
 *   TAUTOLOGY       `expect(<literal>).toBe(<the same literal>)`,
 *                   `expect(<truthy literal>).toBeDefined()/toBeTruthy()`, or
 *                   `expect(<falsy literal>).toBeFalsy()`.
 *   COND_ASSERT     every assertion in the body sits inside
 *                   `if (<reach guard>) { ... }` — a guard on `.length` or
 *                   `.mock.calls`, i.e. on whether the double was reached — and
 *                   the else branch is absent or vacuous. If the double is
 *                   mis-shaped the guard is false and the test asserts nothing.
 *                   THIS IS THE HIGHEST-YIELD CLASS: it is indistinguishable
 *                   from a passing test in every report.
 *   EARLY_RETURN    COND_ASSERT's other syntax, and the one this gate was blind
 *                   to until 2026-09-03: `it("...", () => { if (!x) return; ...
 *                   expect(...) })`. Every assertion below the guard is
 *                   conditional on it, exactly as if it were nested inside an
 *                   `if`, but the AST shape is different so the COND_ASSERT
 *                   detector never saw it. Four sites were live when the class
 *                   was added and one of them mattered:
 *                   recruitment-candidate-vault.spec.ts's "keeps the document
 *                   reference tenant-scoped" guarded on a SOURCE-TEXT scan
 *                   (`lines.find(l => l.includes("foreignKey(") && ...)`), so
 *                   removing the tenant column from that composite foreign key
 *                   and letting Prettier wrap the declaration left the test
 *                   GREEN — measured, not argued.
 *                   Only a guard ABOVE every assertion in the body counts: a
 *                   `return` after the assertions have run cannot silence them.
 *   FLOATING_ASSERT `expect(p).resolves/.rejects.<matcher>(...)` that is neither
 *                   awaited nor returned. The assertion settles after the test
 *                   has already passed.
 *   FOCUSED         `it.only` / `describe.only` / `fit` / `fdescribe`, which
 *                   silently drops every sibling test from the run.
 *
 * DELIBERATELY NOT CLASSES HERE, WITH THE REASON
 *   Suppressions (`it.skip`, `it.todo`, `xit`) are excluded outright: those are
 *   `check-test-suppressions.mjs`'s registry, and counting them twice would let
 *   one gate's ratchet absorb the other's debt.
 *   A bare `.toThrow()` with no argument is NOT failed here. It is a real risk —
 *   rewriting all 44 of them in the isolation suite to `.toThrow(TypeError)`
 *   left 2 still green, both asserting a crash rather than a refusal — but 333
 *   sites is a triage backlog, not a ratchet, and most are legitimate.
 *   Recorded in reports/35e-vacuity-sweep-s13.md, not gated.
 *
 * WHAT THIS DETECTOR DOES NOT SEE (stated so the green is readable)
 *   - A test whose assertions are real but assert the wrong thing.
 *   - An assertion on a mock the test itself invoked.
 *   - `expect(x).toEqual(y)` where both sides come from the same broken source.
 *   - Anything inside a helper the test calls.
 *   A green here means "every test can fail for some reason", not "every test
 *   tests what its title says".
 *
 * DETECTION
 * TypeScript AST (ts.createSourceFile), not regex: `calleeText` has to resolve
 * `request(app).get(url).expect(403)` to a supertest assertion rather than to a
 * bare `expect`, and has to brace-match test bodies. A regex misclassified both
 * in the prototype.
 *
 * VACUITY GUARDS (this gate must not be the thing it hunts)
 *   fewer than MIN_SPEC_FILES spec files walked -> exit 2
 *   fewer than MIN_TEST_CALLBACKS test bodies parsed -> exit 2
 *   fewer than MIN_EXPECTS expect() calls seen -> exit 2
 * A walk that reaches nothing otherwise reports a clean tree, which is the
 * failure mode this release exists to remove.
 *
 * SELF-TEST (--self-test)
 * Plants one fixture per class and asserts it is caught, AND plants the three
 * shapes that fooled the prototype and asserts they are NOT caught: a supertest
 * `.expect(403)` chain, a body that asserts by `throw`, and a conditional whose
 * real assertions sit outside the `if`.
 *
 * Usage:
 *   node src/scripts/check-vacuous-assertions.mjs [--self-test] [--list]
 *
 * Exit codes:
 *   0 — every vacuous site is registered and no ratchet grew
 *   1 — an unregistered site, a stale registration, or a ratchet exceeded
 *   2 — the scan could not measure anything (INCONCLUSIVE)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const ts = require_("typescript");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const BASELINE_PATH = path.join(HERE, "baselines", "vacuous-assertions.json");
const SCAN_ROOTS = ["src", "test"];

const MIN_SPEC_FILES = 1500;
const MIN_TEST_CALLBACKS = 8000;
const MIN_EXPECTS = 20000;

const CLASSES = [
  "NO_ASSERTION",
  "TAUTOLOGY",
  "COND_ASSERT",
  "EARLY_RETURN",
  "FLOATING_ASSERT",
  "FOCUSED",
];

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);
const SPEC_RE = /(\.|-)(spec|test)\.(ts|tsx|mts|js|jsx)$/;

const TEST_FNS = new Set(["it", "test", "fit", "xit", "xtest"]);
const SUITE_FNS = new Set(["describe", "fdescribe", "xdescribe", "suite"]);
const SUPPRESSORS = ["skip", "todo", "failing"];

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (SPEC_RE.test(entry.name)) out.push(path.join(dir, entry.name));
  }
  return out;
}

function calleeText(node) {
  let expr = node.expression;
  const parts = [];
  while (ts.isPropertyAccessExpression(expr)) {
    parts.unshift(expr.name.text);
    expr = expr.expression;
  }
  if (ts.isCallExpression(expr))
    return calleeText(expr) + "()" + (parts.length ? "." + parts.join(".") : "");
  if (ts.isIdentifier(expr)) parts.unshift(expr.text);
  else return "<expr>";
  return parts.join(".");
}

function isLiteralish(node) {
  return (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(node) && node.text === "undefined")
  );
}

function matcherChain(expectCall) {
  let cur = expectCall;
  const parts = [];
  let isAsyncMatcher = false;
  while (cur.parent && ts.isPropertyAccessExpression(cur.parent) && cur.parent.expression === cur) {
    const name = cur.parent.name.text;
    parts.push(name);
    if (name === "resolves" || name === "rejects") isAsyncMatcher = true;
    cur = cur.parent;
    if (cur.parent && ts.isCallExpression(cur.parent) && cur.parent.expression === cur)
      return {
        matcher: parts.filter((p) => p !== "not").join("."),
        call: cur.parent,
        isAsyncMatcher,
      };
  }
  return { matcher: null, call: null, isAsyncMatcher };
}

function isAwaitedOrReturned(call) {
  let parent = call.parent;
  while (parent && ts.isParenthesizedExpression(parent)) parent = parent.parent;
  if (!parent) return false;
  return (
    ts.isAwaitExpression(parent) ||
    ts.isReturnStatement(parent) ||
    ts.isArrowFunction(parent) ||
    ts.isArrayLiteralExpression(parent) ||
    ts.isPropertyAccessExpression(parent) ||
    ts.isVariableDeclaration(parent)
  );
}

function testBody(callNode) {
  for (const arg of callNode.arguments ?? [])
    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) return arg;
  return null;
}

const OTHER_ASSERT = /^(assert|ok|strictEqual|deepStrictEqual|fail|throws|doesNotThrow)$/;

const SENTINEL_CACHE = new WeakMap();

/**
 * Identifiers this file asserts on OUTSIDE the given test body. "Outside" is
 * load-bearing: a guard's own identifier almost always appears in the
 * assertions it guards, so crediting those would exempt every early return
 * including the real ones.
 */
function sentinelAsserted(sf, exclude) {
  let byFile = SENTINEL_CACHE.get(sf);
  if (!byFile) {
    byFile = [];
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "expect"
      ) {
        const names = new Set();
        const collect = (n) => {
          if (ts.isIdentifier(n)) names.add(n.text);
          ts.forEachChild(n, collect);
        };
        for (const arg of node.arguments) collect(arg);
        byFile.push({ start: node.getStart(sf), end: node.getEnd(), names });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    SENTINEL_CACHE.set(sf, byFile);
  }
  const lo = exclude.getStart(sf);
  const hi = exclude.getEnd();
  const out = new Set();
  for (const e of byFile) {
    if (e.start >= lo && e.end <= hi) continue;
    for (const n of e.names) out.add(n);
  }
  return out;
}

function analyseBody(fn, sf, counters) {
  let expectCount = 0;
  let hasOtherAssertion = false;
  const tautologies = [];
  const floating = [];
  const conditional = [];

  const visit = (node) => {
    if (ts.isThrowStatement(node)) hasOtherAssertion = true;

    if (ts.isIfStatement(node)) {
      const condText = node.expression.getText(sf);
      const thenHasExpect = /\bexpect\s*\(/.test(node.thenStatement.getText(sf));
      const elseText = node.elseStatement ? node.elseStatement.getText(sf) : "";
      const elseVacuous =
        !node.elseStatement ||
        /^\{?\s*expect\((true|1|\[\]|\{\})\)\.(toBe|toEqual)\(/.test(
          elseText.replace(/^\{\s*/, "").trim(),
        );
      const reachGuard =
        /\.length\s*(>|>=|!==|===|==)?/.test(condText) ||
        /\.mock\.calls/.test(condText) ||
        /toHaveBeenCalled/.test(condText);
      // A bare `if (guard) { expect(...) }` is vacuous only when NOTHING else in
      // the body asserts. lib/renderer/registry.test.ts asserts for every record
      // and only guards a list-specific extra: a data case, not a reach guard.
      let noSiblingAssertion = true;
      if (!node.elseStatement) {
        const bodyText = fn.getText(sf);
        const start = fn.getStart(sf);
        const before = bodyText.slice(0, node.getStart(sf) - start);
        const after = bodyText.slice(node.getEnd() - start);
        noSiblingAssertion = !/\bexpect\s*\(/.test(before) && !/\bexpect\s*\(/.test(after);
      }
      if (thenHasExpect && elseVacuous && reachGuard && noSiblingAssertion)
        conditional.push({ node, detail: `if (${condText.slice(0, 70)})` });
    }

    if (ts.isCallExpression(node)) {
      const ct = calleeText(node);
      const base = ct.split(".")[0].replace("()", "");
      if (base === "expect") {
        expectCount += 1;
        counters.expects += 1;
        const arg = node.arguments?.[0];
        const chain = matcherChain(node);
        if (arg && isLiteralish(arg) && chain.matcher && chain.call) {
          const m = chain.matcher;
          const first = chain.call.arguments[0];
          const same = first && first.getText(sf).trim() === arg.getText(sf).trim();
          const truthy =
            arg.kind === ts.SyntaxKind.TrueKeyword ||
            (ts.isNumericLiteral(arg) && arg.text !== "0") ||
            (ts.isStringLiteral(arg) && arg.text !== "");
          if (
            (/^(toBe|toEqual|toStrictEqual)$/.test(m) && same) ||
            (/^(toBeDefined|toBeTruthy)$/.test(m) && truthy) ||
            (/^toBeFalsy$/.test(m) && !truthy)
          )
            tautologies.push({
              node,
              detail: `expect(${arg.getText(sf).slice(0, 30)}).${m}(...)`,
            });
        }
        if (chain.isAsyncMatcher && chain.call && !isAwaitedOrReturned(chain.call))
          floating.push({ node: chain.call, detail: chain.matcher ?? "resolves/rejects" });
      } else if (
        /(^|\.)expect$/.test(ct) ||
        OTHER_ASSERT.test(base) ||
        ct.includes("toMatchInlineSnapshot") ||
        (!TEST_FNS.has(base) && !SUITE_FNS.has(base) && /assert|expect|verify|check/i.test(base))
      )
        hasOtherAssertion = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body ?? fn);

  // EARLY_RETURN: a bare `if (guard) return;` at the top level of the body,
  // with no else, standing ABOVE every assertion. Scanned over the body's own
  // statement list rather than the whole subtree, so a guard inside a nested
  // helper or a loop is not counted.
  const earlyReturns = [];
  if (fn.body && ts.isBlock(fn.body)) {
    let sawAssertion = false;
    for (const st of fn.body.statements) {
      if (!sawAssertion && ts.isIfStatement(st) && !st.elseStatement) {
        const t = st.thenStatement;
        const bare =
          (ts.isReturnStatement(t) && !t.expression) ||
          (ts.isBlock(t) &&
            t.statements.length === 1 &&
            ts.isReturnStatement(t.statements[0]) &&
            !t.statements[0].expression);
        if (bare)
          earlyReturns.push({
            node: st,
            detail: `if (${st.expression.getText(sf).slice(0, 70)}) return;`,
          });
      }
      const text = st.getText(sf);
      if (/\bexpect\s*\(/.test(text) || /\bthrow\b/.test(text)) sawAssertion = true;
    }
    // A guard that silences nothing is not a defect: require at least one
    // assertion somewhere below it.
    if (!/\bexpect\s*\(/.test(fn.getText(sf))) earlyReturns.length = 0;

    // SENTINEL EXEMPTION. A guard whose own identifier is asserted by a sibling
    // test in the same file is not an escape hatch: the file goes red when the
    // guard is false, so the guarded tests cannot pass while asserting nothing.
    // This is not hypothetical — it is why this class reports 0 here and not 11.
    // The frontend's two cross-repo permission-catalog suites guard 11 tests on
    // `if (!backendAvailable) return;` and each carries
    //   it("can reach the backend catalog — the cross-repo checks below assert
    //      nothing without it", () => { expect({ backendAvailable, ... })
    //        .toEqual({ backendAvailable: true, ... }); });
    // Flagging those would have banked 11 sites of detector noise as debt.
    for (let i = earlyReturns.length - 1; i >= 0; i -= 1) {
      const ids = [];
      const collect = (n) => {
        if (ts.isIdentifier(n)) ids.push(n.text);
        ts.forEachChild(n, collect);
      };
      collect(earlyReturns[i].node.expression);
      const outside = sentinelAsserted(sf, fn);
      if (ids.some((id) => outside.has(id))) earlyReturns.splice(i, 1);
    }
  }

  return { expectCount, hasOtherAssertion, tautologies, floating, conditional, earlyReturns };
}

function scanFile(file, rel, counters, findings) {
  const src = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const titleOf = (node) => {
    const a = node.arguments?.[0];
    if (!a) return "";
    if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) return a.text.slice(0, 110);
    return "<non-literal>";
  };
  const push = (cls, node, testNode, detail) =>
    findings.push({ cls, file: rel, line: lineOf(node), title: titleOf(testNode), detail });

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const ct = calleeText(node);
      const mods = ct.split(".").slice(1);
      const base = ct.split(".")[0].replace("()", "");
      const isTest = TEST_FNS.has(base);
      const isSuite = SUITE_FNS.has(base);
      const suppressed =
        SUPPRESSORS.some((s) => mods.includes(s)) || base.startsWith("x");

      if ((isTest || isSuite) && (mods.includes("only") || base === "fit" || base === "fdescribe"))
        push("FOCUSED", node, node, ct);

      // Suppressed tests belong to check-test-suppressions.mjs, not here.
      if (isTest && !suppressed) {
        const body = testBody(node);
        if (body) {
          counters.testCallbacks += 1;
          const s = analyseBody(body, sf, counters);
          if (s.expectCount === 0 && !s.hasOtherAssertion)
            push("NO_ASSERTION", node, node, "no expect(), no throw, no assert helper");
          for (const t of s.tautologies) push("TAUTOLOGY", t.node, node, t.detail);
          for (const t of s.conditional) push("COND_ASSERT", t.node, node, t.detail);
          for (const t of s.earlyReturns) push("EARLY_RETURN", t.node, node, t.detail);
          for (const t of s.floating) push("FLOATING_ASSERT", t.node, node, t.detail);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function scanTree(root, roots) {
  const counters = { expects: 0, testCallbacks: 0 };
  const findings = [];
  const files = [];
  for (const r of roots) walk(path.join(root, r), files);
  for (const file of files) scanFile(file, path.relative(root, file), counters, findings);
  return { files, findings, counters };
}

// ---------------------------------------------------------------- self-test
const FIXTURES = {
  "caught.spec.ts": `
describe("caught", () => {
  it("A no assertion", () => { const x = 1; void x; });
  it("B tautology", () => { expect(true).toBe(true); });
  it("C conditional with vacuous else", () => {
    const wheres: unknown[] = [];
    if (wheres.length > 0) { expect(wheres).toContain("x"); } else { expect(true).toBe(true); }
  });
  it("D conditional with no else", () => {
    const spy = { mock: { calls: [] as unknown[] } };
    if (spy.mock.calls.length > 0) { expect(spy.mock.calls[0]).toBe(1); }
  });
  it("E floating rejects", () => { expect(Promise.reject(new Error())).rejects.toThrow(TypeError); });
  it("N early return above the assertions", () => {
    const found = ["a"].find((x) => x === "b");
    if (!found) return;
    expect(found).toContain("b");
  });
  it.only("F focused", () => { expect(1).toBe(2); });
});
`,
  "not-caught.spec.ts": `
describe("not caught", () => {
  it("U sentinel: the guard itself is asserted by this sibling", () => {
    expect({ backendAvailable }).toEqual({ backendAvailable: true });
  });
  it("V sentinel-protected guard is NOT an escape hatch", () => {
    if (!backendAvailable) return;
    expect(catalog).toContain("x");
  });
  it("G supertest expect is an assertion", async () => {
    await request(app.getHttpServer()).get("/x").expect(403);
  });
  it("H throw is an assertion", () => {
    for (const s of items) if (!s.ok) throw new Error("bad " + s.key);
  });
  it("I guarded extra with real assertions outside the if", () => {
    const layout = { list: { columns: [] as unknown[] }, singular: "a" };
    expect(layout.singular).not.toBe("");
    if (layout.list.columns.length > 0) { expect(layout.list.columns[0]).toBeDefined(); }
  });
  it("J skipped tests belong to check:test-suppressions", () => { expect(1).toBe(1); });
  it.skip("K skipped and empty", () => {});
  it.skip("L skipped holding assertions", () => { expect(true).toBe(true); });
  it("M awaited rejects is fine", async () => {
    await expect(Promise.reject(new Error("z"))).rejects.toThrow(TypeError);
  });
  it("O a return BELOW the assertions silences nothing", () => {
    expect(1).toBe(1);
    if (!ready) return;
    expect(2).toBe(2);
  });
  it("P an early return with an else branch is a real two-way test", () => {
    if (!found) { expect(fallback).toBe(1); } else { expect(found).toBe(2); }
  });
  it("Q a guard with no assertion anywhere below it is not this class", () => {
    if (!found) return;
    doSomething();
  });
});
`,
};

function selfTest() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "vacuity-selftest-"));
  const specDir = path.join(dir, "src");
  fs.mkdirSync(specDir, { recursive: true });
  for (const [name, body] of Object.entries(FIXTURES))
    fs.writeFileSync(path.join(specDir, name), body);

  const { findings } = scanTree(dir, ["src"]);
  const none = (title, cls) => !findings.some((f) => f.title === title && f.cls === cls);
  const at = (file, title, cls) =>
    findings.some((f) => f.file.endsWith(file) && f.title === title && f.cls === cls);

  const checks = [
    ["A is NO_ASSERTION", at("caught.spec.ts", "A no assertion", "NO_ASSERTION")],
    ["B is TAUTOLOGY", at("caught.spec.ts", "B tautology", "TAUTOLOGY")],
    ["C is COND_ASSERT", at("caught.spec.ts", "C conditional with vacuous else", "COND_ASSERT")],
    ["D is COND_ASSERT", at("caught.spec.ts", "D conditional with no else", "COND_ASSERT")],
    ["E is FLOATING_ASSERT", at("caught.spec.ts", "E floating rejects", "FLOATING_ASSERT")],
    ["F is FOCUSED", at("caught.spec.ts", "F focused", "FOCUSED")],
    [
      "G supertest .expect() is NOT NO_ASSERTION",
      !at("not-caught.spec.ts", "G supertest expect is an assertion", "NO_ASSERTION"),
    ],
    [
      "H throw-as-assertion is NOT NO_ASSERTION",
      !at("not-caught.spec.ts", "H throw is an assertion", "NO_ASSERTION"),
    ],
    [
      "I guarded extra with assertions outside is NOT COND_ASSERT",
      !at(
        "not-caught.spec.ts",
        "I guarded extra with real assertions outside the if",
        "COND_ASSERT",
      ),
    ],
    [
      "K a skipped empty test is NOT reported (check:test-suppressions owns it)",
      !findings.some((f) => f.title === "K skipped and empty"),
    ],
    [
      "L a skipped test holding a tautology is NOT reported here",
      !findings.some((f) => f.title === "L skipped holding assertions"),
    ],
    [
      "M an awaited rejects is NOT FLOATING_ASSERT",
      !at("not-caught.spec.ts", "M awaited rejects is fine", "FLOATING_ASSERT"),
    ],
    [
      "V a guard asserted by a SIBLING test is NOT EARLY_RETURN (sentinel)",
      none("V sentinel-protected guard is NOT an escape hatch", "EARLY_RETURN"),
    ],
    ["N is EARLY_RETURN", at("caught.spec.ts", "N early return above the assertions", "EARLY_RETURN")],
    [
      "O a return BELOW the assertions is NOT EARLY_RETURN",
      !at("not-caught.spec.ts", "O a return BELOW the assertions silences nothing", "EARLY_RETURN"),
    ],
    [
      "P an if/else is NOT EARLY_RETURN",
      !at("not-caught.spec.ts", "P an early return with an else branch is a real two-way test", "EARLY_RETURN"),
    ],
    [
      "Q a guard with nothing to silence is NOT EARLY_RETURN",
      !at("not-caught.spec.ts", "Q a guard with no assertion anywhere below it is not this class", "EARLY_RETURN"),
    ],
    ["the fixture tree produced findings at all", findings.length > 0],
    [
      "every finding carries a class this gate knows",
      findings.every((f) => CLASSES.includes(f.cls)),
    ],
    ["every finding carries a line number", findings.every((f) => f.line > 0)],
  ];

  // The floors must themselves fire.
  const tiny = scanTree(dir, ["src"]);
  checks.push(["the spec-file floor would reject this fixture tree", tiny.files.length < MIN_SPEC_FILES]);

  fs.rmSync(dir, { recursive: true, force: true });

  let failed = 0;
  for (const [name, ok] of checks) {
    if (!ok) {
      failed += 1;
      console.error(`  FAIL  ${name}`);
    }
  }
  console.log(
    `check-vacuous-assertions self-test: ${checks.length - failed} passed, ${failed} failed`,
  );
  return failed === 0 ? 0 : 1;
}

// ---------------------------------------------------------------- main
function main() {
  if (process.argv.includes("--self-test")) process.exit(selfTest());

  const { files, findings, counters } = scanTree(REPO_ROOT, SCAN_ROOTS);

  if (files.length < MIN_SPEC_FILES) {
    console.error(
      `INCONCLUSIVE — walked ${files.length} spec files, below the floor of ${MIN_SPEC_FILES}. The scan did not reach the tree; this is not a clean result.`,
    );
    process.exit(2);
  }
  if (counters.testCallbacks < MIN_TEST_CALLBACKS) {
    console.error(
      `INCONCLUSIVE — parsed ${counters.testCallbacks} test callbacks, below the floor of ${MIN_TEST_CALLBACKS}. The test-callback matcher measured nothing.`,
    );
    process.exit(2);
  }
  if (counters.expects < MIN_EXPECTS) {
    console.error(
      `INCONCLUSIVE — saw ${counters.expects} expect() calls, below the floor of ${MIN_EXPECTS}. The assertion matcher measured nothing.`,
    );
    process.exit(2);
  }

  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  const allowed = new Map(
    baseline.allowed.map((entry) => [`${entry.file}::${entry.title}::${entry.class}`, entry]),
  );

  if (process.argv.includes("--list")) {
    for (const f of findings)
      console.log(`${f.cls}\t${f.file}:${f.line}\t${f.title}\t${f.detail}`);
  }

  const seen = new Set();
  const unregistered = [];
  for (const f of findings) {
    const key = `${f.file}::${f.title}::${f.cls}`;
    if (allowed.has(key)) seen.add(key);
    else unregistered.push(f);
  }
  const stale = [...allowed.keys()].filter((k) => !seen.has(k));

  const counts = Object.fromEntries(
    CLASSES.map((c) => [c, findings.filter((f) => f.cls === c).length]),
  );

  console.log(
    `Spec files ${files.length}  ·  test callbacks ${counters.testCallbacks}  ·  expect() calls ${counters.expects}`,
  );
  console.log(
    `  ${CLASSES.map((c) => `${c.toLowerCase()} ${counts[c]}`).join("  ·  ")}  (registered ${baseline.allowed.length})`,
  );

  let rc = 0;
  if (unregistered.length > 0) {
    rc = 1;
    console.error(
      `\n${unregistered.length} vacuous test(s) are not registered in ${path.relative(REPO_ROOT, BASELINE_PATH)}:`,
    );
    for (const f of unregistered)
      console.error(`  ${f.cls}  ${f.file}:${f.line}\n      "${f.title}"\n      ${f.detail}`);
    console.error(
      `\nA test in one of these classes cannot fail. Give it a real assertion. Registering it instead requires a reason of at least ${baseline.minReasonLength} characters, and the ratchet may only go down.`,
    );
  }
  if (stale.length > 0) {
    rc = 1;
    console.error(`\n${stale.length} registered entr(y/ies) no longer match anything — remove them:`);
    for (const k of stale) console.error(`  ${k}`);
  }
  for (const entry of baseline.allowed) {
    if (!entry.reason || entry.reason.length < baseline.minReasonLength) {
      rc = 1;
      console.error(
        `\nRegistered entry has no usable reason (min ${baseline.minReasonLength} chars): ${entry.file} :: ${entry.title}`,
      );
    }
    if (!CLASSES.includes(entry.class)) {
      rc = 1;
      console.error(`\nRegistered entry names an unknown class '${entry.class}': ${entry.file}`);
    }
  }
  for (const cls of CLASSES) {
    const ratchet = baseline.ratchets[cls];
    if (typeof ratchet !== "number") {
      console.error(`\nNo ratchet declared for class ${cls}.`);
      rc = 1;
      continue;
    }
    if (counts[cls] > ratchet) {
      rc = 1;
      console.error(
        `\n${cls}: ${counts[cls]} site(s), ${counts[cls] - ratchet} above the ratchet of ${ratchet}.`,
      );
    }
  }

  if (rc === 0)
    console.log(
      `OK — every test that runs can fail, except ${baseline.allowed.length} registered site(s), each within its ratchet.`,
    );
  process.exit(rc);
}

main();
