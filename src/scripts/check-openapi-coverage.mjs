#!/usr/bin/env node
/**
 * check-openapi-coverage.mjs
 *
 * Static coverage gate for openapi.json. Reads the committed document and
 * verifies:
 *
 *   1. VACUITY — at least MIN_OPERATIONS operations are present. A gate whose
 *      failure mode is "silently passes on an empty document" is worse than no
 *      gate; this exits 2 and stops the pipeline before any other check runs.
 *
 *   2. EXPOSURE COMPLETENESS — every operation carries x-exposure with one of
 *      the four valid values (permissioned | public | universal | in-service).
 *      recordRouteClassification stamps this at generation time from the same
 *      metadata keys RouteClassifierGuard enforces at boot, so a gap here means
 *      either the document is stale (run: pnpm openapi:generate) or the
 *      stamping code regressed.
 *
 * What this gate does NOT detect:
 *   - Handlers present in the running app but absent from the committed document
 *     (stale document). That is handled by pnpm openapi:check, which re-generates
 *     and diffs. Run it before this gate in a pre-commit pipeline.
 *   - Documented operations whose handler was deleted (zombies). Also handled by
 *     pnpm openapi:check.
 *   - Missing response schemas. The OperationContract system in
 *     src/common/openapi/ currently only projects request-side schemas (body,
 *     query, params). Response schema injection is not implemented; the 0-count
 *     is by architecture, not a gate regression.
 *
 * VACUITY GUARD
 * Fewer than MIN_OPERATIONS parsed → exit 2 ("document is suspiciously small").
 * Current document has 3,551 operations; the floor is set conservatively at
 * 3,000 to absorb legitimate module deletions without constant maintenance.
 *
 * SELF-TEST (--self-test)
 * Runs five synthetic cases through the same detection functions:
 *   bad-missing-exposure  — an op with no x-exposure → must flag it
 *   bad-invalid-exposure  — an op with x-exposure="UNKNOWN" → must flag it
 *   good-all-valid        — all ops have valid exposure → must pass
 *   good-mixed-exposure   — all four valid values present → must pass
 *   vacuity-trigger       — a document with fewer than MIN_OPERATIONS ops → must
 *                           detect vacuity (the guard function returns true)
 * The self-test fails loudly if any case does not behave as expected.
 *
 * Usage:
 *   node src/scripts/check-openapi-coverage.mjs [--self-test]
 *   pnpm check:openapi-coverage
 *   pnpm check:openapi-coverage:self-test
 *
 * Exit codes:
 *   0 — clean (or self-test passed)
 *   1 — exposure violations found (or self-test failed)
 *   2 — vacuity check failed, document unreadable, or self-test infrastructure error
 */

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_TEST = process.argv.includes("--self-test");
const BACKEND_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const OPENAPI_PATH = join(BACKEND_ROOT, "openapi.json");

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const MUTATING_METHODS = new Set(["post", "put", "patch"]);
const VALID_EXPOSURES = new Set(["permissioned", "public", "universal", "in-service"]);
const MIN_OPERATIONS = 3000;
const MIN_ERROR_SHAPE_PCT = 95;
const MIN_MUTATING_REQUEST_SCHEMA_PCT = 60;

/**
 * Count all HTTP operations across all paths.
 * Returns the total count.
 */
export function countOperations(document) {
  let count = 0;
  const paths = document.paths;
  if (typeof paths !== "object" || paths === null) return count;
  for (const pathItem of Object.values(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const method of Object.keys(pathItem)) {
      if (HTTP_METHODS.has(method)) count++;
    }
  }
  return count;
}

/**
 * Returns true when totalOperations is below the minimum floor.
 * Used by both the gate and the self-test.
 */
export function isVacuous(totalOperations) {
  return totalOperations < MIN_OPERATIONS;
}

/**
 * Find operations that are missing x-exposure or carry an invalid value.
 * Returns an array of { method, path, issue } objects.
 */
export function findExposureViolations(document) {
  const violations = [];
  const paths = document.paths;
  if (typeof paths !== "object" || paths === null) return violations;

  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      if (typeof operation !== "object" || operation === null) continue;

      const exposure = operation["x-exposure"];
      if (exposure === undefined || exposure === null) {
        violations.push({ method: method.toUpperCase(), path: pathTemplate, issue: "x-exposure missing" });
      } else if (!VALID_EXPOSURES.has(String(exposure))) {
        violations.push({ method: method.toUpperCase(), path: pathTemplate, issue: `x-exposure "${String(exposure)}" is not a valid value` });
      }
    }
  }

  return violations;
}

function hasErrorShapeRef(responses) {
  for (const [code, resp] of Object.entries(responses)) {
    const statusNum = parseInt(code, 10);
    if (statusNum < 400 || statusNum >= 600) continue;
    if (typeof resp !== "object" || resp === null) continue;
    const ref = resp["$ref"];
    if (typeof ref === "string" && ref.startsWith("#/components/responses/")) return true;
  }
  return false;
}

export function findMissingErrorShapes(document) {
  const violations = [];
  const paths = document.paths;
  if (typeof paths !== "object" || paths === null) return violations;
  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      if (typeof operation !== "object" || operation === null) continue;
      const responses = operation["responses"];
      if (typeof responses !== "object" || responses === null || !hasErrorShapeRef(responses)) {
        violations.push({ method: method.toUpperCase(), path: pathTemplate, issue: "no 4xx error shape ref to #/components/responses/" });
      }
    }
  }
  return violations;
}

export function findMissingResponseSchemas(document) {
  const violations = [];
  const paths = document.paths;
  if (typeof paths !== "object" || paths === null) return violations;
  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      if (typeof operation !== "object" || operation === null) continue;
      const responses = operation["responses"];
      const has2xx = typeof responses === "object" && responses !== null &&
        Object.keys(responses).some((code) => {
          const num = parseInt(code, 10);
          return num >= 200 && num < 300;
        });
      if (!has2xx) {
        violations.push({ method: method.toUpperCase(), path: pathTemplate, issue: "no 2xx response body schema" });
      }
    }
  }
  return violations;
}

export function findMissingMutatingRequestSchemas(document) {
  const violations = [];
  const paths = document.paths;
  if (typeof paths !== "object" || paths === null) return violations;
  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!MUTATING_METHODS.has(method)) continue;
      if (typeof operation !== "object" || operation === null) continue;
      if (operation["x-bodyless"] === true) continue;
      const hasRequestBody = typeof operation["requestBody"] === "object" && operation["requestBody"] !== null;
      if (!hasRequestBody) {
        violations.push({ method: method.toUpperCase(), path: pathTemplate, issue: "mutating op without request body schema" });
      }
    }
  }
  return violations;
}

/**
 * Find operations with x-bodyless-conflict: true.
 * These are handlers that were decorated with @BodylessAction() but also carry a @Body()
 * parameter — a false marking that leaves the body contract undocumented.
 * Detected at generation time by scanOperationContracts; the stamp is the proof.
 * Returns an array of { method, path, issue } objects.
 */
export function findBodylessConflicts(document) {
  const violations = [];
  const paths = document.paths;
  if (typeof paths !== "object" || paths === null) return violations;
  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      if (typeof operation !== "object" || operation === null) continue;
      if (operation["x-bodyless-conflict"] === true) {
        violations.push({ method: method.toUpperCase(), path: pathTemplate, issue: "x-bodyless-conflict: @BodylessAction() on a handler that reads @Body() — body contract is undocumented" });
      }
    }
  }
  return violations;
}

/**
 * Count operations by their x-exposure value.
 * Returns a Map<string, number>.
 */
export function countByExposure(document) {
  const counts = new Map();
  const paths = document.paths;
  if (typeof paths !== "object" || paths === null) return counts;

  for (const pathItem of Object.values(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      if (typeof operation !== "object" || operation === null) continue;
      const exposure = String(operation["x-exposure"] ?? "missing");
      counts.set(exposure, (counts.get(exposure) ?? 0) + 1);
    }
  }

  return counts;
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
      ops.map(({ path, method, exposure }, i) => [
        path,
        { [method]: exposure !== undefined ? { operationId: `op_${String(i)}`, "x-exposure": exposure } : { operationId: `op_${String(i)}` } },
      ]),
    ),
  });

  const goodOps = [
    { path: "/projects", method: "get", exposure: "permissioned" },
    { path: "/projects", method: "post", exposure: "permissioned" },
    { path: "/auth/login", method: "post", exposure: "public" },
    { path: "/health", method: "get", exposure: "public" },
    { path: "/me/profile", method: "get", exposure: "universal" },
    { path: "/internal/sync", method: "post", exposure: "in-service" },
  ];

  const case1 = makeDoc([
    ...goodOps,
    { path: "/broken", method: "get" },
  ]);
  const result1 = findExposureViolations(case1);
  if (result1.length !== 1 || !result1[0].issue.includes("missing"))
    fail("bad-missing-exposure", `expected 1 missing-exposure violation, got ${JSON.stringify(result1)}`);
  else pass("bad-missing-exposure — op without x-exposure is flagged");

  const case2 = makeDoc([
    ...goodOps,
    { path: "/broken", method: "post", exposure: "UNKNOWN" },
  ]);
  const result2 = findExposureViolations(case2);
  if (result2.length !== 1 || !result2[0].issue.includes("UNKNOWN"))
    fail("bad-invalid-exposure", `expected 1 invalid-value violation, got ${JSON.stringify(result2)}`);
  else pass("bad-invalid-exposure — op with x-exposure='UNKNOWN' is flagged");

  const caseGood = makeDoc(goodOps);
  const result3 = findExposureViolations(caseGood);
  if (result3.length !== 0)
    fail("good-all-valid", `expected 0 violations, got ${JSON.stringify(result3)}`);
  else pass("good-all-valid — all ops with valid exposure produce no violations");

  const caseMixed = makeDoc([
    { path: "/a", method: "get", exposure: "permissioned" },
    { path: "/b", method: "post", exposure: "public" },
    { path: "/c", method: "get", exposure: "universal" },
    { path: "/d", method: "post", exposure: "in-service" },
  ]);
  const result4 = findExposureViolations(caseMixed);
  if (result4.length !== 0)
    fail("good-mixed-exposure", `all four valid values should pass, got ${JSON.stringify(result4)}`);
  else pass("good-mixed-exposure — all four valid exposure values accepted");

  if (!isVacuous(0))
    fail("vacuity-trigger-zero", "isVacuous(0) should return true");
  else pass("vacuity-trigger-zero — isVacuous(0) returns true");

  if (!isVacuous(MIN_OPERATIONS - 1))
    fail("vacuity-trigger-floor", `isVacuous(${String(MIN_OPERATIONS - 1)}) should return true`);
  else pass(`vacuity-trigger-floor — isVacuous(MIN_OPERATIONS - 1) returns true`);

  if (isVacuous(MIN_OPERATIONS))
    fail("vacuity-not-triggered-at-floor", `isVacuous(${String(MIN_OPERATIONS)}) should return false`);
  else pass(`vacuity-not-triggered-at-floor — isVacuous(MIN_OPERATIONS) returns false`);

  if (isVacuous(MIN_OPERATIONS + 1000))
    fail("vacuity-not-triggered-above-floor", `isVacuous(${String(MIN_OPERATIONS + 1000)}) should return false`);
  else pass(`vacuity-not-triggered-above-floor — isVacuous(${String(MIN_OPERATIONS + 1000)}) returns false`);

  const makeFullDoc = (ops) => ({
    paths: Object.fromEntries(
      ops.map(({ path, method, ...rest }, i) => [
        path,
        { [method]: { operationId: `op_${String(i)}`, ...rest } },
      ]),
    ),
  });

  const errorShapesGood = makeFullDoc([
    { path: "/a", method: "get", responses: { "400": { $ref: "#/components/responses/BadRequest" }, "401": { $ref: "#/components/responses/Unauthorized" } } },
    { path: "/b", method: "post", responses: { "400": { $ref: "#/components/responses/BadRequest" } } },
  ]);
  const esGoodResult = findMissingErrorShapes(errorShapesGood);
  if (esGoodResult.length !== 0)
    fail("good-error-shapes", `expected 0 violations, got ${JSON.stringify(esGoodResult)}`);
  else pass("good-error-shapes — ops with 4xx $ref are not flagged");

  const errorShapesBad = makeFullDoc([
    { path: "/a", method: "get", responses: { "200": { description: "OK" } } },
    { path: "/b", method: "post" },
  ]);
  const esBadResult = findMissingErrorShapes(errorShapesBad);
  if (esBadResult.length !== 2)
    fail("bad-missing-error-shapes", `expected 2 violations, got ${JSON.stringify(esBadResult)}`);
  else pass("bad-missing-error-shapes — ops without 4xx $ref are flagged");

  const responseSchemaGood = makeFullDoc([
    { path: "/a", method: "get", responses: { "200": { description: "OK", content: {} } } },
    { path: "/b", method: "post", responses: { "201": { description: "Created" } } },
  ]);
  const rsGoodResult = findMissingResponseSchemas(responseSchemaGood);
  if (rsGoodResult.length !== 0)
    fail("good-response-schemas", `expected 0 violations, got ${JSON.stringify(rsGoodResult)}`);
  else pass("good-response-schemas — ops with 2xx entries are not flagged");

  const responseSchemaBad = makeFullDoc([
    { path: "/a", method: "get", responses: { "400": { $ref: "#/components/responses/BadRequest" } } },
    { path: "/b", method: "post" },
  ]);
  const rsBadResult = findMissingResponseSchemas(responseSchemaBad);
  if (rsBadResult.length !== 2)
    fail("bad-missing-response-schemas", `expected 2 violations, got ${JSON.stringify(rsBadResult)}`);
  else pass("bad-missing-response-schemas — ops without 2xx entry are flagged");

  const mutatingBodyGood = makeFullDoc([
    { path: "/a", method: "post", requestBody: { required: true, content: {} } },
    { path: "/b", method: "post", "x-bodyless": true },
    { path: "/c", method: "get" },
  ]);
  const mbGoodResult = findMissingMutatingRequestSchemas(mutatingBodyGood);
  if (mbGoodResult.length !== 0)
    fail("good-mutating-request-schemas", `expected 0 violations, got ${JSON.stringify(mbGoodResult)}`);
  else pass("good-mutating-request-schemas — POST with body or x-bodyless not flagged; GET ignored");

  const mutatingBodyBad = makeFullDoc([
    { path: "/a", method: "post" },
    { path: "/b", method: "put" },
    { path: "/c", method: "get" },
  ]);
  const mbBadResult = findMissingMutatingRequestSchemas(mutatingBodyBad);
  if (mbBadResult.length !== 2)
    fail("bad-mutating-request-schemas", `expected 2 violations (POST and PUT), got ${JSON.stringify(mbBadResult)}`);
  else pass("bad-mutating-request-schemas — POST and PUT without requestBody are flagged; GET ignored");

  const bodylessConflictGood = makeFullDoc([
    { path: "/a", method: "post", "x-bodyless": true },
    { path: "/b", method: "post", requestBody: { required: true, content: {} } },
    { path: "/c", method: "get" },
  ]);
  const bcGoodResult = findBodylessConflicts(bodylessConflictGood);
  if (bcGoodResult.length !== 0)
    fail("good-no-bodyless-conflict", `expected 0 violations, got ${JSON.stringify(bcGoodResult)}`);
  else pass("good-no-bodyless-conflict — ops without x-bodyless-conflict are not flagged");

  const bodylessConflictBad = makeFullDoc([
    { path: "/a", method: "post", "x-bodyless-conflict": true },
    { path: "/b", method: "put", "x-bodyless-conflict": true },
    { path: "/c", method: "get", "x-bodyless-conflict": true },
  ]);
  const bcBadResult = findBodylessConflicts(bodylessConflictBad);
  if (bcBadResult.length !== 3)
    fail("bad-bodyless-conflict", `expected 3 violations (POST, PUT, GET all count), got ${JSON.stringify(bcBadResult)}`);
  else pass("bad-bodyless-conflict — all methods with x-bodyless-conflict are flagged");

  if (failed) {
    process.stderr.write("\nSELF-TEST FAILED\n");
    process.exit(1);
  }
  process.stdout.write("\nSELF-TEST PASSED\n");
  process.exit(0);
}

if (!existsSync(OPENAPI_PATH)) {
  process.stderr.write(
    `check-openapi-coverage: openapi.json not found at ${OPENAPI_PATH}\nRun: pnpm openapi:generate\n`,
  );
  process.exit(2);
}

let document;
try {
  document = JSON.parse(readFileSync(OPENAPI_PATH, "utf8"));
} catch (err) {
  process.stderr.write(`check-openapi-coverage: failed to parse openapi.json: ${err.message}\n`);
  process.exit(2);
}

const totalOperations = countOperations(document);

if (isVacuous(totalOperations)) {
  process.stderr.write(
    `check-openapi-coverage: VACUITY — parsed only ${String(totalOperations)} operations, expected at least ${String(MIN_OPERATIONS)}.\n` +
    `The document is suspiciously small. Run: pnpm openapi:generate and commit the result.\n` +
    `If the operation count dropped legitimately, lower MIN_OPERATIONS in this script.\n`,
  );
  process.exit(2);
}

const violations = findExposureViolations(document);
const byExposure = countByExposure(document);

const permissioned = byExposure.get("permissioned") ?? 0;
const publicOps = byExposure.get("public") ?? 0;
const universal = byExposure.get("universal") ?? 0;
const inService = byExposure.get("in-service") ?? 0;
const exposed = permissioned + publicOps + universal + inService;

process.stdout.write(
  `check-openapi-coverage: ${String(totalOperations)} operations\n` +
  `  x-exposure: ${String(exposed)}/${String(totalOperations)} stamped` +
    ` (permissioned=${String(permissioned)}, public=${String(publicOps)}, universal=${String(universal)}, in-service=${String(inService)})\n`,
);

if (violations.length > 0) {
  process.stderr.write(
    `check-openapi-coverage: FAIL — ${String(violations.length)} operation(s) with missing or invalid x-exposure\n\n`,
  );
  for (const { method, path, issue } of violations.slice(0, 50)) {
    process.stderr.write(`  ${method.padEnd(6)} ${path}\n`);
    process.stderr.write(`         ${issue}\n`);
  }
  if (violations.length > 50)
    process.stderr.write(`  ... and ${String(violations.length - 50)} more\n`);
  process.stderr.write(
    `\nThe document is likely stale. Run: pnpm openapi:generate\n` +
    `If the count is still non-zero after regeneration, recordRouteClassification regressed.\n` +
    `Zombie detection (documented ops with no live handler) requires: pnpm openapi:check\n`,
  );
  process.exit(1);
}

process.stdout.write(`  OK — all ${String(exposed)} operations are exposure-stamped\n`);

const bodylessConflictViolations = findBodylessConflicts(document);
if (bodylessConflictViolations.length > 0) {
  process.stderr.write(
    `check-openapi-coverage: FAIL — ${String(bodylessConflictViolations.length)} operation(s) have x-bodyless-conflict\n` +
    `These handlers are decorated with @BodylessAction() but also read @Body() — the body contract is undocumented.\n` +
    `Fix: remove @BodylessAction() and add @Validate({ body: schema }) or @MultipartAction().\n\n`,
  );
  for (const { method, path, issue } of bodylessConflictViolations.slice(0, 30)) {
    process.stderr.write(`  ${method.padEnd(6)} ${path}\n`);
    process.stderr.write(`         ${issue}\n`);
  }
  if (bodylessConflictViolations.length > 30)
    process.stderr.write(`  ... and ${String(bodylessConflictViolations.length - 30)} more\n`);
  process.exit(1);
}

const errorShapeViolations = findMissingErrorShapes(document);
const errorShapeCovered = totalOperations - errorShapeViolations.length;
const errorShapePct = totalOperations > 0 ? Math.round((errorShapeCovered / totalOperations) * 100) : 0;
process.stdout.write(
  `  error-shapes: ${String(errorShapeCovered)}/${String(totalOperations)} ops have a 4xx $ref (${String(errorShapePct)}%)` +
  ` [threshold: ${String(MIN_ERROR_SHAPE_PCT)}%]\n`,
);
if (errorShapePct < MIN_ERROR_SHAPE_PCT) {
  process.stderr.write(
    `check-openapi-coverage: FAIL — error-shape coverage ${String(errorShapePct)}% is below the ${String(MIN_ERROR_SHAPE_PCT)}% threshold.\n` +
    `Run: pnpm openapi:generate to regenerate with applyErrorResponses injecting standard error refs.\n`,
  );
  if (errorShapeViolations.length > 0) {
    for (const { method, path, issue } of errorShapeViolations.slice(0, 30)) {
      process.stderr.write(`  ${method.padEnd(6)} ${path}  — ${issue}\n`);
    }
    if (errorShapeViolations.length > 30)
      process.stderr.write(`  ... and ${String(errorShapeViolations.length - 30)} more\n`);
  }
  process.exit(1);
}

const responseSchemaViolations = findMissingResponseSchemas(document);
const responseSchemaCovered = totalOperations - responseSchemaViolations.length;
const responseSchemaPct = totalOperations > 0 ? Math.round((responseSchemaCovered / totalOperations) * 100) : 0;
process.stdout.write(
  `  response-schemas: ${String(responseSchemaCovered)}/${String(totalOperations)} ops have a 2xx body (${String(responseSchemaPct)}%)` +
  ` [informational — wire @ResponseSchema() handlers to increase]\n`,
);

const mutatingViolations = findMissingMutatingRequestSchemas(document);
const mutatingTotal = (() => {
  let n = 0;
  const paths = document.paths;
  if (typeof paths === "object" && paths !== null) {
    for (const pathItem of Object.values(paths)) {
      if (typeof pathItem !== "object" || pathItem === null) continue;
      for (const [method, op] of Object.entries(pathItem)) {
        if (!MUTATING_METHODS.has(method)) continue;
        if (typeof op === "object" && op !== null && op["x-bodyless"] === true) continue;
        n++;
      }
    }
  }
  return n;
})();
const mutatingCovered = mutatingTotal - mutatingViolations.length;
const mutatingPct = mutatingTotal > 0 ? Math.round((mutatingCovered / mutatingTotal) * 100) : 100;
process.stdout.write(
  `  request-schemas (mutating): ${String(mutatingCovered)}/${String(mutatingTotal)} ops have a body schema (${String(mutatingPct)}%)` +
  ` [threshold: ${String(MIN_MUTATING_REQUEST_SCHEMA_PCT)}%]\n`,
);
if (mutatingPct < MIN_MUTATING_REQUEST_SCHEMA_PCT) {
  process.stderr.write(
    `check-openapi-coverage: FAIL — mutating request-schema coverage ${String(mutatingPct)}% is below the ${String(MIN_MUTATING_REQUEST_SCHEMA_PCT)}% threshold.\n` +
    `Add @Validate({ body: schema }) to mutating handlers or mark them @BodylessAction().\n`,
  );
  if (mutatingViolations.length > 0) {
    for (const { method, path, issue } of mutatingViolations.slice(0, 30)) {
      process.stderr.write(`  ${method.padEnd(6)} ${path}  — ${issue}\n`);
    }
    if (mutatingViolations.length > 30)
      process.stderr.write(`  ... and ${String(mutatingViolations.length - 30)} more\n`);
  }
  process.exit(1);
}

process.stdout.write("  OK — all coverage thresholds met\n");
process.exit(0);
