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
 *   4. RESPONSE SCHEMAS — coverage means a resolvable content schema, never a
 *      bare Nest-generated status key. Historic uncovered operation ids live in
 *      an exact reviewed ledger and may only disappear. A newly uncovered route,
 *      a covered-route regression, or an equal-count debt swap fails closed.
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

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reportCorpus } from "./gate-corpus.mjs";

const SELF_TEST = process.argv.includes("--self-test");
const EMIT_RESPONSE_DEBT_BASELINE = process.argv.includes("--emit-response-debt-baseline");
const BACKEND_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const OPENAPI_PATH = join(BACKEND_ROOT, "openapi.json");
const RESPONSE_DEBT_BASELINE_PATH = join(
  BACKEND_ROOT,
  "src/scripts/baselines/openapi-response-schema-debt.json",
);

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const MUTATING_METHODS = new Set(["post", "put", "patch"]);
const VALID_EXPOSURES = new Set(["permissioned", "public", "universal", "in-service"]);
const MIN_OPERATIONS = 3000;
const MIN_ERROR_SHAPE_PCT = 95;

/**
 * Operations with NO declared response body schema. A ratchet: it may only go DOWN.
 *
 * CLOSED at 0 on 2026-09-07. Every one of the 3,666 operations declares a response body
 * schema, so this is now a hard 100% requirement and a new handler without a contract reds
 * the gate.
 *
 * The history matters, because the number this gate reported was wrong twice before it was
 * right. It first demanded 100% and reported 3642/3642 — satisfied by the bare 2xx response
 * KEY that NestJS generates for every handler, so the condition was true the moment the
 * document existed. True coverage was 25 of 3,642. Correcting the predicate produced an
 * honest 3,617-operation debt, recorded as a ceiling rather than restored to 100% because a
 * gate that always fails gets muted within a week.
 *
 * Closing it needed two further mechanisms, both of which fail closed:
 *
 *   `@NoContentResponse()` marks a 204 as deliberate. A handler that stamps it while also
 *   carrying a `@ResponseSchema`, or without `@HttpCode(204)`, ends up with NO contract
 *   rather than a false one — a wrong schema is worse than none, since
 *   `ResponseContractInterceptor` throws on mismatch under NODE_ENV=test.
 *
 *   `isVacuousSchema` rejects a root that says nothing: `{}`, a bare `{ type: "object" }`,
 *   an open `additionalProperties` record, an array of those, or an allOf/anyOf/oneOf whose
 *   every member is vacuous. Without it a handler counts as covered by declaring
 *   `z.record(z.string(), z.unknown())`, which is how three of them had been parked.
 *
 * Every schema is compared against the real handler return by `ResponseContractInterceptor`,
 * so none of this coverage is decoration.
 */
const RESPONSE_SCHEMA_UNCOVERED_CEILING = 0;

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

/**
 * A schema that says nothing is not a contract. `{}` (Zod `unknown`/`any`), a bare
 * `{ type: "object" }` with no properties, an object whose only shape is an open
 * `additionalProperties`, or an array of such items would all "resolve" and would
 * let a route count as covered while describing nothing a client could rely on.
 * The published body is the envelope, so the check reads `data` inside it.
 */
export function isVacuousSchema(schema, document) {
  if (typeof schema !== "object" || schema === null) return true;
  if (typeof schema["$ref"] === "string") {
    let node = document;
    for (const segment of schema["$ref"].slice(2).split("/")) {
      if (typeof node !== "object" || node === null) return true;
      node = node[segment.replaceAll("~1", "/").replaceAll("~0", "~")];
    }
    return isVacuousSchema(node, document);
  }
  const properties = schema["properties"];
  if (typeof properties === "object" && properties !== null) {
    const keys = Object.keys(properties);
    if (keys.length === 2 && keys.includes("success") && keys.includes("data"))
      return isVacuousSchema(properties["data"], document);
    return keys.length === 0 && isOpenAdditional(schema["additionalProperties"]);
  }
  if (schema["type"] === "array") return isVacuousSchema(schema["items"], document);
  if (Array.isArray(schema["anyOf"])) return schema["anyOf"].every((s) => isVacuousSchema(s, document));
  if (Array.isArray(schema["oneOf"])) return schema["oneOf"].every((s) => isVacuousSchema(s, document));
  if (Array.isArray(schema["allOf"])) return schema["allOf"].every((s) => isVacuousSchema(s, document));
  if (schema["type"] === "object" || schema["type"] === undefined)
    return isOpenAdditional(schema["additionalProperties"]) && schema["enum"] === undefined && schema["const"] === undefined;
  return false;
}

function isOpenAdditional(additional) {
  if (additional === undefined || additional === true) return true;
  return typeof additional === "object" && additional !== null && Object.keys(additional).length === 0;
}

/** A 204 stamped by `@NoContentResponse` — declared, not auto-generated, and body-less by HTTP. */
export function responseIsDeclaredNoContent(code, response) {
  if (code !== "204") return false;
  if (typeof response !== "object" || response === null) return false;
  return response["x-no-content"] === true && !("content" in response);
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
      schemaResolves(mediaType["schema"], document) &&
      !isVacuousSchema(mediaType["schema"], document),
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
        violations.push({ method: method.toUpperCase(), path: pathTemplate, operationId: operation.operationId, issue: "no responses declared at all" });
        continue;
      }
      const twoXxCodes = Object.keys(responses).filter((code) => {
        const num = parseInt(code, 10);
        return num >= 200 && num < 300;
      });
      if (twoXxCodes.length > 0) {
        const covered = twoXxCodes.some(
          (code) => responseIsDeclaredNoContent(code, responses[code]) || responseHasResolvableSchema(responses[code], document),
        );
        if (!covered) {
          violations.push({
            method: method.toUpperCase(),
            path: pathTemplate,
            operationId: operation.operationId,
            issue: `2xx response (${twoXxCodes.join(", ")}) declares no content schema — a bare auto-generated key is not a contract`,
          });
        }
        continue;
      }
      // No 2xx at all: the genuine non-2xx handler (405 and friends) may declare its body here.
      const nonTwoXxCovered = Object.values(responses).some((resp) => responseHasResolvableSchema(resp, document));
      if (!nonTwoXxCovered) {
        violations.push({ method: method.toUpperCase(), path: pathTemplate, operationId: operation.operationId, issue: "no declared response body schema" });
      }
    }
  }
  return violations;
}

/**
 * A numeric ratchet prevents the debt count growing, but it cannot detect a swap:
 * removing one contract and adding one different uncovered route leaves the count
 * unchanged. The exact operation-id ledger closes that hole. Existing debt may
 * disappear; no operation absent from the reviewed ledger may become uncovered.
 */
export function findNewResponseSchemaDebt(violations, allowedOperationIds) {
  const allowed = new Set(allowedOperationIds);
  return violations.filter(
    (violation) =>
      typeof violation.operationId !== "string" ||
      violation.operationId.length === 0 ||
      !allowed.has(violation.operationId),
  );
}

function readResponseDebtBaseline() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(RESPONSE_DEBT_BASELINE_PATH, "utf8"));
  } catch (error) {
    throw new Error(`cannot read response-schema debt ledger: ${error.message}`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.uncoveredOperationIds) ||
    parsed.uncoveredOperationIds.some((entry) => typeof entry !== "string" || entry.length === 0) ||
    new Set(parsed.uncoveredOperationIds).size !== parsed.uncoveredOperationIds.length
  ) {
    throw new Error("response-schema debt ledger must be version 1 with unique non-empty operation ids");
  }
  return parsed.uncoveredOperationIds;
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
  liveRefDoc.components.schemas = { ...(liveRefDoc.components.schemas ?? {}), Thing: { type: "object", properties: { id: { type: "string" } } } };
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

  const responseVacuous = makeFullDoc([
    { path: "/a", method: "get", responses: { "200": { description: "OK", content: { "application/json": { schema: {} } } } } },
    { path: "/b", method: "get", responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } } } },
    { path: "/c", method: "get", responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: {} } } } } } },
    { path: "/d", method: "get", responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, data: {} }, required: ["success", "data"] } } } } } },
    { path: "/e", method: "get", responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "array", items: {} } } } } } },
    { path: "/f", method: "get", responses: { "200": { description: "OK", content: { "application/json": { schema: { allOf: [{ type: "object" }, {}] } } } } } },
  ]);
  const rsVacuousResult = findMissingResponseSchemas(responseVacuous);
  if (rsVacuousResult.length !== 6)
    fail("vacuous-root-schemas", `expected 6 violations, got ${JSON.stringify(rsVacuousResult)}`);
  else pass("vacuous-root-schemas — {}, a bare object, an open record, an enveloped {}, an array of {} and an allOf of vacuous members do not count");

  const responseVacuousNegatives = makeFullDoc([
    { path: "/a", method: "get", responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, data: { type: "array", items: { type: "object", properties: { id: { type: "string" } } } } } } } } } } },
    { path: "/b", method: "get", responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object", additionalProperties: { type: "number" } } } } } } },
    { path: "/c", method: "get", responses: { "200": { description: "OK", content: { "text/plain": { schema: { type: "string" } } } } } },
    { path: "/d", method: "delete", responses: { "204": { description: "No Content", "x-no-content": true } } },
    { path: "/e", method: "get", responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, data: { allOf: [{ type: "object", properties: { id: { type: "string" } } }, { type: "object", properties: { name: { type: "string" } } }] } }, required: ["success", "data"] } } } } } },
  ]);
  const rsVacuousNeg = findMissingResponseSchemas(responseVacuousNegatives);
  if (rsVacuousNeg.length !== 0)
    fail("non-vacuous-schemas-pass", `expected 0 violations, got ${JSON.stringify(rsVacuousNeg)}`);
  else pass("non-vacuous-schemas-pass — an enveloped typed array, a typed record, a text body, a declared 204 and an allOf intersection of typed objects count");

  const bare204 = makeFullDoc([
    { path: "/d", method: "delete", responses: { "204": { description: "" } } },
  ]);
  const bare204Result = findMissingResponseSchemas(bare204);
  if (bare204Result.length !== 1)
    fail("bare-204-is-not-declared", `expected 1 violation, got ${JSON.stringify(bare204Result)}`);
  else pass("bare-204-is-not-declared — an auto-generated 204 without the x-no-content stamp is flagged");

  const responseSchemaWithNon2xx = makeFullDoc([
    { path: "/b", method: "get", responses: { "405": { description: "Method Not Allowed", content: { "application/json": { schema: { type: "object", properties: { allowed: { type: "array", items: { type: "string" } } } } } } } } },
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

  const exactDebt = [
    { operationId: "LegacyController_list", method: "GET", path: "/legacy" },
  ];
  if (findNewResponseSchemaDebt(exactDebt, ["LegacyController_list"]).length !== 0)
    fail("response-debt-ledger-allows-existing", "reviewed legacy debt must remain allowed while it is retired incrementally");
  else pass("response-debt-ledger-allows-existing — reviewed legacy debt remains bounded");

  const swappedDebt = [
    { operationId: "NewController_list", method: "GET", path: "/new" },
  ];
  if (findNewResponseSchemaDebt(swappedDebt, ["LegacyController_list"]).length !== 1)
    fail("response-debt-ledger-catches-swap", "equal-count replacement debt must fail the exact ledger");
  else pass("response-debt-ledger-catches-swap — equal-count debt swaps cannot bypass the ratchet");

  const anonymousDebt = [{ method: "GET", path: "/anonymous" }];
  if (findNewResponseSchemaDebt(anonymousDebt, []).length !== 1)
    fail("response-debt-ledger-requires-identity", "unidentified uncovered operations must fail closed");
  else pass("response-debt-ledger-requires-identity — uncovered operations without an id fail closed");

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

if (EMIT_RESPONSE_DEBT_BASELINE) {
  const debt = findMissingResponseSchemas(document);
  const operationIds = debt.map((violation) => violation.operationId);
  if (operationIds.some((id) => typeof id !== "string" || id.length === 0)) {
    process.stderr.write("check-openapi-coverage: refusing to emit debt ledger because an uncovered operation has no operationId\n");
    process.exit(2);
  }
  const unique = [...new Set(operationIds)].sort();
  if (unique.length !== operationIds.length) {
    process.stderr.write("check-openapi-coverage: refusing to emit debt ledger because operationId is not unique\n");
    process.exit(2);
  }
  writeFileSync(
    RESPONSE_DEBT_BASELINE_PATH,
    `${JSON.stringify({
      version: 1,
      purpose: "Exact reviewed legacy response-contract debt. Entries may be removed, never added without explicit API-owner review.",
      uncoveredOperationIds: unique,
    }, null, 2)}\n`,
  );
  process.stdout.write(`check-openapi-coverage: wrote ${String(unique.length)} operation ids to ${RESPONSE_DEBT_BASELINE_PATH}\n`);
  process.exit(0);
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
let allowedResponseDebt;
try {
  allowedResponseDebt = readResponseDebtBaseline();
} catch (error) {
  process.stderr.write(`check-openapi-coverage: FAIL — ${error.message}\n`);
  process.exit(2);
}
const newResponseDebt = findNewResponseSchemaDebt(
  responseSchemaViolations,
  allowedResponseDebt,
);
process.stdout.write(
  `  response-schemas: ${String(responseSchemaCovered)}/${String(totalOperations)} ops declare a response body SCHEMA (${responseSchemaPct})\n` +
  `                    ${String(uncovered)} uncovered [ceiling ${String(RESPONSE_SCHEMA_UNCOVERED_CEILING)}, ratchet — may only go down]\n`,
);
if (newResponseDebt.length > 0) {
  process.stderr.write(
    `check-openapi-coverage: FAIL — ${String(newResponseDebt.length)} newly uncovered response contract(s) are absent from the reviewed debt ledger.\n` +
    `This fails even when the total debt count is unchanged: contract swaps are regressions.\n`,
  );
  for (const { method, path, operationId, issue } of newResponseDebt.slice(0, 30)) {
    process.stderr.write(`  ${method.padEnd(6)} ${path} (${String(operationId ?? "missing operationId")}) — ${issue}\n`);
  }
  process.exit(1);
}
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
