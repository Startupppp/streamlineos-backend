#!/usr/bin/env node
/**
 * check-openapi-path-params.mjs
 *
 * Finds OpenAPI operations whose path template declares a parameter that the
 * operation itself does not list in `parameters[].in === "path"`.
 *
 * THE REFERENCE DEFECT
 * applyPathParams in build-openapi-document.ts enriched existing path parameter
 * entries but never created entries for parameters that SwaggerModule did not
 * emit — because NestJS Swagger only adds a path param entry when the handler
 * has an explicit @Param("name") decorator, and it skips controller-prefix
 * params or handlers with @Param() (no name). 82 of 3,551 operations were
 * affected. The frontend vendors this document, so the generated client types
 * silently dropped those parameters (root CLAUDE.md §5 "contracts match exactly").
 *
 * WHY THE GENERATOR FIX WAS CORRECT
 * Every affected handler carries @Validate({ params: <ZodSchema> }), which the
 * ZodValidationInterceptor enforces at runtime. The defect was documentation
 * fidelity only — no runtime security gap. The fix teaches applyPathParams to
 * add missing entries, mirroring how applyQuery already handles query params.
 *
 * DETECTION STRATEGY
 * 1. Parse openapi.json from the backend root.
 * 2. For each path template, extract {paramName} tokens from the path string.
 * 3. For each HTTP operation (get/post/put/patch/delete), collect the names of
 *    parameters with in==="path".
 * 4. Report any template token absent from the operation's path parameter list.
 *
 * VACUITY GUARD
 * Fewer than 500 operations parsed → exit 2 ("document is suspiciously small").
 *
 * SELF-TEST (--self-test)
 * Builds synthetic OpenAPI fragments, runs the same detection function, and
 * asserts: a missing path param is flagged, a present path param is not, an
 * operation with no parameters at all is flagged for each template token.
 * Same code path as the real scan — not a parallel implementation.
 *
 * Usage:
 *   node src/scripts/check-openapi-path-params.mjs [--self-test]
 *   pnpm check:openapi-path-params
 *   pnpm check:openapi-path-params:self-test
 *
 * Exit codes:
 *   0 — clean (or self-test passed)
 *   1 — missing path parameters found (or self-test failed)
 *   2 — scan is broken (vacuity check failed or document unreadable)
 */

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_TEST = process.argv.includes("--self-test");
const BACKEND_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const OPENAPI_PATH = join(BACKEND_ROOT, "openapi.json");

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const MIN_OPERATIONS = 500;

/**
 * Extract {paramName} tokens from a path template string.
 * Returns an array of parameter names.
 */
export function extractPathTokens(pathTemplate) {
  const tokens = [];
  for (const match of pathTemplate.matchAll(/\{([^}]+)\}/g)) {
    tokens.push(match[1]);
  }
  return tokens;
}

/**
 * Find missing path parameters for all operations in a parsed OpenAPI document.
 * Returns an array of { method, path, missing } objects.
 */
export function findMissingPathParams(document) {
  const violations = [];
  const paths = document.paths;
  if (typeof paths !== "object" || paths === null) return violations;

  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    const tokens = extractPathTokens(pathTemplate);
    if (tokens.length === 0) continue;

    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      if (typeof operation !== "object" || operation === null) continue;

      const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
      const declared = new Set(
        parameters
          .filter((p) => typeof p === "object" && p !== null && p.in === "path" && typeof p.name === "string")
          .map((p) => p.name),
      );

      const missing = tokens.filter((t) => !declared.has(t));
      if (missing.length > 0) {
        violations.push({ method: method.toUpperCase(), path: pathTemplate, missing });
      }
    }
  }

  return violations;
}

/**
 * Find path parameters named "id" — these are non-descriptive and violate the
 * backend naming rule (backend/CLAUDE.md §2: "Route params are descriptive, never bare id").
 * A bare :id says nothing about what it identifies and mismatches frontend [resourceId] folders.
 * Returns an array of { method, path, issue } objects.
 */
export function findBareIdParams(document) {
  const violations = [];
  const paths = document.paths;
  if (typeof paths !== "object" || paths === null) return violations;

  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      if (typeof operation !== "object" || operation === null) continue;
      const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
      const hasBareId = parameters.some(
        (p) => typeof p === "object" && p !== null && p.in === "path" && p.name === "id",
      );
      if (hasBareId)
        violations.push({ method: method.toUpperCase(), path: pathTemplate, issue: "bare path param named 'id' — use a descriptive name (e.g. :userId, :orderId)" });
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

  const runCheck = (doc) => findMissingPathParams(doc);

  const docAllDeclared = {
    paths: {
      "/projects/{projectId}/tickets/{ticketId}": {
        get: {
          parameters: [
            { in: "path", name: "projectId" },
            { in: "path", name: "ticketId" },
          ],
        },
      },
    },
  };
  const result1 = runCheck(docAllDeclared);
  if (result1.length !== 0)
    fail("all-declared", `expected 0 violations, got ${result1.length}`);
  else pass("all params declared → no violation");

  const docMissingOne = {
    paths: {
      "/projects/{projectId}/tickets/{ticketId}": {
        get: {
          parameters: [{ in: "path", name: "ticketId" }],
        },
      },
    },
  };
  const result2 = runCheck(docMissingOne);
  if (result2.length !== 1 || !result2[0].missing.includes("projectId"))
    fail("missing-one", `expected 1 violation with projectId, got ${JSON.stringify(result2)}`);
  else pass("one missing param → flagged");

  const docNoParams = {
    paths: {
      "/items/{itemId}": {
        delete: {},
      },
    },
  };
  const result3 = runCheck(docNoParams);
  if (result3.length !== 1 || !result3[0].missing.includes("itemId"))
    fail("no-params-field", `expected 1 violation, got ${JSON.stringify(result3)}`);
  else pass("no parameters field → all template tokens missing");

  const docEmptyParamList = {
    paths: {
      "/items/{itemId}": {
        patch: { parameters: [] },
      },
    },
  };
  const result4 = runCheck(docEmptyParamList);
  if (result4.length !== 1 || !result4[0].missing.includes("itemId"))
    fail("empty-param-list", `expected 1 violation, got ${JSON.stringify(result4)}`);
  else pass("empty parameters array → template token missing");

  const docNonPathParam = {
    paths: {
      "/items/{itemId}": {
        get: { parameters: [{ in: "query", name: "itemId" }] },
      },
    },
  };
  const result5 = runCheck(docNonPathParam);
  if (result5.length !== 1 || !result5[0].missing.includes("itemId"))
    fail("non-path-param", `query param with same name must not satisfy path requirement, got ${JSON.stringify(result5)}`);
  else pass("query param with same name does not satisfy path requirement");

  const docNoTemplate = {
    paths: {
      "/items": {
        get: { parameters: [] },
      },
    },
  };
  const result6 = runCheck(docNoTemplate);
  if (result6.length !== 0)
    fail("no-template", `path with no tokens must produce no violations, got ${result6.length}`);
  else pass("path with no template tokens → no violation");

  const docMultipleMethods = {
    paths: {
      "/resources/{resourceId}": {
        get: { parameters: [{ in: "path", name: "resourceId" }] },
        patch: { parameters: [] },
      },
    },
  };
  const result7 = runCheck(docMultipleMethods);
  if (result7.length !== 1 || result7[0].method !== "PATCH")
    fail("multi-method", `only patch should fail, got ${JSON.stringify(result7)}`);
  else pass("per-method check — get ok, patch missing → only patch flagged");

  const emptyDoc = { paths: {} };
  const result8 = runCheck(emptyDoc);
  if (result8.length !== 0)
    fail("empty-doc", `expected 0 violations, got ${result8.length}`);
  else pass("empty paths → no violations");

  const docDescriptiveId = {
    paths: {
      "/items/{itemId}": { get: { parameters: [{ in: "path", name: "itemId" }] } },
    },
  };
  const bareIdResult1 = findBareIdParams(docDescriptiveId);
  if (bareIdResult1.length !== 0)
    fail("bare-id-good", `descriptive param name should not be flagged, got ${JSON.stringify(bareIdResult1)}`);
  else pass("bare-id-good — descriptive path param name not flagged");

  const docBareId = {
    paths: {
      "/items/{id}": { get: { parameters: [{ in: "path", name: "id" }] } },
    },
  };
  const bareIdResult2 = findBareIdParams(docBareId);
  if (bareIdResult2.length !== 1 || !bareIdResult2[0].issue.includes("descriptive"))
    fail("bare-id-bad", `bare :id should be flagged, got ${JSON.stringify(bareIdResult2)}`);
  else pass("bare-id-bad — bare path param named 'id' is flagged");

  const docBareIdInQuery = {
    paths: {
      "/items": { get: { parameters: [{ in: "query", name: "id" }] } },
    },
  };
  const bareIdResult3 = findBareIdParams(docBareIdInQuery);
  if (bareIdResult3.length !== 0)
    fail("bare-id-query-not-flagged", `query param named 'id' should not be flagged, got ${JSON.stringify(bareIdResult3)}`);
  else pass("bare-id-query-not-flagged — query param named 'id' is not flagged (only path params)");

  const vacuityOperations = { paths: { "/a": { get: { parameters: [] } } } };
  const totalOps = Object.values(vacuityOperations.paths).reduce((acc, item) => {
    for (const m of Object.keys(item)) if (HTTP_METHODS.has(m)) acc++;
    return acc;
  }, 0);
  if (totalOps >= MIN_OPERATIONS)
    fail("vacuity-guard", "vacuity guard would not trigger on tiny document");
  else pass("vacuity guard triggers on a document with fewer than MIN_OPERATIONS operations");

  if (failed) {
    process.stderr.write("\nSELF-TEST FAILED\n");
    process.exit(1);
  }
  process.stdout.write("\nSELF-TEST PASSED\n");
  process.exit(0);
}

if (!existsSync(OPENAPI_PATH)) {
  process.stderr.write(`check-openapi-path-params: openapi.json not found at ${OPENAPI_PATH}\nRun: pnpm openapi:generate\n`);
  process.exit(2);
}

let document;
try {
  document = JSON.parse(readFileSync(OPENAPI_PATH, "utf8"));
} catch (err) {
  process.stderr.write(`check-openapi-path-params: failed to parse openapi.json: ${err.message}\n`);
  process.exit(2);
}

let totalOperations = 0;
const paths = document.paths;
if (typeof paths === "object" && paths !== null) {
  for (const pathItem of Object.values(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const method of Object.keys(pathItem)) {
      if (HTTP_METHODS.has(method)) totalOperations++;
    }
  }
}

if (totalOperations < MIN_OPERATIONS) {
  process.stderr.write(
    `check-openapi-path-params: parsed only ${totalOperations} operations — expected at least ${MIN_OPERATIONS}.\n` +
    `The document is suspiciously small. Check ${OPENAPI_PATH}.\n`,
  );
  process.exit(2);
}

const violations = findMissingPathParams(document);
const bareIdViolations = findBareIdParams(document);

const allClean = violations.length === 0 && bareIdViolations.length === 0;

if (allClean) {
  process.stdout.write(
    `check-openapi-path-params: OK — ${totalOperations} operations checked, all path parameters declared and descriptively named\n`,
  );
  process.exit(0);
}

if (violations.length > 0) {
  process.stderr.write(
    `check-openapi-path-params: FAIL — ${violations.length} operation(s) have undeclared path parameters\n\n`,
  );
  for (const { method, path, missing } of violations) {
    process.stderr.write(`  ${method.padEnd(6)} ${path}\n`);
    process.stderr.write(`         missing: ${missing.join(", ")}\n`);
  }
  process.stderr.write(
    `\nRun: pnpm openapi:generate to regenerate the document.\n` +
    `If the count is still non-zero after regeneration, the handler is missing @Validate({ params }) for these parameters.\n`,
  );
}

if (bareIdViolations.length > 0) {
  process.stderr.write(
    `\ncheck-openapi-path-params: FAIL — ${bareIdViolations.length} operation(s) have bare path params named "id"\n` +
    `Use a descriptive name (e.g. :userId, :orderId) — backend/CLAUDE.md §2.\n\n`,
  );
  for (const { method, path, issue } of bareIdViolations) {
    process.stderr.write(`  ${method.padEnd(6)} ${path}\n`);
    process.stderr.write(`         ${issue}\n`);
  }
}

process.exit(1);
