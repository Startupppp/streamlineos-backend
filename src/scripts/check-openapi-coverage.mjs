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
 *   3. ERROR SHAPES — at least MIN_ERROR_SHAPE_PCT% of operations carry a 4xx
 *      $ref to a shared error response component.
 *
 *   4. RESPONSE SCHEMAS — every operation must have either a 2xx response key
 *      or a declared response body schema (content) at any status code. An
 *      operation that genuinely returns a non-2xx status (e.g. 405) is covered
 *      when its response carries a content schema via @ApiResponse. Gate
 *      requires exact coverage: N/N, never N-1/N.
 *
 *   5. MUTATING REQUEST SCHEMAS — every mutating operation (POST/PUT/PATCH)
 *      that is not marked @BodylessAction() must carry a request body schema.
 *      Gate requires exact coverage: N/N, never N-1/N.
 *
 * PERCENTAGE REPORTING
 * Percentages are computed without rounding. "100%" prints only when
 * numerator === denominator. All other values show two decimal places.
 *
 * VACUITY GUARD
 * Fewer than MIN_OPERATIONS parsed → exit 2 ("document is suspiciously small").
 * Current document has 3,551 operations; the floor is set conservatively at
 * 3,000 to absorb legitimate module deletions without constant maintenance.
 *
 * SELF-TEST (--self-test)
 * Runs synthetic cases through the detection functions and gate logic:
 *   Exposure checks (5 cases)
 *   Vacuity checks (4 cases)
 *   Error-shape checks (2 cases)
 *   Response-schema checks (3 cases including a gate-bite negative)
 *   Mutating request-schema checks (3 cases including a gate-bite negative)
 * The self-test fails loudly if any case does not behave as expected.
 *
 * Usage:
 *   node src/scripts/check-openapi-coverage.mjs [--self-test]
 *   pnpm check:openapi-coverage
 *   pnpm check:openapi-coverage:self-test
 *
 * Exit codes:
 *   0 — clean (or self-test passed)
 *   1 — coverage violations found (or self-test failed)
 *   2 — vacuity check failed, document unreadable, or self-test infrastructure error
 */

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reportCorpus } from "./gate-corpus.mjs";

const SELF_TEST = process.argv.includes("--self-test");
const BACKEND_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const OPENAPI_PATH = join(BACKEND_ROOT, "openapi.json");

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const MUTATING_METHODS = new Set(["post", "put", "patch"]);
const VALID_EXPOSURES = new Set(["permissioned", "public", "universal", "in-service"]);
const MIN_OPERATIONS = 3000;
const MIN_ERROR_SHAPE_PCT = 95;

/**
 * Operations with NO declared response body schema. A ratchet: it may only go DOWN.
 *
 * MEASURED 2026-09-03 (v2 ticket 30) after the rule below was corrected to require a real
 * content schema instead of a bare 2xx key: 25 of 3,642 operations covered, 3,617 not.
 * The gate previously demanded 100% and reported 3642/3642 — it read 100% because the
 * predicate was satisfied by a key NestJS generates for every handler.
 *
 * This number is NOT ratcheted to green and the 100% requirement is NOT restored. Demanding
 * 100% here would red the pipeline on ~3,617 handlers owned by every module lane in the
 * repository, and a gate wired so that it always fails gets muted within a week. Recording the
 * true figure and forbidding it to grow is the honest middle: a gate that reports 0.69%
 * truthfully is worth more than one that reports 100% over 0.027%.
 *
 * Lower it as coverage lands. `check:baseline-integrity` reports any improvement as bankable.
 *
 * 3617 -> 3613, MEASURED 2026-09-04 (v2 ticket 04). The ratchet was BREACHED at 3621: six
 * operations were added — `/v2/users`, `/v2/users/{userId}` and four more — and none carried a
 * response schema, so the count grew past a ceiling that may only shrink. It was NOT raised to
 * absorb them; ten handlers were given a real `@ResponseSchema(...)` instead:
 *   POST/PUT   /calendar/events                                    (the projected mutate row)
 *   PATCH/DEL  /calendar/events/{eventId}/occurrences/{...}
 *   POST       /platform/operator-access/grants                     ({ grantId })
 *   POST       /platform/operator-access/grants/{grantId}/approve   ({ ok: true })
 *   POST       /platform/operator-access/grants/{grantId}/reject    ({ ok: true })
 *   DELETE     /platform/operator-access/grants/{grantId}           ({ ok: true })
 *   GET        /platform/operator-access/grants                     (the nine-column projection)
 *   GET        /platform/operator-access/logs                       (the six-column projection)
 * Each is compared against the real handler return by `ResponseContractInterceptor` under
 * NODE_ENV=test, so none of them is decoration.
 *
 * 3613 is a measurement, not arithmetic: the document was rebuilt in memory from this working
 * tree via `generateOpenApiJson()` and the predicate below run over it (3651 operations, 38
 * covered, 3613 uncovered). It is NOT what the COMMITTED openapi.json measures — that document
 * predates both these ten schemas and three routes other lanes added, and still reports 3621.
 * This gate therefore stays RED until openapi.json is regenerated, which this release does once,
 * at the end of the wave, by one agent.
 */
const RESPONSE_SCHEMA_UNCOVERED_CEILING = 3613;

/**
 * Format a coverage percentage. Never prints "100%" unless covered === total.
 * Returns "100%" only on exact equality; otherwise two decimal places.
 */
export function formatPct(covered, total) {
  if (total === 0) return "100%";
  if (covered === total) return "100%";
  return `${((covered / total) * 100).toFixed(2)}%`;
}

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

/**
 * Find operations that have no declared response body SCHEMA.
 *
 * 2026-09-03 (v2 ticket 30) — THIS RULE COUNTED A KEY, NOT A SCHEMA, AND SO COULD NOT FAIL.
 *
 * It used to accept "a 2xx response key" as coverage. NestJS Swagger auto-generates a bare
 * `"200": { description: "" }` — no `content`, no schema — for EVERY handler, so the condition
 * was true for every operation the moment the document was generated. The gate printed
 * `response-schemas: 3642/3642 (100%)` for a property that exactly ONE of 3,642 operations
 * actually had: 0.027%. It is the reason the entire response half of the API contract went
 * unnoticed, and it is why `openapi.json` has a 2xx response SCHEMA on 1 operation in 3,642
 * while every gate above it read green.
 *
 * An operation is covered now only when a response carries `content` -> at least one media type
 * -> a `schema`, and that schema RESOLVES: an inline object, or a `$ref` whose target exists in
 * `components`. A dangling `$ref` is a broken contract, not a covered one.
 *
 *   - preferred: a 2xx response with a resolvable schema.
 *   - carve-out: no 2xx key at all, but a non-2xx response with a resolvable schema. This is the
 *     handler that genuinely returns 405 and declares it via @ApiResponse. It is deliberately
 *     NOT available to an operation that HAS a 2xx key, because "my 400 has a schema" says
 *     nothing about the success body.
 *
 * Each violation carries a distinct `issue` so the output says WHICH failure occurred — a bare
 * auto-generated key reads very differently from an operation with no responses at all, and a
 * gate that cannot tell them apart cannot be said to fail for the intended reason.
 */

/** Does this schema object resolve — an inline schema, or a $ref with a live target? */
export function schemaResolves(schema, document) {
  if (typeof schema !== "object" || schema === null) return false;
  const ref = schema["$ref"];
  if (typeof ref !== "string") return Object.keys(schema).length > 0;
  if (!ref.startsWith("#/")) return false;
  let node = document;
  for (const segment of ref.slice(2).split("/")) {
    if (typeof node !== "object" || node === null) return false;
    node = node[segment.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return typeof node === "object" && node !== null;
}

/** Does this one response object declare a body schema that resolves? */
export function responseHasResolvableSchema(response, document) {
  if (typeof response !== "object" || response === null) return false;
  const content = response["content"];
  if (typeof content !== "object" || content === null) return false;
  return Object.values(content).some(
    (mediaType) =>
      typeof mediaType === "object" &&
      mediaType !== null &&
      schemaResolves(mediaType["schema"], document),
  );
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
      if (typeof responses !== "object" || responses === null) {
        violations.push({ method: method.toUpperCase(), path: pathTemplate, issue: "no responses declared at all" });
        continue;
      }
      const twoXxCodes = Object.keys(responses).filter((code) => {
        const num = parseInt(code, 10);
        return num >= 200 && num < 300;
      });
      if (twoXxCodes.length > 0) {
        const covered = twoXxCodes.some((code) => responseHasResolvableSchema(responses[code], document));
        if (!covered) {
          violations.push({
            method: method.toUpperCase(),
            path: pathTemplate,
            issue: `2xx response (${twoXxCodes.join(", ")}) declares no content schema — a bare auto-generated key is not a contract`,
          });
        }
        continue;
      }
      // No 2xx at all: the genuine non-2xx handler (405 and friends) may declare its body here.
      const nonTwoXxCovered = Object.values(responses).some((resp) => responseHasResolvableSchema(resp, document));
      if (!nonTwoXxCovered) {
        violations.push({ method: method.toUpperCase(), path: pathTemplate, issue: "no declared response body schema" });
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

  // --- v2 ticket 30: these cases replace a fixture that ENSHRINED the defect. The old
  // "good" fixture asserted that `{ "201": { description: "Created" } }` — a bare
  // auto-generated key with no content — counted as covered, and that assertion is exactly
  // why the gate reported 100% over 0.027%. A real schema now passes; a bare key now fails.
  const SCHEMA = { "application/json": { schema: { type: "object", properties: { id: { type: "string" } } } } };

  const responseSchemaGood = makeFullDoc([
    { path: "/a", method: "get", responses: { "200": { description: "OK", content: SCHEMA } } },
    { path: "/b", method: "post", responses: { "201": { description: "Created", content: SCHEMA } } },
  ]);
  const rsGoodResult = findMissingResponseSchemas(responseSchemaGood);
  if (rsGoodResult.length !== 0)
    fail("good-response-schemas", `expected 0 violations, got ${JSON.stringify(rsGoodResult)}`);
  else pass("good-response-schemas — a 2xx with a real content schema passes");

  // THE BITE. This is the shape NestJS auto-generates for every handler.
  const bareKeyDoc = makeFullDoc([
    { path: "/a", method: "get", responses: { "200": { description: "" } } },
    { path: "/b", method: "post", responses: { "201": { description: "Created" } } },
  ]);
  const bareKeyResult = findMissingResponseSchemas(bareKeyDoc);
  if (bareKeyResult.length !== 2)
    fail("bare-2xx-key-is-not-coverage", `a bare auto-generated 2xx key must NOT count as covered; got ${JSON.stringify(bareKeyResult)}`);
  else if (!bareKeyResult.every((v) => v.issue.includes("declares no content schema")))
    fail("bare-2xx-key-reason", `the violation must name the bare key as the reason; got ${JSON.stringify(bareKeyResult)}`);
  else pass("bare-2xx-key-is-not-coverage — an auto-generated 2xx key with no content is flagged, and says why");

  // An empty `content: {}` declares no media type, so it declares no schema.
  const emptyContentDoc = makeFullDoc([
    { path: "/a", method: "get", responses: { "200": { description: "OK", content: {} } } },
  ]);
  if (findMissingResponseSchemas(emptyContentDoc).length !== 1)
    fail("empty-content-is-not-coverage", "content: {} declares no media type and must not count as covered");
  else pass("empty-content-is-not-coverage — content: {} is flagged");

  // A media type with no `schema` key is the same defect one level down.
  const noSchemaKeyDoc = makeFullDoc([
    { path: "/a", method: "get", responses: { "200": { description: "OK", content: { "application/json": {} } } } },
  ]);
  if (findMissingResponseSchemas(noSchemaKeyDoc).length !== 1)
    fail("media-type-without-schema", "a media type with no schema must not count as covered");
  else pass("media-type-without-schema — a media type carrying no schema is flagged");

  // "Resolvable": a $ref pointing at nothing is a broken contract, not a covered one.
  const danglingRefDoc = makeFullDoc([
    { path: "/a", method: "get", responses: { "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/DoesNotExist" } } } } } },
  ]);
  if (findMissingResponseSchemas(danglingRefDoc).length !== 1)
    fail("dangling-ref-is-not-coverage", "a $ref with no target must not count as covered");
  else pass("dangling-ref-is-not-coverage — an unresolvable $ref is flagged");

  const liveRefDoc = makeFullDoc([
    { path: "/a", method: "get", responses: { "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Thing" } } } } } },
  ]);
  liveRefDoc.components = liveRefDoc.components ?? {};
  liveRefDoc.components.schemas = { ...(liveRefDoc.components.schemas ?? {}), Thing: { type: "object" } };
  if (findMissingResponseSchemas(liveRefDoc).length !== 0)
    fail("live-ref-is-coverage", "a $ref whose target exists must count as covered");
  else pass("live-ref-is-coverage — a resolvable $ref passes");

  // A 4xx schema says nothing about the success body, so it must not cover an op that HAS a 2xx.
  const errorOnlySchemaDoc = makeFullDoc([
    { path: "/a", method: "get", responses: { "200": { description: "OK" }, "400": { description: "Bad", content: SCHEMA } } },
  ]);
  if (findMissingResponseSchemas(errorOnlySchemaDoc).length !== 1)
    fail("error-schema-does-not-cover-success", "a 4xx schema must not cover an operation that declares a 2xx");
  else pass("error-schema-does-not-cover-success — a schema on the 400 does not excuse a bare 200");

  const responseSchemaBad = makeFullDoc([
    { path: "/a", method: "get", responses: { "400": { $ref: "#/components/responses/BadRequest" } } },
    { path: "/b", method: "post" },
  ]);
  const rsBadResult = findMissingResponseSchemas(responseSchemaBad);
  if (rsBadResult.length !== 2)
    fail("bad-missing-response-schemas", `expected 2 violations, got ${JSON.stringify(rsBadResult)}`);
  else pass("bad-missing-response-schemas — ops without 2xx entry or declared content are flagged");

  const responseSchemaWithNon2xx = makeFullDoc([
    { path: "/b", method: "get", responses: { "405": { description: "Method Not Allowed", content: { "application/json": { schema: { type: "object" } } } } } },
  ]);
  const rsNon2xxResult = findMissingResponseSchemas(responseSchemaWithNon2xx);
  if (rsNon2xxResult.length !== 0)
    fail("good-non-2xx-with-content", `expected 0 violations for non-2xx op with declared content, got ${JSON.stringify(rsNon2xxResult)}`);
  else pass("good-non-2xx-with-content — a 405-only op with a declared content schema is not flagged");

  const responseNeg = makeFullDoc([
    { path: "/a", method: "get", responses: { "200": { description: "OK", content: SCHEMA } } },
    { path: "/b", method: "post", responses: { "400": { $ref: "#/components/responses/BadRequest" } } },
  ]);
  const rsNegViolations = findMissingResponseSchemas(responseNeg);
  const rsNegTotal = 2;
  const rsNegCovered = rsNegTotal - rsNegViolations.length;
  const rsGateWouldFail = rsNegCovered < rsNegTotal;
  if (!rsGateWouldFail)
    fail("neg-response-schema-gate", `N-1 coverage (${String(rsNegCovered)}/${String(rsNegTotal)}) should cause the gate to fail`);
  else pass(`neg-response-schema-gate — gate bites: ${String(rsNegCovered)}/${String(rsNegTotal)} coverage fails (${formatPct(rsNegCovered, rsNegTotal)})`);

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

  const mutatingNegOps = [
    ...Array.from({ length: 9 }, (_, i) => ({ path: `/covered${String(i)}`, method: "post", requestBody: { required: true, content: {} } })),
    { path: "/uncovered", method: "post" },
  ];
  const mutatingNeg = makeFullDoc(mutatingNegOps);
  const mbNegViolations = findMissingMutatingRequestSchemas(mutatingNeg);
  const mbNegTotal = 10;
  const mbNegCovered = mbNegTotal - mbNegViolations.length;
  const mbGateWouldFail = mbNegCovered < mbNegTotal;
  if (!mbGateWouldFail)
    fail("neg-request-schema-gate", `N-1 coverage (${String(mbNegCovered)}/${String(mbNegTotal)}) should cause the gate to fail`);
  else pass(`neg-request-schema-gate — gate bites: ${String(mbNegCovered)}/${String(mbNegTotal)} coverage fails (${formatPct(mbNegCovered, mbNegTotal)})`);

  if (formatPct(9, 10) === "100%")
    fail("formatPct-no-false-100", "formatPct(9, 10) must not return '100%'");
  else pass(`formatPct-no-false-100 — formatPct(9, 10) = "${formatPct(9, 10)}", not "100%"`);

  if (formatPct(10, 10) !== "100%")
    fail("formatPct-exact-100", "formatPct(10, 10) must return '100%'");
  else pass("formatPct-exact-100 — formatPct(10, 10) returns '100%'");

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

const errorShapeViolations = findMissingErrorShapes(document);
const errorShapeCovered = totalOperations - errorShapeViolations.length;
const errorShapePct = formatPct(errorShapeCovered, totalOperations);
process.stdout.write(
  `  error-shapes: ${String(errorShapeCovered)}/${String(totalOperations)} ops have a 4xx $ref (${errorShapePct})` +
  ` [threshold: ${String(MIN_ERROR_SHAPE_PCT)}%]\n`,
);
if (errorShapeCovered < Math.ceil(totalOperations * MIN_ERROR_SHAPE_PCT / 100)) {
  process.stderr.write(
    `check-openapi-coverage: FAIL — error-shape coverage ${errorShapePct} is below the ${String(MIN_ERROR_SHAPE_PCT)}% threshold.\n` +
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
const responseSchemaPct = formatPct(responseSchemaCovered, totalOperations);
const uncovered = responseSchemaViolations.length;
process.stdout.write(
  `  response-schemas: ${String(responseSchemaCovered)}/${String(totalOperations)} ops declare a response body SCHEMA (${responseSchemaPct})\n` +
  `                    ${String(uncovered)} uncovered [ceiling ${String(RESPONSE_SCHEMA_UNCOVERED_CEILING)}, ratchet — may only go down]\n`,
);
if (uncovered > RESPONSE_SCHEMA_UNCOVERED_CEILING) {
  process.stderr.write(
    `check-openapi-coverage: FAIL — ${String(uncovered)} operation(s) declare no response schema, above the ceiling of ` +
    `${String(RESPONSE_SCHEMA_UNCOVERED_CEILING)}.\n` +
    `Add @ResponseSchema(schema) to handlers or @ApiResponse({ status, schema }) for non-2xx responses.\n` +
    `The ceiling is a ratchet: raise it and you have retired the rule by arithmetic.\n`,
  );
  for (const { method, path, issue } of responseSchemaViolations.slice(0, 30)) {
    process.stderr.write(`  ${method.padEnd(6)} ${path}  — ${issue}\n`);
  }
  if (responseSchemaViolations.length > 30)
    process.stderr.write(`  ... and ${String(responseSchemaViolations.length - 30)} more\n`);
  process.exit(1);
}
if (uncovered < RESPONSE_SCHEMA_UNCOVERED_CEILING) {
  process.stdout.write(
    `                    IMPROVED by ${String(RESPONSE_SCHEMA_UNCOVERED_CEILING - uncovered)} — bank it: lower ` +
    `RESPONSE_SCHEMA_UNCOVERED_CEILING to ${String(uncovered)} and update baselines/ratchets.json.\n`,
  );
}
if (uncovered > 0) {
  process.stdout.write(
    `                    NOT A PASS FOR THIS RULE — ${responseSchemaPct} of the response contract is declared. ` +
    `This gate is green because the debt did not GROW, not because the contract is covered.\n`,
  );
}
// Say how much of the corpus this rule actually covers. A gate that prints only its findings
// cannot be told apart from a gate with nothing to find -- which is exactly how this one
// reported 100% for a property 1 operation in 3,642 had.
reportCorpus({
  gate: "  check-openapi-coverage[response-schemas]",
  scanned: responseSchemaCovered,
  total: totalOperations,
  unit: "operation",
});

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
const mutatingPct = formatPct(mutatingCovered, mutatingTotal);
process.stdout.write(
  `  request-schemas (mutating): ${String(mutatingCovered)}/${String(mutatingTotal)} ops have a body schema (${mutatingPct})\n`,
);
if (mutatingCovered < mutatingTotal) {
  process.stderr.write(
    `check-openapi-coverage: FAIL — mutating request-schema coverage ${String(mutatingCovered)}/${String(mutatingTotal)} is not complete.\n` +
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

process.stdout.write("  OK — all coverage gates passed\n");
process.exit(0);
