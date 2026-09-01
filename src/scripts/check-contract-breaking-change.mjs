#!/usr/bin/env node
/**
 * check-contract-breaking-change.mjs
 *
 * Breaking-change gate for the API contract registry.
 *
 * WHAT IT CHECKS
 * 1. REMOVAL — a published operation that is in the registry but absent from the
 *    current openapi.json is a breaking change unless the registry entry carries:
 *    - a non-null sunsetAt date that is in the past (deprecation window satisfied), AND
 *    - a non-null sunsetEvidence value (dependency proof on file)
 *    Internal operations may be removed freely.
 *
 * 2. PARAMETER NARROWING — a published operation that previously accepted an
 *    optional query/path parameter now marks it required, or drops it entirely.
 *    Internal operations may narrow freely.
 *
 * Architecture decision 12 (root CLAUDE.md §3):
 *   "internal frontend/backend routes, types and schemas may break during this
 *   coordinated refactor. Only published customer/integration contracts require
 *   backward compatibility or explicit versioned deprecation."
 *
 * DEPRECATION WINDOW RULE
 * sunsetAt must be a past ISO date (already elapsed) AND sunsetEvidence must be
 * a non-empty string. If either is missing the gate fails.
 *
 * SELF-TEST (--self-test)
 * Proves:
 *   - A removed published operation without sunset data → gate bites (exit 1)
 *   - A removed published operation WITH past sunsetAt + evidence → gate passes
 *   - A removed internal operation → gate passes (internal may break freely)
 *   - A parameter narrowed on a published route → gate bites
 *   - No removals → gate passes
 *
 * Usage:
 *   node src/scripts/check-contract-breaking-change.mjs [--self-test]
 *   pnpm check:contract-breaking-change
 *   pnpm check:contract-breaking-change:self-test
 *
 * Exit codes:
 *   0 — no breaking changes (or self-test passed)
 *   1 — breaking change detected, or self-test failed
 *   2 — document or registry unreadable
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_TEST = process.argv.includes("--self-test");
const BACKEND_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const OPENAPI_PATH = join(BACKEND_ROOT, "openapi.json");
const REGISTRY_PATH = join(BACKEND_ROOT, "contracts", "api-contract-registry.json");

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

function makeKey(method, path) {
  return `${method.toUpperCase()} ${path}`;
}

function isDeprecationWindowSatisfied(entry) {
  if (!entry.sunsetAt || !entry.sunsetEvidence) return false;
  const sunset = new Date(entry.sunsetAt);
  if (isNaN(sunset.getTime())) return false;
  return sunset < new Date();
}

export function findBreakingRemovals(document, registry) {
  const liveKeys = new Set();
  const paths = document.paths ?? {};

  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method] of Object.entries(pathItem)) {
      if (HTTP_METHODS.has(method)) liveKeys.add(makeKey(method, pathTemplate));
    }
  }

  const violations = [];
  for (const [key, entry] of Object.entries(registry.operations ?? {})) {
    if (liveKeys.has(key)) continue;
    if (entry.classification !== "published") continue;
    if (isDeprecationWindowSatisfied(entry)) continue;
    violations.push({
      key,
      issue: entry.sunsetAt
        ? `published operation removed without a satisfied deprecation window (sunsetAt=${String(entry.sunsetAt)}, evidence=${entry.sunsetEvidence ? "present" : "MISSING"})`
        : "published operation removed without sunsetAt date or dependency proof",
    });
  }

  return violations;
}

export function findBreakingNarrowings(document, registry) {
  const violations = [];
  const paths = document.paths ?? {};

  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      if (typeof operation !== "object" || operation === null) continue;

      const key = makeKey(method, pathTemplate);
      const entry = (registry.operations ?? {})[key];
      if (!entry || entry.classification !== "published") continue;

      const registryParams = new Map((entry.knownParameters ?? []).map((p) => [p.name, p]));
      if (registryParams.size === 0) continue;

      const currentParams = new Map(
        (operation.parameters ?? [])
          .filter((p) => typeof p === "object" && p !== null && typeof p.name === "string")
          .map((p) => [p.name, p]),
      );

      for (const [name, regParam] of registryParams) {
        const curParam = currentParams.get(name);
        if (!curParam) {
          violations.push({ key, issue: `published operation dropped previously-known parameter "${name}"` });
        } else if (!regParam.required && curParam.required === true) {
          violations.push({ key, issue: `published operation made optional parameter "${name}" required (narrowing)` });
        }
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

  const pastDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const futureDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const emptyDoc = { paths: {} };

  const r1 = findBreakingRemovals(emptyDoc, {
    operations: { "GET /old": { classification: "published", sunsetAt: null, sunsetEvidence: null } },
  });
  if (r1.length !== 1)
    fail("published-removal-bites", `expected 1 violation for published removal without sunset, got ${r1.length}`);
  else pass("published-removal-bites — published removal without sunset fails the gate");

  const r2 = findBreakingRemovals(emptyDoc, {
    operations: { "GET /old": { classification: "published", sunsetAt: pastDate, sunsetEvidence: "ticket-123: all consumers migrated" } },
  });
  if (r2.length !== 0)
    fail("published-removal-with-sunset-passes", `expected 0 violations with past sunsetAt, got ${r2.length}`);
  else pass("published-removal-with-sunset-passes — past sunsetAt + evidence allows the removal");

  const r3 = findBreakingRemovals(emptyDoc, {
    operations: { "GET /old": { classification: "published", sunsetAt: futureDate, sunsetEvidence: "ticket-123" } },
  });
  if (r3.length !== 1)
    fail("future-sunsetat-still-fails", `expected 1 violation for future sunsetAt, got ${r3.length}`);
  else pass("future-sunsetat-still-fails — future sunsetAt does not satisfy the window");

  const r4 = findBreakingRemovals(emptyDoc, {
    operations: { "POST /internal/sync": { classification: "internal", sunsetAt: null, sunsetEvidence: null } },
  });
  if (r4.length !== 0)
    fail("internal-removal-passes", `expected 0 violations for internal removal, got ${r4.length}`);
  else pass("internal-removal-passes — internal operations may be removed freely");

  const docWithOp = { paths: { "/projects": { get: { operationId: "P_list", parameters: [{ name: "limit", in: "query", required: false }] } } } };
  const r5 = findBreakingNarrowings(docWithOp, {
    operations: { "GET /projects": { classification: "published", knownParameters: [{ name: "limit", required: false }] } },
  });
  if (r5.length !== 0)
    fail("no-narrowing-passes", `expected 0 violations when param stays optional, got ${r5.length}`);
  else pass("no-narrowing-passes — optional param staying optional produces no violations");

  const docNarrowed = { paths: { "/projects": { get: { operationId: "P_list", parameters: [{ name: "limit", in: "query", required: true }] } } } };
  const r6 = findBreakingNarrowings(docNarrowed, {
    operations: { "GET /projects": { classification: "published", knownParameters: [{ name: "limit", required: false }] } },
  });
  if (r6.length !== 1 || !r6[0].issue.includes("narrowing"))
    fail("narrowing-bites", `expected 1 narrowing violation, got ${JSON.stringify(r6)}`);
  else pass("narrowing-bites — making optional param required is a narrowing violation");

  const docDropped = { paths: { "/projects": { get: { operationId: "P_list", parameters: [] } } } };
  const r7 = findBreakingNarrowings(docDropped, {
    operations: { "GET /projects": { classification: "published", knownParameters: [{ name: "limit", required: false }] } },
  });
  if (r7.length !== 1 || !r7[0].issue.includes("dropped"))
    fail("dropped-param-bites", `expected 1 dropped-param violation, got ${JSON.stringify(r7)}`);
  else pass("dropped-param-bites — dropping a known published parameter is flagged");

  const docInternal = { paths: { "/internal/sync": { post: { operationId: "S_sync", parameters: [] } } } };
  const r8 = findBreakingNarrowings(docInternal, {
    operations: { "POST /internal/sync": { classification: "internal", knownParameters: [{ name: "dryRun", required: false }] } },
  });
  if (r8.length !== 0)
    fail("internal-narrowing-passes", `expected 0 violations for internal narrowing, got ${r8.length}`);
  else pass("internal-narrowing-passes — internal operations may narrow freely");

  if (failed) {
    process.stderr.write("\nSELF-TEST FAILED\n");
    process.exit(1);
  }
  process.stdout.write("\nSELF-TEST PASSED\n");
  process.exit(0);
}

if (!existsSync(OPENAPI_PATH)) {
  process.stderr.write(`check-contract-breaking-change: openapi.json not found at ${OPENAPI_PATH}\n`);
  process.exit(2);
}
if (!existsSync(REGISTRY_PATH)) {
  process.stderr.write(`check-contract-breaking-change: registry not found at ${REGISTRY_PATH}\nRun: pnpm registry:generate\n`);
  process.exit(2);
}

let document, registry;
try {
  document = JSON.parse(readFileSync(OPENAPI_PATH, "utf8"));
} catch (err) {
  process.stderr.write(`check-contract-breaking-change: failed to parse openapi.json: ${err.message}\n`);
  process.exit(2);
}
try {
  registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
} catch (err) {
  process.stderr.write(`check-contract-breaking-change: failed to parse registry: ${err.message}\n`);
  process.exit(2);
}

const removals = findBreakingRemovals(document, registry);
const narrowings = findBreakingNarrowings(document, registry);
const totalViolations = removals.length + narrowings.length;

const publishedOps = Object.values(registry.operations ?? {}).filter((e) => e.classification === "published").length;
const internalOps = Object.values(registry.operations ?? {}).filter((e) => e.classification === "internal").length;

process.stdout.write(
  `check-contract-breaking-change: ${String(publishedOps)} published operations, ${String(internalOps)} internal\n`,
);

if (removals.length > 0) {
  process.stderr.write(`\n  BREAKING: ${String(removals.length)} published operation(s) removed without satisfied deprecation window:\n`);
  for (const { key, issue } of removals) {
    process.stderr.write(`    ${key}\n`);
    process.stderr.write(`        ${issue}\n`);
  }
}

if (narrowings.length > 0) {
  process.stderr.write(`\n  BREAKING: ${String(narrowings.length)} published parameter narrowing(s):\n`);
  for (const { key, issue } of narrowings) {
    process.stderr.write(`    ${key}\n`);
    process.stderr.write(`        ${issue}\n`);
  }
}

if (totalViolations > 0) {
  process.stderr.write(
    `\ncheck-contract-breaking-change: FAIL — ${String(totalViolations)} breaking change(s) detected.\n` +
    `To permit a published removal: set sunsetAt (past date) + sunsetEvidence in contracts/api-contract-registry.json.\n`,
  );
  process.exit(1);
}

process.stdout.write(`  OK — no breaking changes detected\n`);
process.exit(0);
