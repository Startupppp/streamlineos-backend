#!/usr/bin/env node
/**
 * check-bare-throw.mjs
 *
 * Finds refusal tests that accept ANY throw.
 *
 * WHY THIS EXISTS
 * `expect(fn).toThrow()` with no argument asserts only that *something* threw.
 * On a test titled for a refusal — cross-tenant isolation, a permission denial,
 * a quota, a payment — that is not a weak assertion, it is the wrong one: a
 * mis-shaped double crashing the subject satisfies it exactly as well as the
 * refusal does, and the test is then green over a path that never reached an
 * authorization decision.
 *
 * That is not hypothetical here. Every bare `.toThrow()` in this repository was
 * triaged by EXECUTION at the commit that added this gate — each site rewritten
 * to throw against a recorder whose `Symbol.hasInstance` captured the real error
 * — and 220 positive sites produced these:
 *
 *   - calendar-series-exception-scope.spec.ts, a test named "BITE PROOF",
 *     passed on `TypeError: (intermediate value) is not iterable` — the
 *     destructure of an undefined transaction result — while its only other
 *     assertion named a `jest.fn()` wired to nothing.
 *   - employee-onboarding-tenant-isolation.spec.ts, both tests, passed on
 *     `InternalServerErrorException: Failed to link user record.` — a 500 the
 *     double produced. The same-tenant CONTROL, titled "same-tenant access
 *     works", was asserting that same-tenant onboarding rejects.
 *   - payment-test-transaction-tenant-isolation.spec.ts's control, titled
 *     "proceeds for the owning org", passed on an unrelated
 *     BadRequestException and never reached the insert, the provider order or
 *     the status update. Removing the org predicate from that update did not
 *     move it.
 *
 * WHAT FAILS THE GATE
 * A bare `.toThrow()` / `.toThrowError()` under a test or describe title that
 * claims a refusal (see RISK_RE). Nothing else.
 *
 * WHAT DELIBERATELY DOES NOT, WITH THE RULE
 *   NEGATED — `.not.toThrow()` fails on ANY throw, so it cannot be satisfied by
 *     a crash. It is the opposite shape and is excluded by construction, not by
 *     an allowlist. 150 sites.
 *   SCHEMA_PARSE — the asserted subject's call chain ends in `.parse(...)` or
 *     `.safeParse(...)`. The only reachable throw is the schema's own, so naming
 *     it adds nothing an author could get wrong. Read off the AST subject, not
 *     from a list of files. 21 sites at the ratchet commit; execution recorded
 *     ZodError at every one of them.
 *   OFF A RISK PATH — a bare throw in a formatting helper, a CLI parser or a
 *     registry lookup is noise. Those sites are COUNTED and printed as INFO but
 *     never ratcheted: banking 113 of them as an accepted number would record
 *     detector noise as debt, which is the mistake check-transaction-callbacks
 *     avoided by removing three false-positive classes BEFORE baselining.
 *   SUPPRESSED — `it.skip`/`it.todo`/`xit` bodies belong to
 *     check-test-suppressions.mjs. Counting them twice would let one gate's
 *     ratchet absorb the other's debt.
 *
 * WHAT THIS DETECTOR DOES NOT SEE (stated so the green is readable)
 *   - `.toThrow(Error)`, which is barely narrower than bare but is an argument.
 *   - A specific class that is nonetheless the WRONG one — a cross-tenant test
 *     asserting ForbiddenException passes this gate while breaking the house
 *     rule that a cross-tenant miss is 404, never 403.
 *   - A refusal asserted inside a helper the test calls.
 *   A green here means "no refusal test on a risk path accepts any throw", not
 *   "every refusal test asserts the right refusal".
 *
 * VACUITY GUARDS (this gate must not be the thing it hunts)
 *   fewer than MIN_SPEC_FILES spec files walked -> exit 2
 *   fewer than MIN_THROW_MATCHERS `.toThrow(` calls of any arity seen -> exit 2
 *   fewer than MIN_RISK_TESTS risk-titled tests classified -> exit 2
 * A walk that reaches nothing, a matcher reader that recognises nothing, or a
 * classifier that finds no risk titles would each otherwise report a clean tree.
 *
 * Usage:
 *   node src/scripts/check-bare-throw.mjs [--self-test] [--list]
 *
 * Exit codes:
 *   0 — every risk-path bare throw is registered and the ratchet did not grow
 *   1 — an unregistered site, a stale registration, or the ratchet exceeded
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
const BASELINE_PATH = path.join(HERE, "baselines", "bare-throw.json");
const SCAN_ROOTS = ["src", "test"];

const MIN_SPEC_FILES = 1500;
const MIN_THROW_MATCHERS = 500;
const MIN_RISK_TESTS = 50;

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);
const SPEC_RE = /(\.|-)(spec|test)\.(ts|tsx|mts|js|jsx)$/;

const TEST_FNS = new Set(["it", "test", "fit", "xit", "xtest"]);
const SUITE_FNS = new Set(["describe", "fdescribe", "xdescribe", "suite"]);
const SUPPRESSORS = new Set(["skip", "todo", "failing"]);

const RISK_RE =
  /(tenant|isolation|cross[- ]org|other org|another org|foreign|permission|forbidden|denied|deny|unauthori[sz]ed|authoriz|rbac|scope|acl|guard|impersonat|leak|escalat|owner|member|payment|refund|invoice|billing|credit|ledger|posting|journal|payroll|salary|payout|currency|quota|limit|entitle|seat|charge|debit|wallet|balance|reconcil|price|amount)/i;

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

function rootIdentifier(expr) {
  let cur = expr;
  for (;;) {
    if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) cur = cur.expression;
    else if (ts.isCallExpression(cur)) cur = cur.expression;
    else break;
  }
  return ts.isIdentifier(cur) ? cur.text : null;
}

function suppressorSuffixes(expr) {
  const names = [];
  let cur = expr;
  while (ts.isPropertyAccessExpression(cur) || ts.isCallExpression(cur)) {
    if (ts.isPropertyAccessExpression(cur)) names.push(cur.name.text);
    cur = cur.expression;
  }
  return names;
}

function titleOf(call) {
  const first = call.arguments[0];
  if (first === undefined) return "<no title>";
  if (ts.isStringLiteralLike(first)) return first.text;
  return first.getText().replace(/\s+/g, " ").slice(0, 120);
}

/**
 * The subject of `expect(<subject>)`, walked back from the matcher call. Used
 * only to apply the SCHEMA_PARSE rule, so it reads the chain, not the value.
 */
function expectSubject(matcherCall) {
  let cur = matcherCall.expression;
  while (ts.isPropertyAccessExpression(cur)) cur = cur.expression;
  if (!ts.isCallExpression(cur)) return null;
  const arg = cur.arguments[0];
  if (arg === undefined) return null;
  return arg;
}

function callsParse(node) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const name = n.expression.name.text;
      if (name === "parse" || name === "safeParse") {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

export function scanSource(relPath, text) {
  const src = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sites = [];
  const stack = [];
  let throwMatchers = 0;
  let riskTests = 0;
  const countedRiskTests = new Set();

  function visit(node) {
    let pushed = false;
    if (ts.isCallExpression(node)) {
      const root = rootIdentifier(node.expression);
      const isTest = root !== null && TEST_FNS.has(root);
      const isSuite = root !== null && SUITE_FNS.has(root);
      if (isTest || isSuite) {
        const suffixes = suppressorSuffixes(node.expression);
        const suppressed =
          suffixes.some((s) => SUPPRESSORS.has(s)) || root === "xit" || root === "xtest" || root === "xdescribe";
        stack.push({ kind: isTest ? "test" : "suite", title: titleOf(node), suppressed });
        pushed = true;
        if (isTest && !suppressed) {
          const titles = stack.map((f) => f.title).join(" | ");
          if (RISK_RE.test(titles) && !countedRiskTests.has(node.pos)) {
            countedRiskTests.add(node.pos);
            riskTests += 1;
          }
        }
      }

      if (ts.isPropertyAccessExpression(node.expression)) {
        const matcher = node.expression.name.text;
        if (matcher === "toThrow" || matcher === "toThrowError") {
          throwMatchers += 1;
          if (node.arguments.length === 0) {
            const chain = node.getText().replace(/\s+/g, " ");
            const negated = /\.not\s*\./.test(chain);
            const suppressed = stack.some((f) => f.suppressed);
            if (!negated && !suppressed) {
              const line = src.getLineAndCharacterOfPosition(node.expression.name.getStart(src)).line + 1;
              const titles = stack.map((f) => f.title);
              const subject = expectSubject(node);
              sites.push({
                file: relPath,
                line,
                title: [...stack].reverse().find((f) => f.kind === "test")?.title ?? "<outside a test>",
                titles: titles.join(" | "),
                risk: RISK_RE.test(titles.join(" | ")),
                schemaParse: subject !== null && callsParse(subject),
              });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
    if (pushed) stack.pop();
  }

  visit(src);
  return { sites, throwMatchers, riskTests };
}

function loadBaseline() {
  const raw = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  return {
    ratchet: raw.ratchet,
    minReasonLength: raw.minReasonLength ?? 40,
    allowed: raw.allowed ?? [],
  };
}

function run({ list }) {
  const files = SCAN_ROOTS.flatMap((r) => walk(path.join(REPO_ROOT, r)));
  const all = [];
  let throwMatchers = 0;
  let riskTests = 0;

  for (const abs of files) {
    const rel = path.relative(REPO_ROOT, abs);
    const result = scanSource(rel, fs.readFileSync(abs, "utf8"));
    all.push(...result.sites);
    throwMatchers += result.throwMatchers;
    riskTests += result.riskTests;
  }

  const bare = all.length;
  const risk = all.filter((s) => s.risk);
  const exempt = risk.filter((s) => s.schemaParse);
  const actionable = risk.filter((s) => !s.schemaParse);
  const info = all.filter((s) => !s.risk);

  console.log(
    `Spec files ${files.length}  ·  .toThrow() matchers ${throwMatchers}  ·  risk-titled tests ${riskTests}`,
  );
  console.log(
    `  bare throws ${bare}  ·  on a risk path ${risk.length}  ·  exempt SCHEMA_PARSE ${exempt.length}  ·  ACTIONABLE ${actionable.length}  ·  off a risk path (INFO, not ratcheted) ${info.length}`,
  );

  if (files.length < MIN_SPEC_FILES) {
    console.error(`INCONCLUSIVE — walked ${files.length} spec files, below the floor of ${MIN_SPEC_FILES}.`);
    return 2;
  }
  if (throwMatchers < MIN_THROW_MATCHERS) {
    console.error(
      `INCONCLUSIVE — saw ${throwMatchers} .toThrow() matchers, below the floor of ${MIN_THROW_MATCHERS}.`,
    );
    return 2;
  }
  if (riskTests < MIN_RISK_TESTS) {
    console.error(
      `INCONCLUSIVE — classified ${riskTests} risk-titled tests, below the floor of ${MIN_RISK_TESTS}.`,
    );
    return 2;
  }

  if (list) {
    for (const s of actionable) console.log(`  ACTIONABLE ${s.file}:${s.line}  ${s.title}`);
    for (const s of exempt) console.log(`  SCHEMA_PARSE ${s.file}:${s.line}  ${s.title}`);
  }

  const baseline = loadBaseline();
  const registered = new Map();
  let failed = false;

  for (const entry of baseline.allowed) {
    if (typeof entry.reason !== "string" || entry.reason.trim().length < baseline.minReasonLength) {
      console.error(`FAIL — registered entry has no usable reason: ${entry.file}:${entry.line}`);
      failed = true;
    }
    if (typeof entry.owner !== "string" || entry.owner.trim().length === 0) {
      console.error(`FAIL — registered entry has no owner: ${entry.file}:${entry.line}`);
      failed = true;
    }
    registered.set(`${entry.file}:${entry.line}`, entry);
  }

  const seen = new Set();
  for (const s of actionable) {
    const key = `${s.file}:${s.line}`;
    seen.add(key);
    if (!registered.has(key)) {
      console.error(`FAIL — unregistered bare .toThrow() on a risk path: ${key}  "${s.title}"`);
      failed = true;
    }
  }
  for (const key of registered.keys()) {
    if (!seen.has(key)) {
      console.error(`FAIL — registration no longer matches anything — remove it: ${key}`);
      failed = true;
    }
  }

  if (actionable.length > baseline.ratchet) {
    console.error(
      `FAIL — ${actionable.length} actionable site(s), ${actionable.length - baseline.ratchet} above the ratchet of ${baseline.ratchet}.`,
    );
    failed = true;
  }

  if (failed) return 1;
  console.log(
    `OK — every refusal test on a risk path names the exception it accepts, except ${actionable.length} registered site(s). Ratchet ${baseline.ratchet}; it may only go down.`,
  );
  return 0;
}

const FIXTURES = [
  {
    name: "bare toThrow under a cross-tenant title is ACTIONABLE",
    source: `describe("Svc — cross-tenant isolation", () => {
      it("hides a record from another org", async () => {
        await expect(svc.get(ATTACKER, 1)).rejects.toThrow();
      });
    });`,
    expect: (r) => r.sites.length === 1 && r.sites[0].risk && !r.sites[0].schemaParse,
  },
  {
    name: "a money title counts as a risk path",
    source: `it("refuses the payment when the invoice is not the caller's", () => {
      expect(() => svc.pay(1)).toThrow();
    });`,
    expect: (r) => r.sites.length === 1 && r.sites[0].risk,
  },
  {
    name: "the risk title may live on the enclosing describe",
    source: `describe("permission gate", () => {
      it("blows up", () => { expect(() => f()).toThrow(); });
    });`,
    expect: (r) => r.sites.length === 1 && r.sites[0].risk,
  },
  {
    name: "NOT caught: .not.toThrow() cannot be satisfied by a crash",
    source: `it("allows a member of the owning org", () => {
      expect(() => guard.canActivate(ctx)).not.toThrow();
    });`,
    expect: (r) => r.sites.length === 0,
  },
  {
    name: "NOT caught: an argument is given",
    source: `describe("cross-tenant isolation", () => {
      it("404s a foreign id", async () => {
        await expect(svc.get(ATTACKER, 1)).rejects.toThrow(NotFoundException);
      });
    });`,
    expect: (r) => r.sites.length === 0,
  },
  {
    name: "NOT caught: a message argument is given",
    source: `it("refuses the payroll lock", () => {
      expect(() => svc.lock()).toThrow("Period must be built");
    });`,
    expect: (r) => r.sites.length === 0,
  },
  {
    name: "SCHEMA_PARSE: a direct .parse() subject is exempt",
    source: `it("caps the id list so one request cannot rewrite the whole tenant", () => {
      expect(() => bulkSchema.parse({ ids: tooMany })).toThrow();
    });`,
    expect: (r) => r.sites.length === 1 && r.sites[0].risk && r.sites[0].schemaParse,
  },
  {
    name: "SCHEMA_PARSE: .safeParse() is exempt too",
    source: `it("rejects an organizationId (cross-tenant injection attempt)", () => {
      expect(() => listSchema.safeParse({ organizationId: "x" })).toThrow();
    });`,
    expect: (r) => r.sites.length === 1 && r.sites[0].schemaParse,
  },
  {
    name: "SCHEMA_PARSE does NOT swallow a service call that merely mentions a schema",
    source: `describe("cross-tenant isolation", () => {
      it("refuses a foreign org", async () => {
        await expect(service.emit(tx, { orgId: "" })).rejects.toThrow();
      });
    });`,
    expect: (r) => r.sites.length === 1 && !r.sites[0].schemaParse,
  },
  {
    name: "off a risk path: counted, never actionable",
    source: `it("throws for an unknown key", () => {
      expect(() => lookup("nope")).toThrow();
    });`,
    expect: (r) => r.sites.length === 1 && r.sites[0].risk === false,
  },
  {
    name: "a suppressed test belongs to check-test-suppressions, not here",
    source: `describe("cross-tenant isolation", () => {
      it.skip("hides a foreign record", async () => {
        await expect(svc.get(ATTACKER, 1)).rejects.toThrow();
      });
    });`,
    expect: (r) => r.sites.length === 0,
  },
  {
    name: "a suppressed describe suppresses its tests",
    source: `describe.skip("cross-tenant isolation", () => {
      it("hides a foreign record", async () => {
        await expect(svc.get(ATTACKER, 1)).rejects.toThrow();
      });
    });`,
    expect: (r) => r.sites.length === 0,
  },
  {
    name: "toThrowError with no argument is the same shape",
    source: `describe("tenant isolation", () => {
      it("refuses", () => { expect(() => f()).toThrowError(); });
    });`,
    expect: (r) => r.sites.length === 1 && r.sites[0].risk,
  },
  {
    name: "the matcher line is reported, not the start of the chain",
    source: `describe("cross-tenant isolation", () => {
  it("refuses", async () => {
    await expect(
      svc.get(ATTACKER, 1),
    ).rejects.toThrow();
  });
});`,
    expect: (r) => r.sites.length === 1 && r.sites[0].line === 5,
  },
  {
    name: "every .toThrow() is counted for the matcher floor, arguments or not",
    source: `it("a", () => { expect(f).toThrow(TypeError); });
     it("b", () => { expect(f).toThrow(); });
     it("c", () => { expect(f).not.toThrow(); });`,
    expect: (r) => r.throwMatchers === 3,
  },
  {
    name: "risk-titled tests are counted for the classifier floor",
    source: `describe("cross-tenant isolation", () => {
      it("a", () => { expect(1).toBe(1); });
      it("b", () => { expect(1).toBe(1); });
    });
    it("formats a date", () => { expect(1).toBe(1); });`,
    expect: (r) => r.riskTests === 2,
  },
];

function selfTest() {
  let passed = 0;
  let failed = 0;
  for (const fixture of FIXTURES) {
    let ok = false;
    let detail = "";
    try {
      const result = scanSource("fixture.spec.ts", fixture.source);
      ok = fixture.expect(result) === true;
      if (!ok) detail = JSON.stringify({ sites: result.sites, throwMatchers: result.throwMatchers, riskTests: result.riskTests });
    } catch (error) {
      detail = String(error);
    }
    if (ok) passed += 1;
    else {
      failed += 1;
      console.error(`  FAIL ${fixture.name}${detail ? `\n       ${detail}` : ""}`);
    }
  }
  console.log(`check-bare-throw self-test: ${passed} passed, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

const args = process.argv.slice(2);
process.exit(args.includes("--self-test") ? selfTest() : run({ list: args.includes("--list") }));
