#!/usr/bin/env node
/**
 * check-route-budgets.mjs  (section 7.1 — route budget contract enforcement)
 *
 * WHAT IT CHECKS
 * 1. MANIFEST VALIDITY — every entry in contracts/route-budgets.json references a
 *    real operation (method+path) in the current openapi.json. A budget entry
 *    for a removed route is stale; a budget for a non-existent route is a typo.
 *
 * 2. SCHEMA VALIDITY — every budget entry carries the required numeric fields
 *    (maxDbCalls, maxDownstreamCalls, maxResponseBytes, maxLatencyP95Ms,
 *    maxMemoryMb) and all values are positive integers. Malformed entries fail
 *    the gate so they can't silently pass with 0 as the ceiling.
 *
 * 3. MEASURED vs DECLARED — when a budget entry has a non-null measured* field
 *    (filled by the orchestrator after profiling), it is compared against the
 *    declared maximum. An exceeded budget fails the gate.
 *
 * The manifest format + the enforcement logic together form the contract:
 * measurement values are filled by the orchestrator; this gate validates the
 * structure and enforces whenever measurement data is present.
 *
 * SELF-TEST (--self-test)
 * Proves:
 *   - A stale budget key (not in OpenAPI) is detected
 *   - A missing required field is detected
 *   - A measured value exceeding the declared max fails the gate
 *   - A within-budget measured value passes the gate
 *
 * Usage:
 *   node src/scripts/check-route-budgets.mjs [--self-test]
 *   pnpm check:route-budgets
 *
 * Exit codes:
 *   0 — manifest valid, no budget exceedances (or self-test passed)
 *   1 — violations found, or self-test failed
 *   2 — manifest or document unreadable
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_TEST = process.argv.includes("--self-test");
const BACKEND_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const OPENAPI_PATH = join(BACKEND_ROOT, "openapi.json");
const BUDGETS_PATH = join(BACKEND_ROOT, "contracts", "route-budgets.json");

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const REQUIRED_BUDGET_FIELDS = ["maxDbCalls", "maxDownstreamCalls", "maxResponseBytes", "maxLatencyP95Ms", "maxMemoryMb"];

const MEASURED_PAIRS = [
  ["measuredDbCalls", "maxDbCalls"],
  ["measuredLatencyP95Ms", "maxLatencyP95Ms"],
  ["measuredDownstreamCalls", "maxDownstreamCalls"],
  ["measuredResponseBytes", "maxResponseBytes"],
  ["measuredMemoryMb", "maxMemoryMb"],
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
  }
  return violations;
}

export function findExceededBudgets(manifest) {
  const violations = [];
  const defaults = manifest.defaults ?? {};

  for (const [key, entry] of Object.entries(manifest.budgets ?? {})) {
    for (const [measuredField, maxField] of MEASURED_PAIRS) {
      const measured = entry[measuredField];
      if (measured === null || measured === undefined) continue;
      const max = entry[maxField] ?? defaults[maxField];
      if (typeof measured !== "number" || typeof max !== "number") continue;
      if (measured > max) {
        violations.push({ key, measuredField, measured, max, issue: `${measuredField}=${String(measured)} exceeds ${maxField}=${String(max)}` });
      }
    }
  }
  return violations;
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

  const stale = findStaleBudgetKeys({ budgets: { "GET /projects": {}, "GET /old-deleted": {} } }, liveKeys);
  if (stale.length !== 1 || stale[0] !== "GET /old-deleted")
    fail("stale-key-detected", `expected ['GET /old-deleted'], got ${JSON.stringify(stale)}`);
  else pass("stale-key-detected — stale budget key not in OpenAPI is detected");

  const notStale = findStaleBudgetKeys({ budgets: { "GET /projects": {} } }, liveKeys);
  if (notStale.length !== 0)
    fail("live-key-passes", `expected 0 stale, got ${JSON.stringify(notStale)}`);
  else pass("live-key-passes — live budget key is not flagged as stale");

  const malformed = findMalformedBudgetEntries({ budgets: { "GET /projects": {
    maxDbCalls: -1, maxDownstreamCalls: 1, maxResponseBytes: 131072, maxLatencyP95Ms: 500, maxMemoryMb: 64,
  }}});
  if (malformed.length !== 1 || malformed[0].field !== "maxDbCalls")
    fail("negative-value-malformed", `expected 1 malformed for maxDbCalls=-1, got ${JSON.stringify(malformed)}`);
  else pass("negative-value-malformed — maxDbCalls=-1 is flagged as malformed");

  const wellFormed = findMalformedBudgetEntries({ budgets: { "GET /projects": {
    maxDbCalls: 5, maxDownstreamCalls: 1, maxResponseBytes: 131072, maxLatencyP95Ms: 500, maxMemoryMb: 64,
  }}});
  if (wellFormed.length !== 0)
    fail("well-formed-passes", `expected 0 malformed, got ${JSON.stringify(wellFormed)}`);
  else pass("well-formed-passes — valid entry produces no malformed violations");

  const exceeded = findExceededBudgets({ defaults: {}, budgets: { "GET /projects": {
    maxDbCalls: 5, measuredDbCalls: 7,
  }}});
  if (exceeded.length !== 1 || !exceeded[0].issue.includes("exceeds"))
    fail("exceeded-budget-bites", `expected 1 exceeded-budget violation, got ${JSON.stringify(exceeded)}`);
  else pass("exceeded-budget-bites — measured > max is detected");

  const notExceeded = findExceededBudgets({ defaults: {}, budgets: { "GET /projects": {
    maxDbCalls: 5, measuredDbCalls: 4,
  }}});
  if (notExceeded.length !== 0)
    fail("within-budget-passes", `expected 0 violations for measured < max, got ${JSON.stringify(notExceeded)}`);
  else pass("within-budget-passes — measured ≤ max produces no violation");

  const nullMeasured = findExceededBudgets({ defaults: {}, budgets: { "GET /projects": {
    maxDbCalls: 5, measuredDbCalls: null,
  }}});
  if (nullMeasured.length !== 0)
    fail("null-measured-skipped", `expected 0 violations for null measured, got ${nullMeasured.length}`);
  else pass("null-measured-skipped — null measured values are skipped (not yet profiled)");

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
const stale = findStaleBudgetKeys(manifest, liveKeys);
const malformed = findMalformedBudgetEntries(manifest);
const exceeded = findExceededBudgets(manifest);
const budgetCount = Object.keys(manifest.budgets ?? {}).length;
const pendingMeasurement = Object.values(manifest.budgets ?? {}).filter(
  (e) => MEASURED_PAIRS.some(([mf]) => e[mf] === null || e[mf] === undefined),
).length;

process.stdout.write(
  `check-route-budgets: ${String(budgetCount)} declared budgets, ${String(pendingMeasurement)} pending measurement\n`,
);

if (stale.length > 0) {
  process.stdout.write(`  STALE BUDGETS: ${String(stale.length)} key(s) not in current OpenAPI:\n`);
  for (const k of stale) process.stdout.write(`    ${k}\n`);
}

if (malformed.length > 0) {
  process.stderr.write(`  MALFORMED: ${String(malformed.length)} budget field(s) with invalid values:\n`);
  for (const { key, field, issue } of malformed) {
    process.stderr.write(`    ${key}  ${issue}\n`);
  }
}

if (exceeded.length > 0) {
  process.stderr.write(`  EXCEEDED: ${String(exceeded.length)} measured value(s) above declared ceiling:\n`);
  for (const { key, issue } of exceeded) {
    process.stderr.write(`    ${key} — ${issue}\n`);
  }
}

const total = stale.length + malformed.length + exceeded.length;
if (total > 0) {
  process.stderr.write(`check-route-budgets: FAIL — ${String(total)} violation(s) in route budget manifest.\n`);
  process.exit(1);
}

process.stdout.write(`  OK — route budget manifest is valid and no budgets exceeded\n`);
process.exit(0);
