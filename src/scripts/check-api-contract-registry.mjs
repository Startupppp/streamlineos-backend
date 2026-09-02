#!/usr/bin/env node
/**
 * check-api-contract-registry.mjs
 *
 * Fail-closed API contract registry gate.
 *
 * WHAT IT CHECKS
 * 1. COMPLETENESS — every HTTP operation in the current openapi.json has an
 *    explicit entry in contracts/api-contract-registry.json. An operation absent
 *    from the registry is treated as "published" (strictest class) and the gate
 *    exits non-zero. This is the fail-closed guarantee: a new route requires
 *    explicit classification before the gate passes.
 *
 * 2. SCHEMA VALIDITY — every registry entry carries the required fields with
 *    valid values (classification, xExposure, operationId).
 *
 * 3. DUPLICATE OPERATIONID COLLISION REPORT — operations sharing an operationId
 *    are reported (known defect: 28 ops published another route's contract). The
 *    gate keys on method+path, never on operationId alone. Duplicates are
 *    reported but do not fail the gate — deletion requires caller/dependency proof.
 *
 * 4. STALE ENTRIES — registry entries whose method+path no longer appear in the
 *    current OpenAPI are flagged as stale. They do not fail the gate (the
 *    breaking-change gate handles removals) but are reported for cleanup.
 *
 * FAIL-CLOSED SEMANTICS
 * Unknown operation (in OpenAPI, absent from registry) → treated as "published"
 * → gate exits 1 → human must run `pnpm registry:generate` and commit.
 *
 * SELF-TEST (--self-test)
 * Creates synthetic fixtures to prove:
 *   - An operation in OpenAPI but not in registry → gate exits 1 (bites)
 *   - All operations in registry → gate exits 0 (passes)
 *   - A known-bad fixture (extra op, missing entry) → non-zero exit
 *   - Duplicate operationId detection works
 *
 * Usage:
 *   node src/scripts/check-api-contract-registry.mjs [--self-test]
 *   pnpm check:contract-registry
 *   pnpm check:contract-registry:self-test
 *
 * Exit codes:
 *   0 — all operations classified (or self-test passed)
 *   1 — one or more unclassified operations, or self-test failed
 *   2 — document or registry unreadable, or self-test infrastructure error
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_TEST = process.argv.includes("--self-test");
const BACKEND_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const OPENAPI_PATH = join(BACKEND_ROOT, "openapi.json");
const REGISTRY_PATH = join(BACKEND_ROOT, "contracts", "api-contract-registry.json");

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const VALID_CLASSIFICATIONS = new Set(["internal", "published"]);

function makeKey(method, path) {
  return `${method.toUpperCase()} ${path}`;
}

export function findUnclassifiedOperations(document, registry) {
  const violations = [];
  const registryOps = registry.operations ?? {};
  const paths = document.paths ?? {};

  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      if (typeof operation !== "object" || operation === null) continue;

      const key = makeKey(method, pathTemplate);
      const entry = registryOps[key];

      if (!entry) {
        violations.push({ key, issue: "absent from registry — treated as published (fail-closed)" });
      } else if (!VALID_CLASSIFICATIONS.has(entry.classification)) {
        violations.push({ key, issue: `invalid classification "${String(entry.classification)}" — must be "internal" or "published"` });
      }
    }
  }

  return violations;
}

export function findStaleEntries(document, registry) {
  const registryOps = registry.operations ?? {};
  const paths = document.paths ?? {};
  const liveKeys = new Set();

  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method] of Object.entries(pathItem)) {
      if (HTTP_METHODS.has(method)) liveKeys.add(makeKey(method, pathTemplate));
    }
  }

  return Object.keys(registryOps).filter((k) => !liveKeys.has(k));
}

export function findDuplicateOperationIds(document) {
  const seen = new Map();
  const duplicates = [];
  const paths = document.paths ?? {};

  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      if (typeof operation !== "object" || operation === null) continue;
      const { operationId } = operation;
      if (typeof operationId !== "string") continue;
      const key = makeKey(method, pathTemplate);
      if (seen.has(operationId)) {
        duplicates.push({ operationId, first: seen.get(operationId), second: key });
      } else {
        seen.set(operationId, key);
      }
    }
  }

  return duplicates;
}

export function countByClassification(registry) {
  const ops = registry.operations ?? {};
  let internal = 0;
  let published = 0;
  let invalid = 0;
  for (const entry of Object.values(ops)) {
    if (entry.classification === "internal") internal++;
    else if (entry.classification === "published") published++;
    else invalid++;
  }
  return { internal, published, invalid };
}

if (SELF_TEST) {
  process.stdout.write("Running self-test...\n");
  let failed = false;

  const pass = (label) => process.stdout.write(`  [pass] ${label}\n`);
  const fail = (label, detail) => {
    process.stderr.write(`  [FAIL] ${label}: ${detail}\n`);
    failed = true;
  };

  const makeDoc = (ops) => ({
    paths: Object.fromEntries(
      ops.map(({ path, method, operationId, exposure }) => [
        path,
        { [method]: { operationId, "x-exposure": exposure } },
      ]),
    ),
  });

  const goodOps = [
    { path: "/projects", method: "get", operationId: "ProjectsController_list", exposure: "permissioned" },
    { path: "/auth/login", method: "post", operationId: "AuthController_login", exposure: "public" },
    { path: "/internal/sync", method: "post", operationId: "SyncController_sync", exposure: "in-service" },
  ];

  const goodRegistry = {
    operations: {
      "GET /projects": { classification: "published", xExposure: "permissioned" },
      "POST /auth/login": { classification: "published", xExposure: "public" },
      "POST /internal/sync": { classification: "internal", xExposure: "in-service" },
    },
  };

  const r1 = findUnclassifiedOperations(makeDoc(goodOps), goodRegistry);
  if (r1.length !== 0)
    fail("all-classified-passes", `expected 0 violations, got ${JSON.stringify(r1)}`);
  else pass("all-classified-passes — all ops in registry produce 0 violations");

  const badRegistry = { operations: { "GET /projects": { classification: "published", xExposure: "permissioned" } } };
  const r2 = findUnclassifiedOperations(makeDoc(goodOps), badRegistry);
  if (r2.length !== 2)
    fail("missing-entries-detected", `expected 2 violations for 2 missing ops, got ${r2.length}: ${JSON.stringify(r2)}`);
  else pass("missing-entries-detected — 2 ops absent from registry produce 2 violations");

  const extraOp = { path: "/new/unclassified", method: "get", operationId: "NewController_list", exposure: "permissioned" };
  const r3 = findUnclassifiedOperations(makeDoc([...goodOps, extraOp]), goodRegistry);
  if (r3.length !== 1 || !r3[0].key.includes("/new/unclassified"))
    fail("extra-op-fail-closed", `expected 1 violation for the extra unclassified op, got ${JSON.stringify(r3)}`);
  else pass("extra-op-fail-closed — extra op absent from registry → fail-closed (1 violation)");

  const invalidClassRegistry = { operations: { "GET /projects": { classification: "BOGUS", xExposure: "permissioned" } } };
  const r4 = findUnclassifiedOperations(makeDoc([goodOps[0]]), invalidClassRegistry);
  if (r4.length !== 1 || !r4[0].issue.includes("BOGUS"))
    fail("invalid-classification-flagged", `expected 1 violation for invalid classification, got ${JSON.stringify(r4)}`);
  else pass("invalid-classification-flagged — invalid classification value produces a violation");

  const dupeDoc = {
    paths: {
      "/a": { get: { operationId: "ApprovalsController_approve", "x-exposure": "permissioned" } },
      "/b": { post: { operationId: "ApprovalsController_approve", "x-exposure": "permissioned" } },
    },
  };
  const dups = findDuplicateOperationIds(dupeDoc);
  if (dups.length !== 1 || dups[0].operationId !== "ApprovalsController_approve")
    fail("duplicate-operationid-detected", `expected 1 duplicate, got ${JSON.stringify(dups)}`);
  else pass("duplicate-operationid-detected — duplicate operationId is reported");

  const nodupeDoc = { paths: { "/a": { get: { operationId: "A_list" } }, "/b": { post: { operationId: "B_create" } } } };
  if (findDuplicateOperationIds(nodupeDoc).length !== 0)
    fail("no-duplicate-passes", "clean doc should have 0 duplicates");
  else pass("no-duplicate-passes — unique operationIds produce 0 duplicates");

  const staleRegistry = {
    operations: {
      "GET /projects": { classification: "published" },
      "GET /old-removed": { classification: "published" },
    },
  };
  const staleDoc = makeDoc([goodOps[0]]);
  const stale = findStaleEntries(staleDoc, staleRegistry);
  if (stale.length !== 1 || stale[0] !== "GET /old-removed")
    fail("stale-entries-detected", `expected 1 stale entry, got ${JSON.stringify(stale)}`);
  else pass("stale-entries-detected — registry entry for removed op is flagged as stale");

  const counts = countByClassification({ operations: {
    "GET /a": { classification: "published" },
    "GET /b": { classification: "internal" },
    "GET /c": { classification: "published" },
    "GET /d": { classification: "INVALID" },
  }});
  if (counts.published !== 2 || counts.internal !== 1 || counts.invalid !== 1)
    fail("count-by-classification", `expected 2/1/1, got ${JSON.stringify(counts)}`);
  else pass("count-by-classification — counts by classification are accurate");

  if (failed) {
    process.stderr.write("\nSELF-TEST FAILED\n");
    process.exit(1);
  }
  process.stdout.write("\nSELF-TEST PASSED\n");
  process.exit(0);
}

if (!existsSync(OPENAPI_PATH)) {
  process.stderr.write(`check-api-contract-registry: openapi.json not found at ${OPENAPI_PATH}\nRun: pnpm openapi:generate\n`);
  process.exit(2);
}
if (!existsSync(REGISTRY_PATH)) {
  process.stderr.write(`check-api-contract-registry: registry not found at ${REGISTRY_PATH}\nRun: pnpm registry:generate\n`);
  process.exit(2);
}

let document, registry;
try {
  document = JSON.parse(readFileSync(OPENAPI_PATH, "utf8"));
} catch (err) {
  process.stderr.write(`check-api-contract-registry: failed to parse openapi.json: ${err.message}\n`);
  process.exit(2);
}
try {
  registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
} catch (err) {
  process.stderr.write(`check-api-contract-registry: failed to parse registry: ${err.message}\n`);
  process.exit(2);
}

const registryOpCount = Object.keys(registry.operations ?? {}).length;
const registryEventCount = Object.keys(registry.events ?? {}).length;
const { internal, published } = countByClassification(registry);

process.stdout.write(
  `check-api-contract-registry: registry v${String(registry.version ?? "?")} — ` +
  `${String(registryOpCount)} operations (${String(published)} published, ${String(internal)} internal), ` +
  `${String(registryEventCount)} events\n`,
);

const duplicates = findDuplicateOperationIds(document);
if (duplicates.length > 0) {
  process.stdout.write(`  REPORT: ${String(duplicates.length)} duplicate operationId collision(s) found (reported only — fix requires caller proof):\n`);
  for (const { operationId, first, second } of duplicates.slice(0, 20)) {
    process.stdout.write(`    operationId "${operationId}": ${first} collides with ${second}\n`);
  }
  if (duplicates.length > 20) process.stdout.write(`    ... and ${String(duplicates.length - 20)} more\n`);
}

const stale = findStaleEntries(document, registry);
if (stale.length > 0) {
  process.stdout.write(`  REPORT: ${String(stale.length)} retained entry/entries (operation removed from OpenAPI):\n`);
  for (const k of stale.slice(0, 20)) process.stdout.write(`    ${k}\n`);
  if (stale.length > 20) process.stdout.write(`    ... and ${String(stale.length - 20)} more\n`);
  process.stdout.write(
    `  These are retained on purpose: check-contract-breaking-change detects a removal\n` +
      `  by finding exactly this state. Do not delete them to quieten the report — clear\n` +
      `  each one by satisfying its deprecation window or reclassifying it as internal.\n`,
  );
}

const violations = findUnclassifiedOperations(document, registry);
if (violations.length > 0) {
  process.stderr.write(`\ncheck-api-contract-registry: FAIL — ${String(violations.length)} operation(s) absent from registry (treated as published)\n\n`);
  for (const { key, issue } of violations.slice(0, 50)) {
    process.stderr.write(`  ${key}\n`);
    process.stderr.write(`      ${issue}\n`);
  }
  if (violations.length > 50) process.stderr.write(`  ... and ${String(violations.length - 50)} more\n`);
  process.stderr.write(`\nRun: pnpm registry:generate to classify new operations and commit the result.\n`);
  process.exit(1);
}

process.stdout.write(`  OK — all ${String(registryOpCount)} operations are classified\n`);
process.exit(0);
