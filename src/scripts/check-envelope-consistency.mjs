#!/usr/bin/env node
/**
 * check-envelope-consistency.mjs  (section 7.1 — response/error envelope gate)
 *
 * WHAT IT CHECKS (OpenAPI document static analysis)
 *
 * 1. ERROR ENVELOPE — every 4xx and 5xx response on every operation should
 *    reference a shared error component (via $ref to #/components/responses/).
 *    Inline error schemas that differ per operation create frontend contract drift
 *    and make centralized error handling impossible.
 *
 * 2. PAGINATION ENVELOPE — every paginated collection endpoint (detected by
 *    the presence of a "cursor" or "page" query param AND a 200 response) should
 *    have a 200 response schema that references a component schema whose name
 *    contains "Paginated", "Page", or "Cursor", OR whose properties include
 *    "data" and at least one of "nextCursor", "cursor", "total", "page",
 *    "hasMore", "meta". A bare array response on a paginated endpoint is a
 *    contract mismatch with the frontend's envelope expectation.
 *
 * 3. SHARED COMPONENTS — the document must declare at least the four standard
 *    error components (BadRequest, Unauthorized, Forbidden, NotFound) under
 *    components.responses. If these are absent the error-ref checks above
 *    cannot pass.
 *
 * 4. SUCCESS ENVELOPE CONSISTENCY — collection responses that declare 200
 *    content should not mix raw-array schemas alongside paginated envelopes.
 *    Both patterns may be intentional for streaming/legacy routes, so this is
 *    reported, not failed on.
 *
 * SELF-TEST (--self-test)
 * Proves each check category bites on a known-bad fixture.
 *
 * Usage:
 *   node src/scripts/check-envelope-consistency.mjs [--self-test]
 *   pnpm check:envelope-consistency
 *
 * Exit codes:
 *   0 — no violations (or self-test passed)
 *   1 — violations found, or self-test failed
 *   2 — document unreadable
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reportCorpus } from "./gate-corpus.mjs";

const SELF_TEST = process.argv.includes("--self-test");
const BACKEND_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const OPENAPI_PATH = join(BACKEND_ROOT, "openapi.json");

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const REQUIRED_ERROR_COMPONENTS = ["BadRequest", "Unauthorized", "Forbidden", "NotFound"];
const PAGINATION_SIGNALS = ["nextCursor", "cursor", "total", "page", "hasMore", "meta", "pagination"];

function has4xxRef(responses) {
  if (typeof responses !== "object" || responses === null) return false;
  for (const [code, resp] of Object.entries(responses)) {
    const num = parseInt(code, 10);
    if (num < 400 || num >= 600) continue;
    if (typeof resp === "object" && resp !== null && typeof resp["$ref"] === "string") return true;
  }
  return false;
}

function isPaginatedEndpoint(operation) {
  return (operation.parameters ?? []).some(
    (p) => typeof p === "object" && p !== null && ["cursor", "after", "page", "offset"].includes(String(p.name ?? "")),
  );
}

function has200Response(operation) {
  return Object.keys(operation.responses ?? {}).some((c) => parseInt(c, 10) >= 200 && parseInt(c, 10) < 300);
}

/**
 * Unwrap this API's standard `{ success, data }` response envelope.
 *
 * 2026-09-03 (v2 ticket 30). Every handler here answers inside that envelope, so the pagination
 * signal lives on `data`, never at the top level -- where the only properties are `success` and
 * `data`, neither of which is a signal. The rule below read the OUTER object and therefore
 * reported "no recognizable pagination signal" for endpoints that carry a perfectly good
 * `{ data, pagination }` one level in.
 *
 * That mattered more than a false positive normally would. This gate spent its whole life green
 * because there were 336 paginated GETs and NOT ONE of them carried a 2xx schema for it to read
 * -- it was passing over an empty corpus (see check:openapi-coverage, which reported 100%
 * response-schema coverage for the same reason). The moment real schemas appeared, the first
 * thing the gate did was misread them. Unwrapping is what lets the remaining violation be
 * believed.
 */
export function unwrapSuccessEnvelope(schema) {
  if (typeof schema !== "object" || schema === null) return schema;
  const props = schema.properties;
  if (typeof props !== "object" || props === null) return schema;
  if (!Object.prototype.hasOwnProperty.call(props, "success")) return schema;
  if (!Object.prototype.hasOwnProperty.call(props, "data")) return schema;
  const inner = props.data;
  return typeof inner === "object" && inner !== null ? inner : schema;
}

function schemaHasPaginationSignal(schema) {
  if (typeof schema !== "object" || schema === null) return false;
  const ref = schema["$ref"];
  if (typeof ref === "string") {
    return /paginated|page|cursor|collection/i.test(ref);
  }
  const props = schema.properties;
  if (typeof props !== "object" || props === null) return false;
  return PAGINATION_SIGNALS.some((s) => Object.prototype.hasOwnProperty.call(props, s));
}

export function findMissingErrorRefs(document) {
  const violations = [];
  for (const [pathTemplate, pathItem] of Object.entries(document.paths ?? {})) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      if (typeof operation !== "object" || operation === null) continue;
      if (!has4xxRef(operation.responses)) {
        violations.push({ method: method.toUpperCase(), path: pathTemplate });
      }
    }
  }
  return violations;
}

export function findMissingErrorComponents(document) {
  const components = document.components?.responses ?? {};
  return REQUIRED_ERROR_COMPONENTS.filter((name) => !Object.prototype.hasOwnProperty.call(components, name));
}

/**
 * How many paginated GETs exist, and how many of them declare a 2xx schema this gate can read.
 * The gap between the two is the reason this gate passed over an empty corpus for so long.
 */
export function countPaginatedGets(document) {
  let total = 0;
  let readable = 0;
  for (const pathItem of Object.values(document.paths ?? {})) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    const operation = pathItem["get"];
    if (typeof operation !== "object" || operation === null) continue;
    if (!isPaginatedEndpoint(operation)) continue;
    total++;
    const twoHundred = Object.entries(operation.responses ?? {}).find(
      ([c]) => parseInt(c, 10) >= 200 && parseInt(c, 10) < 300,
    );
    const content = twoHundred?.[1]?.content;
    if (typeof content !== "object" || content === null) continue;
    if (Object.values(content).some((mt) => typeof mt === "object" && mt !== null && typeof mt.schema === "object" && mt.schema !== null))
      readable++;
  }
  return { total, readable };
}

export function findUnpaginatedCollections(document) {
  const violations = [];
  for (const [pathTemplate, pathItem] of Object.entries(document.paths ?? {})) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (method !== "get") continue;
      if (typeof operation !== "object" || operation === null) continue;
      if (!isPaginatedEndpoint(operation)) continue;
      if (!has200Response(operation)) continue;

      const twoHundred = Object.entries(operation.responses ?? {}).find(([c]) => parseInt(c, 10) >= 200 && parseInt(c, 10) < 300);
      if (!twoHundred) continue;
      const [, resp] = twoHundred;
      if (typeof resp !== "object" || resp === null) continue;

      const content = resp.content;
      if (typeof content !== "object" || content === null) continue;

      for (const mediaType of Object.values(content)) {
        if (typeof mediaType !== "object" || mediaType === null) continue;
        const schema = mediaType.schema;
        if (typeof schema !== "object" || schema === null) continue;
        // The pagination signal lives on the payload, inside the { success, data } envelope.
        const payload = unwrapSuccessEnvelope(schema);
        if (payload.type === "array") {
          violations.push({ method: "GET", path: pathTemplate, issue: "paginated endpoint returns a bare array — expected a pagination envelope with cursor/total/meta" });
          break;
        }
        if (!schemaHasPaginationSignal(payload) && typeof payload["$ref"] !== "string") {
          violations.push({ method: "GET", path: pathTemplate, issue: "paginated endpoint 200 schema has no recognizable pagination signal (nextCursor, total, meta, etc.)" });
          break;
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

  const missingComponents = findMissingErrorComponents({ components: { responses: { BadRequest: {}, Unauthorized: {}, Forbidden: {}, NotFound: {} } } });
  if (missingComponents.length !== 0)
    fail("all-components-present", `expected 0 missing, got ${JSON.stringify(missingComponents)}`);
  else pass("all-components-present — all four required error components present");

  const partialComponents = findMissingErrorComponents({ components: { responses: { BadRequest: {} } } });
  if (partialComponents.length !== 3)
    fail("missing-components-detected", `expected 3 missing, got ${partialComponents.length}`);
  else pass("missing-components-detected — 3 missing error components detected");

  const goodDoc = { paths: { "/a": { get: { responses: { "200": { content: {} }, "400": { "$ref": "#/components/responses/BadRequest" } } } } } };
  if (findMissingErrorRefs(goodDoc).length !== 0)
    fail("error-ref-present-passes", "expected 0 violations for op with 4xx ref");
  else pass("error-ref-present-passes — 4xx $ref produces no violation");

  const badDoc = { paths: { "/a": { get: { responses: { "200": { content: {} } } } } } };
  if (findMissingErrorRefs(badDoc).length !== 1)
    fail("missing-error-ref-bites", "expected 1 violation for op without 4xx ref");
  else pass("missing-error-ref-bites — missing 4xx $ref is flagged");

  const paginatedGood = { paths: { "/things": { get: {
    parameters: [{ name: "cursor", in: "query" }],
    responses: { "200": { content: { "application/json": { schema: { properties: { data: {}, nextCursor: {} } } } } } },
  }}}};
  if (findUnpaginatedCollections(paginatedGood).length !== 0)
    fail("paginated-envelope-passes", "expected 0 violations for paginated response with nextCursor");
  else pass("paginated-envelope-passes — paginated response with nextCursor passes");

  // --- v2 ticket 30: the { success, data } envelope must be unwrapped before the signal check ---
  const envelopedGood = { paths: { "/things": { get: {
    parameters: [{ name: "page" }],
    responses: { "200": { content: { "application/json": { schema: { type: "object", properties: {
      success: { type: "boolean" },
      data: { type: "object", properties: { data: { type: "array" }, pagination: { type: "object" } } },
    } } } } } },
  } } } };
  if (findUnpaginatedCollections(envelopedGood).length !== 0)
    fail("envelope-unwrapped", "a { success, data } envelope whose data carries a pagination signal must pass");
  else pass("envelope-unwrapped — pagination signal inside the { success, data } envelope is found");

  // THE REAL FINDING SHAPE: unwrapping must not hide a bare array one level in.
  const envelopedBareArray = { paths: { "/things": { get: {
    parameters: [{ name: "page" }],
    responses: { "200": { content: { "application/json": { schema: { type: "object", properties: {
      success: { type: "boolean" },
      data: { type: "array", items: { type: "object" } },
    } } } } } },
  } } } };
  const ebaResult = findUnpaginatedCollections(envelopedBareArray);
  if (ebaResult.length !== 1)
    fail("envelope-bare-array-bites", "a bare array INSIDE the envelope must still be flagged");
  else if (!ebaResult[0].issue.includes("bare array"))
    fail("envelope-bare-array-reason", `must name the bare array; got ${JSON.stringify(ebaResult)}`);
  else pass("envelope-bare-array-bites — a bare array inside the envelope is flagged, and says why");

  // Unwrapping must not fire on a payload that merely happens to have a `data` property.
  const notAnEnvelope = { paths: { "/things": { get: {
    parameters: [{ name: "page" }],
    responses: { "200": { content: { "application/json": { schema: { type: "object", properties: {
      data: { type: "array" }, total: { type: "integer" },
    } } } } } },
  } } } };
  if (findUnpaginatedCollections(notAnEnvelope).length !== 0)
    fail("no-envelope-no-unwrap", "a top-level { data, total } payload has its own signal and must pass");
  else pass("no-envelope-no-unwrap — a payload without `success` is not unwrapped");

  const paginatedBad = { paths: { "/things": { get: {
    parameters: [{ name: "cursor", in: "query" }],
    responses: { "200": { content: { "application/json": { schema: { type: "array" } } } } },
  }}}};
  if (findUnpaginatedCollections(paginatedBad).length !== 1)
    fail("bare-array-bites", "expected 1 violation for paginated endpoint with bare array schema");
  else pass("bare-array-bites — bare array schema on a paginated endpoint is flagged");

  if (failed) {
    process.stderr.write("\nSELF-TEST FAILED\n");
    process.exit(1);
  }
  process.stdout.write("\nSELF-TEST PASSED\n");
  process.exit(0);
}

if (!existsSync(OPENAPI_PATH)) {
  process.stderr.write(`check-envelope-consistency: openapi.json not found at ${OPENAPI_PATH}\n`);
  process.exit(2);
}

let document;
try {
  document = JSON.parse(readFileSync(OPENAPI_PATH, "utf8"));
} catch (err) {
  process.stderr.write(`check-envelope-consistency: failed to parse openapi.json: ${err.message}\n`);
  process.exit(2);
}

const missingComponents = findMissingErrorComponents(document);
const errorRefViolations = findMissingErrorRefs(document);
const paginationViolations = findUnpaginatedCollections(document);
// This gate was green for its whole life over 336 paginated GETs of which ZERO carried a 2xx
// schema it could read. Report the corpus, and how much of it is actually readable, so that
// state can never again be indistinguishable from a clean one.
const paginatedGets = countPaginatedGets(document);
reportCorpus({
  gate: "  check-envelope-consistency[pagination]",
  scanned: paginatedGets.readable,
  total: paginatedGets.total,
  unit: "paginated GET",
});
const total = missingComponents.length + errorRefViolations.length + paginationViolations.length;

process.stdout.write(`check-envelope-consistency: response/error envelope analysis\n`);

if (missingComponents.length > 0) {
  process.stderr.write(`  MISSING COMPONENTS: ${missingComponents.join(", ")} — required shared error response components are absent\n`);
} else {
  process.stdout.write(`  shared error components: OK (${REQUIRED_ERROR_COMPONENTS.join(", ")})\n`);
}

if (errorRefViolations.length > 0) {
  process.stdout.write(`  MISSING ERROR REFS: ${String(errorRefViolations.length)} operation(s) with no 4xx $ref to shared component:\n`);
  for (const { method, path } of errorRefViolations.slice(0, 20)) {
    process.stdout.write(`    ${method.padEnd(6)} ${path}\n`);
  }
  if (errorRefViolations.length > 20) process.stdout.write(`    ... and ${String(errorRefViolations.length - 20)} more\n`);
} else {
  process.stdout.write(`  error envelope refs: OK — all operations reference shared error components\n`);
}

if (paginationViolations.length > 0) {
  process.stdout.write(`  PAGINATION ENVELOPE (${String(paginationViolations.length)} violation(s) — bare arrays on paginated endpoints):\n`);
  for (const { method, path, issue } of paginationViolations.slice(0, 20)) {
    process.stdout.write(`    ${method.padEnd(6)} ${path} — ${issue}\n`);
  }
  if (paginationViolations.length > 20) process.stdout.write(`    ... and ${String(paginationViolations.length - 20)} more\n`);
} else {
  process.stdout.write(`  pagination envelopes: OK\n`);
}

process.stdout.write(`\n  Total violations: ${String(total)}\n`);

if (total > 0) {
  process.stderr.write(`check-envelope-consistency: FAIL — ${String(total)} envelope consistency violation(s).\n`);
  process.exit(1);
}

process.stdout.write(`  OK — response/error envelopes are consistent\n`);
process.exit(0);
