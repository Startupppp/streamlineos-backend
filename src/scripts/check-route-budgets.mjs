#!/usr/bin/env node
/**
 * check-route-budgets.mjs  (section 7.1 — route budget contract enforcement)
 *
 * WHAT IT CHECKS
 * 1. MANIFEST VALIDITY — every entry in contracts/route-budgets.json references a real operation
 *    (method+path) in the current openapi.json. A budget for a removed route is stale; a budget for
 *    a non-existent route is a typo.
 * 2. SCHEMA VALIDITY — every entry carries the required numeric ceilings (maxDbCalls,
 *    maxDownstreamCalls, maxResponseBytes, maxLatencyP95Ms, maxMemoryMb) as non-negative integers,
 *    plus well-formed optional ceilings. A malformed entry fails rather than passing with 0.
 * 3. LINK VALIDITY — every `readCostBudgetId` resolves to a real entry in read-cost-budgets.mjs,
 *    and a declared maxBufferBlocks does not disagree with that budget's own ceiling. A dangling
 *    link is a budget that looks measured and measures nothing.
 * 4. MEASURED vs DECLARED — every populated measured* field is enforced against its ceiling.
 *
 * WHAT IT REPORTS, AND WHY THE REPORT IS THE POINT
 * The predecessor of this gate printed "no budgets exceeded" while every measured field was null,
 * which proves nothing. This one states, on every run:
 *   - declared budgets as a FRACTION of the live operation count recomputed from openapi.json, so a
 *     truncated scope cannot read as full coverage;
 *   - measurement coverage per FIELD, so a manifest with buffer numbers and no call counts cannot
 *     read as measured;
 *   - the read-cost guard's own coverage — how many of its budgets exist, and how many route
 *     budgets are actually backed by one;
 *   - OK only when every declared ceiling that has a measured counterpart is populated AND within
 *     budget. Anything less is PARTIAL. Nothing measured at all is INCONCLUSIVE.
 *
 * SELF-TEST (--self-test) proves each detection above, and proves the OK/PARTIAL/INCONCLUSIVE
 * verdict function cannot report OK over an unmeasured field.
 *
 * Usage:  node src/scripts/check-route-budgets.mjs [--self-test] [--strict]
 *         pnpm check:route-budgets
 *
 * Exit codes:
 *   0 — manifest valid, no exceedance (or self-test passed)
 *   1 — violations found, or self-test failed
 *   2 — manifest/document unreadable, or a non-OK verdict under --strict / STREAMLINE_STRICT_BUDGETS=1
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUDGETS as READ_COST_BUDGETS } from "./read-cost-budgets.mjs";

const SELF_TEST = process.argv.includes("--self-test");
// A CI job that reads only the exit code cannot tell INCONCLUSIVE or PARTIAL from OK.
// STREAMLINE_STRICT_BUDGETS=1 (or --strict) makes the distinction machine-readable.
const STRICT = process.env.STREAMLINE_STRICT_BUDGETS === "1" || process.argv.includes("--strict");
const BACKEND_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const OPENAPI_PATH = join(BACKEND_ROOT, "openapi.json");
const BUDGETS_PATH = join(BACKEND_ROOT, "contracts", "route-budgets.json");

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const REQUIRED_BUDGET_FIELDS = ["maxDbCalls", "maxDownstreamCalls", "maxResponseBytes", "maxLatencyP95Ms", "maxMemoryMb"];
const OPTIONAL_INT_FIELDS = ["maxBufferBlocks", "maxBatchSize", "maxDurationMs"];
const OPTIONAL_NUMBER_FIELDS = ["maxReadPathP95Ms"];

const MEASURED_PAIRS = [
  ["measuredDbCalls", "maxDbCalls"],
  ["measuredLatencyP95Ms", "maxLatencyP95Ms"],
  ["measuredDownstreamCalls", "maxDownstreamCalls"],
  ["measuredResponseBytes", "maxResponseBytes"],
  ["measuredMemoryMb", "maxMemoryMb"],
  ["measuredBufferBlocks", "maxBufferBlocks"],
  ["measuredReadPathP95Ms", "maxReadPathP95Ms"],
  ["measuredBatchSize", "maxBatchSize"],
  ["measuredDurationMs", "maxDurationMs"],
];

function buildLiveKeySet(document) {
  const keys = new Set();
  for (const [pathTemplate, pathItem] of Object.entries(document.paths ?? {})) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method] of Object.entries(pathItem)) {
      if (HTTP_METHODS.has(method)) keys.add(`${method.toUpperCase()} ${pathTemplate}`);
    }
  }
  return keys;
}

export function findStaleBudgetKeys(manifest, liveKeys) {
  return Object.keys(manifest.budgets ?? {}).filter((k) => !liveKeys.has(k));
}

export function findMalformedBudgetEntries(manifest) {
  const violations = [];
  for (const [key, entry] of Object.entries(manifest.budgets ?? {})) {
    for (const field of REQUIRED_BUDGET_FIELDS) {
      const val = entry[field];
      if (typeof val !== "number" || val < 0 || !Number.isInteger(val)) {
        violations.push({ key, field, value: val, issue: `${field} must be a non-negative integer, got ${JSON.stringify(val)}` });
      }
    }
    for (const field of OPTIONAL_INT_FIELDS) {
      const val = entry[field];
      if (val === undefined || val === null) continue;
      if (typeof val !== "number" || val < 0 || !Number.isInteger(val))
        violations.push({ key, field, value: val, issue: `${field} must be a non-negative integer when present, got ${JSON.stringify(val)}` });
    }
    for (const field of OPTIONAL_NUMBER_FIELDS) {
      const val = entry[field];
      if (val === undefined || val === null) continue;
      if (typeof val !== "number" || val < 0 || !Number.isFinite(val))
        violations.push({ key, field, value: val, issue: `${field} must be a non-negative number when present, got ${JSON.stringify(val)}` });
    }
  }
  return violations;
}

/**
 * A readCostBudgetId that resolves to nothing is worse than no link: the entry looks backed by a
 * measurement and is backed by nothing. A maxBufferBlocks that disagrees with the read-cost
 * budget's own ceiling is two ratchets on one number, and the looser one wins silently.
 */
export function findBrokenReadCostLinks(manifest, readCostBudgets) {
  const byId = new Map(readCostBudgets.map((b) => [b.id, b]));
  const violations = [];
  for (const [key, entry] of Object.entries(manifest.budgets ?? {})) {
    const id = entry.readCostBudgetId;
    if (id === undefined || id === null) continue;
    const rc = byId.get(id);
    if (!rc) {
      violations.push({ key, issue: `readCostBudgetId "${String(id)}" does not exist in read-cost-budgets.mjs` });
      continue;
    }
    if (typeof entry.maxBufferBlocks === "number" && entry.maxBufferBlocks !== rc.ceiling)
      violations.push({
        key,
        issue:
          `maxBufferBlocks=${String(entry.maxBufferBlocks)} disagrees with read-cost budget "${id}" ` +
          `ceiling=${String(rc.ceiling)} — one number, two ratchets`,
      });
  }
  return violations;
}

/**
 * The effective ceiling for one field.
 *
 * maxBufferBlocks deliberately falls back to the linked read-cost budget's own ceiling instead of
 * being copied into this manifest: one number, one home. Copying it would let the two drift, and
 * a drifted pair silently enforces the looser of the two (findBrokenReadCostLinks catches the
 * copy that disagrees; this resolves the copy that was never made).
 */
export function resolveCeiling(entry, maxField, defaults, readCostIndex) {
  const declared = entry[maxField];
  if (typeof declared === "number") return declared;
  if (maxField === "maxBufferBlocks" && typeof entry.readCostBudgetId === "string") {
    const rc = readCostIndex.get(entry.readCostBudgetId);
    if (rc && typeof rc.ceiling === "number") return rc.ceiling;
  }
  const fallback = defaults[maxField];
  return typeof fallback === "number" ? fallback : undefined;
}

function indexReadCost(readCostBudgets) {
  return new Map((readCostBudgets ?? []).map((b) => [b.id, b]));
}

export function findExceededBudgets(manifest, readCostBudgets = []) {
  const violations = [];
  const defaults = manifest.defaults ?? {};
  const readCostIndex = indexReadCost(readCostBudgets);

  for (const [key, entry] of Object.entries(manifest.budgets ?? {})) {
    for (const [measuredField, maxField] of MEASURED_PAIRS) {
      const measured = entry[measuredField];
      if (measured === null || measured === undefined) continue;
      const max = resolveCeiling(entry, maxField, defaults, readCostIndex);
      if (typeof measured !== "number" || typeof max !== "number") continue;
      if (measured > max) {
        violations.push({ key, measuredField, measured, max, issue: `${measuredField}=${String(measured)} exceeds ${maxField}=${String(max)}` });
      }
    }
  }
  return violations;
}

/**
 * Coverage, counted per FIELD rather than per entry.
 *
 * An entry counts a field as "declarable" when it declares that ceiling (directly or through
 * defaults, for the five required ones). It counts as measured only when the matching measured*
 * field holds a number. Per-entry counting is what let the old gate call a manifest "pending
 * measurement" as a single lump: buffer blocks measured on 50 routes and call counts measured
 * nowhere is not one state, it is two, and the difference is the whole point of this ticket.
 */
export function measurementCoverage(manifest, readCostBudgets = []) {
  const defaults = manifest.defaults ?? {};
  const readCostIndex = indexReadCost(readCostBudgets);
  const byField = {};
  let declarableTotal = 0;
  let measuredTotal = 0;
  const entriesFullyMeasured = [];
  const entriesPartlyMeasured = [];
  const entriesUnmeasured = [];

  for (const [key, entry] of Object.entries(manifest.budgets ?? {})) {
    let declarable = 0;
    let measured = 0;
    for (const [measuredField, maxField] of MEASURED_PAIRS) {
      const hasCeiling = typeof resolveCeiling(entry, maxField, defaults, readCostIndex) === "number";
      if (!hasCeiling) continue;
      declarable++;
      byField[maxField] ??= { declarable: 0, measured: 0 };
      byField[maxField].declarable++;
      if (typeof entry[measuredField] === "number") {
        measured++;
        byField[maxField].measured++;
      }
    }
    declarableTotal += declarable;
    measuredTotal += measured;
    if (measured === 0) entriesUnmeasured.push(key);
    else if (measured === declarable) entriesFullyMeasured.push(key);
    else entriesPartlyMeasured.push(key);
  }

  return {
    declarableTotal,
    measuredTotal,
    byField,
    entriesFullyMeasured,
    entriesPartlyMeasured,
    entriesUnmeasured,
  };
}

/**
 * OK is reserved for "every declared ceiling is measured and within budget". Nothing measured is
 * INCONCLUSIVE. Anything between is PARTIAL. There is deliberately no path from an unmeasured
 * field to OK — that path is the defect this gate was rewritten to remove.
 */
export function verdict({ declarableTotal, measuredTotal, exceededCount }) {
  if (exceededCount > 0) return "FAIL";
  if (declarableTotal === 0) return "INCONCLUSIVE";
  if (measuredTotal === 0) return "INCONCLUSIVE";
  if (measuredTotal < declarableTotal) return "PARTIAL";
  return "OK";
}

export function readCostGuardCoverage(manifest, readCostBudgets, totalOperations) {
  const linked = new Set();
  for (const entry of Object.values(manifest.budgets ?? {}))
    if (typeof entry.readCostBudgetId === "string") linked.add(entry.readCostBudgetId);
  const excluded = readCostBudgets.filter((b) => b.excluded).length;
  return {
    readCostBudgets: readCostBudgets.length,
    readCostExcluded: excluded,
    readCostLinked: linked.size,
    routeBudgetsBacked: Object.values(manifest.budgets ?? {}).filter((e) => typeof e.readCostBudgetId === "string").length,
    routeBudgets: Object.keys(manifest.budgets ?? {}).length,
    totalOperations,
  };
}

if (SELF_TEST) {
  process.stdout.write("Running self-test...\n");
  let failed = false;

  const pass = (label) => process.stdout.write(`  [pass] ${label}\n`);
  const fail = (label, detail) => {
    process.stderr.write(`  [FAIL] ${label}: ${detail}\n`);
    failed = true;
  };

  const liveKeys = new Set(["GET /projects", "POST /tickets"]);
  const OK_ENTRY = { maxDbCalls: 5, maxDownstreamCalls: 1, maxResponseBytes: 131072, maxLatencyP95Ms: 500, maxMemoryMb: 64 };

  const stale = findStaleBudgetKeys({ budgets: { "GET /projects": {}, "GET /old-deleted": {} } }, liveKeys);
  if (stale.length !== 1 || stale[0] !== "GET /old-deleted")
    fail("stale-key-detected", `expected ['GET /old-deleted'], got ${JSON.stringify(stale)}`);
  else pass("stale-key-detected — stale budget key not in OpenAPI is detected");

  const notStale = findStaleBudgetKeys({ budgets: { "GET /projects": {} } }, liveKeys);
  if (notStale.length !== 0) fail("live-key-passes", `expected 0 stale, got ${JSON.stringify(notStale)}`);
  else pass("live-key-passes — live budget key is not flagged as stale");

  const malformed = findMalformedBudgetEntries({ budgets: { "GET /projects": { ...OK_ENTRY, maxDbCalls: -1 } } });
  if (malformed.length !== 1 || malformed[0].field !== "maxDbCalls")
    fail("negative-value-malformed", `expected 1 malformed for maxDbCalls=-1, got ${JSON.stringify(malformed)}`);
  else pass("negative-value-malformed — maxDbCalls=-1 is flagged as malformed");

  if (findMalformedBudgetEntries({ budgets: { "GET /projects": OK_ENTRY } }).length !== 0)
    fail("well-formed-passes", "valid entry produced a malformed violation");
  else pass("well-formed-passes — valid entry produces no malformed violations");

  const bufferMalformed = findMalformedBudgetEntries({ budgets: { "GET /projects": { ...OK_ENTRY, maxBufferBlocks: -1 } } });
  if (bufferMalformed.length !== 1 || bufferMalformed[0].field !== "maxBufferBlocks")
    fail("buffer-negative-malformed", `expected 1 malformed for maxBufferBlocks=-1, got ${JSON.stringify(bufferMalformed)}`);
  else pass("buffer-negative-malformed — negative maxBufferBlocks is flagged as malformed");

  if (findMalformedBudgetEntries({ budgets: { "GET /projects": { ...OK_ENTRY, maxBufferBlocks: 8000, maxReadPathP95Ms: 20 } } }).length !== 0)
    fail("optional-fields-pass", "well-formed optional ceilings produced a violation");
  else pass("optional-fields-pass — well-formed maxBufferBlocks/maxReadPathP95Ms produce no violation");

  const rcStub = [{ id: "real-budget", ceiling: 8000 }];
  const dangling = findBrokenReadCostLinks({ budgets: { "GET /projects": { readCostBudgetId: "does-not-exist" } } }, rcStub);
  if (dangling.length !== 1) fail("dangling-link-detected", `expected 1 broken link, got ${JSON.stringify(dangling)}`);
  else pass("dangling-link-detected — a readCostBudgetId with no read-cost budget is flagged");

  const drift = findBrokenReadCostLinks({ budgets: { "GET /projects": { readCostBudgetId: "real-budget", maxBufferBlocks: 9000 } } }, rcStub);
  if (drift.length !== 1) fail("ceiling-drift-detected", `expected 1 drift violation, got ${JSON.stringify(drift)}`);
  else pass("ceiling-drift-detected — maxBufferBlocks disagreeing with the read-cost ceiling is flagged");

  if (findBrokenReadCostLinks({ budgets: { "GET /projects": { readCostBudgetId: "real-budget", maxBufferBlocks: 8000 } } }, rcStub).length !== 0)
    fail("matching-link-passes", "an agreeing link produced a violation");
  else pass("matching-link-passes — a resolvable link with an agreeing ceiling produces no violation");

  const exceeded = findExceededBudgets({ defaults: {}, budgets: { "GET /projects": { maxDbCalls: 5, measuredDbCalls: 7 } } });
  if (exceeded.length !== 1 || !exceeded[0].issue.includes("exceeds"))
    fail("exceeded-budget-bites", `expected 1 exceeded-budget violation, got ${JSON.stringify(exceeded)}`);
  else pass("exceeded-budget-bites — measured > max is detected");

  if (findExceededBudgets({ defaults: {}, budgets: { "GET /projects": { maxDbCalls: 5, measuredDbCalls: 4 } } }).length !== 0)
    fail("within-budget-passes", "measured < max produced a violation");
  else pass("within-budget-passes — measured ≤ max produces no violation");

  if (findExceededBudgets({ defaults: {}, budgets: { "GET /projects": { maxDbCalls: 5, measuredDbCalls: null } } }).length !== 0)
    fail("null-measured-skipped", "a null measured value produced a violation");
  else pass("null-measured-skipped — null measured values are skipped (not yet profiled)");

  const bufferExceeded = findExceededBudgets({ defaults: {}, budgets: { "GET /projects": { maxBufferBlocks: 8000, measuredBufferBlocks: 9500 } } });
  if (bufferExceeded.length !== 1) fail("buffer-exceeded-bites", `expected 1 buffer violation, got ${JSON.stringify(bufferExceeded)}`);
  else pass("buffer-exceeded-bites — measuredBufferBlocks > maxBufferBlocks is detected");

  const readPathExceeded = findExceededBudgets({ defaults: {}, budgets: { "GET /projects": { maxReadPathP95Ms: 20, measuredReadPathP95Ms: 34.2 } } });
  if (readPathExceeded.length !== 1) fail("read-path-exceeded-bites", `expected 1 read-path violation, got ${JSON.stringify(readPathExceeded)}`);
  else pass("read-path-exceeded-bites — measuredReadPathP95Ms > maxReadPathP95Ms is detected");

  const batchExceeded = findExceededBudgets({ defaults: {}, budgets: { "GET /cron/x": { maxBatchSize: 500, measuredBatchSize: 900 } } });
  if (batchExceeded.length !== 1) fail("batch-exceeded-bites", `expected 1 batch violation, got ${JSON.stringify(batchExceeded)}`);
  else pass("batch-exceeded-bites — a worker batch over maxBatchSize is detected");

  const halfMeasured = measurementCoverage({
    defaults: {},
    budgets: { "GET /a": { maxDbCalls: 5, maxBufferBlocks: 100, measuredBufferBlocks: 40, measuredDbCalls: null } },
  });
  if (halfMeasured.measuredTotal !== 1 || halfMeasured.declarableTotal !== 2)
    fail("coverage-counts-fields", `expected 1/2 fields measured, got ${halfMeasured.measuredTotal}/${halfMeasured.declarableTotal}`);
  else pass("coverage-counts-fields — coverage is counted per field, not per entry");

  if (verdict({ ...halfMeasured, exceededCount: 0 }) !== "PARTIAL")
    fail("partial-verdict", `expected PARTIAL for 1/2 measured, got ${verdict({ ...halfMeasured, exceededCount: 0 })}`);
  else pass("partial-verdict — a partly measured manifest reports PARTIAL, never OK");

  const noneMeasured = measurementCoverage({ defaults: {}, budgets: { "GET /a": { maxDbCalls: 5, measuredDbCalls: null } } });
  if (verdict({ ...noneMeasured, exceededCount: 0 }) !== "INCONCLUSIVE")
    fail("inconclusive-verdict", `expected INCONCLUSIVE, got ${verdict({ ...noneMeasured, exceededCount: 0 })}`);
  else pass("inconclusive-verdict — a wholly unmeasured manifest reports INCONCLUSIVE");

  const allMeasured = measurementCoverage({ defaults: {}, budgets: { "GET /a": { maxDbCalls: 5, measuredDbCalls: 3 } } });
  if (verdict({ ...allMeasured, exceededCount: 0 }) !== "OK")
    fail("ok-verdict", `expected OK for a fully measured manifest, got ${verdict({ ...allMeasured, exceededCount: 0 })}`);
  else pass("ok-verdict — OK only when every declared ceiling is measured and within budget");

  if (verdict({ ...allMeasured, exceededCount: 1 }) !== "FAIL")
    fail("fail-verdict", "an exceedance did not produce FAIL");
  else pass("fail-verdict — any exceedance produces FAIL regardless of coverage");

  const fallbackExceeded = findExceededBudgets(
    { defaults: {}, budgets: { "GET /projects": { readCostBudgetId: "real-budget", measuredBufferBlocks: 9000 } } },
    rcStub,
  );
  if (fallbackExceeded.length !== 1)
    fail("buffer-ceiling-falls-back", `expected the linked read-cost ceiling to enforce an undeclared maxBufferBlocks, got ${JSON.stringify(fallbackExceeded)}`);
  else pass("buffer-ceiling-falls-back — an undeclared maxBufferBlocks is enforced from the linked read-cost budget");

  const cov = readCostGuardCoverage(
    { budgets: { "GET /a": { readCostBudgetId: "x" }, "GET /b": {} } },
    [{ id: "x", ceiling: 1 }, { id: "y", ceiling: 1, excluded: "reason" }],
    1000,
  );
  if (cov.routeBudgetsBacked !== 1 || cov.readCostBudgets !== 2 || cov.readCostExcluded !== 1)
    fail("read-cost-coverage", `unexpected coverage ${JSON.stringify(cov)}`);
  else pass("read-cost-coverage — the read-cost guard's own coverage is computed and reportable");

  if (failed) {
    process.stderr.write("\nSELF-TEST FAILED\n");
    process.exit(1);
  }
  process.stdout.write("\nSELF-TEST PASSED\n");
  process.exit(0);
}

if (!existsSync(OPENAPI_PATH)) {
  process.stderr.write(`check-route-budgets: openapi.json not found at ${OPENAPI_PATH}\n`);
  process.exit(2);
}
if (!existsSync(BUDGETS_PATH)) {
  process.stderr.write(`check-route-budgets: route-budgets.json not found at ${BUDGETS_PATH}\n`);
  process.exit(2);
}

let document, manifest;
try {
  document = JSON.parse(readFileSync(OPENAPI_PATH, "utf8"));
} catch (err) {
  process.stderr.write(`check-route-budgets: failed to parse openapi.json: ${err.message}\n`);
  process.exit(2);
}
try {
  manifest = JSON.parse(readFileSync(BUDGETS_PATH, "utf8"));
} catch (err) {
  process.stderr.write(`check-route-budgets: failed to parse route-budgets.json: ${err.message}\n`);
  process.exit(2);
}

const liveKeys = buildLiveKeySet(document);
const totalOperations = liveKeys.size;
const stale = findStaleBudgetKeys(manifest, liveKeys);
const malformed = findMalformedBudgetEntries(manifest);
const brokenLinks = findBrokenReadCostLinks(manifest, READ_COST_BUDGETS);
const exceeded = findExceededBudgets(manifest, READ_COST_BUDGETS);
const coverage = measurementCoverage(manifest, READ_COST_BUDGETS);
const guard = readCostGuardCoverage(manifest, READ_COST_BUDGETS, totalOperations);

const entries = Object.entries(manifest.budgets ?? {});
const budgetCount = entries.length;
const routes = entries.filter(([, e]) => e.kind !== "worker-batch").length;
const workers = budgetCount - routes;
const pct = (n, d) => (d > 0 ? ((n / d) * 100).toFixed(1) : "0.0");

process.stdout.write(
  `check-route-budgets: ${String(budgetCount)} declared budgets (${String(routes)} routes + ${String(workers)} worker batches)\n`,
);
process.stdout.write(
  `  Route surface: ${String(budgetCount)}/${String(totalOperations)} operations carry a budget (${pct(budgetCount, totalOperations)}% of the live OpenAPI surface).\n`,
);
if (typeof manifest.surface?.totalOperations === "number" && manifest.surface.totalOperations !== totalOperations)
  process.stdout.write(
    `  NOTE: manifest records ${String(manifest.surface.totalOperations)} operations at the release commit; the live document has ${String(totalOperations)}. The fraction above uses the live number.\n`,
  );
process.stdout.write(
  `  Measurement: ${String(coverage.measuredTotal)}/${String(coverage.declarableTotal)} declared ceilings measured (${pct(coverage.measuredTotal, coverage.declarableTotal)}%) — ` +
    `${String(coverage.entriesFullyMeasured.length)} budgets fully measured, ${String(coverage.entriesPartlyMeasured.length)} partly, ${String(coverage.entriesUnmeasured.length)} not at all.\n`,
);
const fieldLine = Object.entries(coverage.byField)
  .map(([field, v]) => `${field.replace(/^max/, "")} ${String(v.measured)}/${String(v.declarable)}`)
  .join(" · ");
process.stdout.write(`  By field: ${fieldLine}\n`);
process.stdout.write(
  `  Read-cost guard: ${String(guard.readCostBudgets)} read-cost budgets declared (${String(guard.readCostExcluded)} excluded), ` +
    `covering ${String(guard.readCostBudgets)}/${String(totalOperations)} operations at most (${pct(guard.readCostBudgets, totalOperations)}%); ` +
    `${String(guard.routeBudgetsBacked)}/${String(budgetCount)} route budgets are backed by one (${pct(guard.routeBudgetsBacked, budgetCount)}%).\n`,
);
const basis = { "counted-call-path": 0, "declared-estimate": 0, "default-ceiling": 0, undeclared: 0 };
for (const [, e] of entries) basis[e.dbCallBasis ?? "undeclared"] = (basis[e.dbCallBasis ?? "undeclared"] ?? 0) + 1;
process.stdout.write(
  `  maxDbCalls basis: ${String(basis["counted-call-path"])} counted from the call path · ` +
    `${String(basis["declared-estimate"])} declared estimate · ${String(basis["default-ceiling"])} default ceiling · ${String(basis.undeclared)} undeclared.\n`,
);

if (stale.length > 0) {
  process.stdout.write(`  STALE BUDGETS: ${String(stale.length)} key(s) not in current OpenAPI:\n`);
  for (const k of stale) process.stdout.write(`    ${k}\n`);
}
if (malformed.length > 0) {
  process.stderr.write(`  MALFORMED: ${String(malformed.length)} budget field(s) with invalid values:\n`);
  for (const { key, issue } of malformed) process.stderr.write(`    ${key}  ${issue}\n`);
}
if (brokenLinks.length > 0) {
  process.stderr.write(`  BROKEN LINKS: ${String(brokenLinks.length)} readCostBudgetId problem(s):\n`);
  for (const { key, issue } of brokenLinks) process.stderr.write(`    ${key}  ${issue}\n`);
}
if (exceeded.length > 0) {
  process.stderr.write(`  EXCEEDED: ${String(exceeded.length)} measured value(s) above declared ceiling:\n`);
  for (const { key, issue } of exceeded) process.stderr.write(`    ${key} — ${issue}\n`);
}

const structural = stale.length + malformed.length + brokenLinks.length;
if (structural > 0) {
  process.stderr.write(`check-route-budgets: FAIL — ${String(structural)} structural violation(s) in the route budget manifest.\n`);
  process.exit(1);
}

const status = verdict({ ...coverage, exceededCount: exceeded.length });

if (status === "FAIL") {
  process.stderr.write(
    `check-route-budgets: FAIL — ${String(exceeded.length)} measured value(s) above ceiling. ` +
      `Raising a ceiling to make this green is itself a defect: fix the route or record the breach.\n`,
  );
  process.exit(1);
}

if (status === "INCONCLUSIVE") {
  process.stdout.write(
    `  INCONCLUSIVE — the manifest is valid, but no declared ceiling has a measurement, so ` +
      `"no budgets exceeded" proves nothing.\n`,
  );
  process.exit(STRICT ? 2 : 0);
}

if (status === "PARTIAL") {
  process.stdout.write(
    `  PARTIAL — ${String(coverage.measuredTotal)} of ${String(coverage.declarableTotal)} declared ceilings are measured and within budget; ` +
      `${String(coverage.declarableTotal - coverage.measuredTotal)} are unmeasured and therefore unenforced. ` +
      `This is not a pass over the route surface: ${String(budgetCount)}/${String(totalOperations)} operations carry a budget at all.\n`,
  );
  process.exit(STRICT ? 2 : 0);
}

process.stdout.write(
  `  OK — every one of ${String(coverage.declarableTotal)} declared ceilings is measured and within budget across ` +
    `${String(budgetCount)}/${String(totalOperations)} operations.\n`,
);
process.exit(0);
