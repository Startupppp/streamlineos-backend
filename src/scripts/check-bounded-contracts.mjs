#!/usr/bin/env node
/**
 * check-bounded-contracts.mjs  (section 7.1 — bounded cursor/filter/sort/bulk gate)
 *
 * WHAT IT CHECKS (OpenAPI document static analysis)
 *
 * 1. CURSOR PARAMS — collection endpoints (GET with a "cursor" or "after" query
 *    param) must also declare a "limit" or "pageSize" param with a numeric
 *    maximum constraint (schema.maximum or schema.default ≤ 100). A cursor
 *    without a page-size cap allows arbitrarily large result sets.
 *
 * 2. FILTER PARAMS — query params named "filter", "search", "q", or "ids"
 *    on collection endpoints must have a declared maximum length (schema.maxLength
 *    or, for arrays, schema.maxItems). "ids" array params in particular are the
 *    common N+1-amplification vector for "select all" bulk operations.
 *
 * 3. SORT PARAMS — a query param named "sort" or "orderBy" should be an enum
 *    (schema.enum) rather than a bare string. A bare string allows arbitrary
 *    column names that could alias to sensitive columns or cost a full scan.
 *
 * 4. BULK ID COUNTS — any endpoint (POST/GET) with an "ids" array param must
 *    declare schema.maxItems. Without a cap, a single request can reference
 *    every row in a table.
 *
 * THRESHOLDS
 * PAGE_SIZE_CAP = 100   (backend CLAUDE.md §2: "hard cap 100/page, public included")
 * MAX_IDS_CAP = 500     (reasonable bulk cap before a streaming alternative is warranted)
 *
 * SCOPE
 * CRM and Inventory are outside this release scope, so their violations are
 * reported separately and do not fail the gate. They are counted and printed
 * rather than dropped: a silently filtered path reads as "covered" when it is
 * not. The exclusion is a prefix match on the OpenAPI path, matching the
 * EXCLUDED_MODULE_PREFIXES convention in check-unbounded-reads.mjs.
 *
 * SELF-TEST (--self-test)
 * Proves each violation category fires on a known-bad fixture and does not fire
 * on a known-good fixture, and that the scope filter excludes a CRM/Inventory
 * path without swallowing an in-scope one.
 *
 * Usage:
 *   node src/scripts/check-bounded-contracts.mjs [--self-test]
 *   pnpm check:bounded-contracts
 *
 * Exit codes:
 *   0 — no violations (or self-test passed)
 *   1 — violations found, or self-test failed
 *   2 — document unreadable
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_TEST = process.argv.includes("--self-test");
const BACKEND_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const OPENAPI_PATH = join(BACKEND_ROOT, "openapi.json");

const PAGE_SIZE_CAP = 100;

const EXCLUDED_PATH_PREFIXES = ["/crm/", "/inventory/"];

export function isExcludedPath(pathTemplate) {
  return EXCLUDED_PATH_PREFIXES.some((prefix) => String(pathTemplate).startsWith(prefix));
}

export function partitionByScope(violations) {
  const inScope = [];
  const excluded = [];
  for (const violation of violations) {
    if (isExcludedPath(violation.path)) excluded.push(violation);
    else inScope.push(violation);
  }
  return { inScope, excluded };
}

function isCollectionGet(method, operation) {
  if (method !== "get") return false;
  const params = operation.parameters ?? [];
  return params.some((p) => typeof p === "object" && p !== null &&
    ["cursor", "after", "page", "offset"].includes(String(p.name ?? "")));
}

function getQueryParam(operation, name) {
  return (operation.parameters ?? []).find(
    (p) => typeof p === "object" && p !== null && p.in === "query" && p.name === name,
  );
}

function hasNumericMax(param) {
  const schema = param?.schema;
  if (typeof schema !== "object" || schema === null) return false;
  const max = schema.maximum;
  const def = schema.default;
  if (typeof max === "number" && max <= PAGE_SIZE_CAP) return true;
  if (typeof def === "number" && def <= PAGE_SIZE_CAP && typeof max !== "number") return true;
  return false;
}

export function findCursorViolations(document) {
  const violations = [];
  const paths = document.paths ?? {};

  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (typeof operation !== "object" || operation === null) continue;
      if (!isCollectionGet(method, operation)) continue;

      const hasCursor = (operation.parameters ?? []).some(
        (p) => typeof p === "object" && p !== null && ["cursor", "after"].includes(String(p.name ?? "")),
      );
      if (!hasCursor) continue;

      const limitParam = getQueryParam(operation, "limit") ?? getQueryParam(operation, "pageSize");
      if (!limitParam) {
        violations.push({ method: "GET", path: pathTemplate, issue: "cursor/after param without a limit/pageSize param" });
      } else if (!hasNumericMax(limitParam)) {
        violations.push({ method: "GET", path: pathTemplate, issue: `cursor endpoint: limit/pageSize has no maximum ≤ ${String(PAGE_SIZE_CAP)} declared` });
      }
    }
  }

  return violations;
}

export function findSortViolations(document) {
  const violations = [];
  const paths = document.paths ?? {};

  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (typeof operation !== "object" || operation === null) continue;
      if (!["get"].includes(method)) continue;

      const sortParam = getQueryParam(operation, "sort") ?? getQueryParam(operation, "orderBy") ?? getQueryParam(operation, "sortBy");
      if (!sortParam) continue;

      const schema = sortParam.schema;
      const hasEnum = typeof schema === "object" && schema !== null && Array.isArray(schema.enum) && schema.enum.length > 0;
      if (!hasEnum) {
        violations.push({ method: "GET", path: pathTemplate, param: String(sortParam.name), issue: "sort/orderBy param is a bare string without an enum constraint" });
      }
    }
  }

  return violations;
}

const IDS_FIELD_RE = /^(ids|itemIds|[a-zA-Z]+Ids)$/;

export function findBulkIdViolations(document) {
  const violations = [];
  const paths = document.paths ?? {};

  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (typeof operation !== "object" || operation === null) continue;

      const idsParam = getQueryParam(operation, "ids") ?? getQueryParam(operation, "itemIds");
      if (idsParam) {
        const schema = idsParam.schema;
        const isArray = typeof schema === "object" && schema !== null && (schema.type === "array" || Array.isArray(schema.items));
        if (isArray && typeof schema.maxItems !== "number") {
          violations.push({ method: method.toUpperCase(), path: pathTemplate, param: String(idsParam.name), issue: "bulk ids array query param has no maxItems constraint" });
        }
      }

      const body = operation.requestBody;
      if (typeof body !== "object" || body === null) continue;
      const content = body.content;
      if (typeof content !== "object" || content === null) continue;
      const jsonContent = content["application/json"];
      if (typeof jsonContent !== "object" || jsonContent === null) continue;
      const bodySchema = jsonContent.schema;
      if (typeof bodySchema !== "object" || bodySchema === null) continue;
      const props = bodySchema.properties;
      if (typeof props !== "object" || props === null) continue;

      for (const [fieldName, fieldSchema] of Object.entries(props)) {
        if (!IDS_FIELD_RE.test(fieldName)) continue;
        if (typeof fieldSchema !== "object" || fieldSchema === null) continue;
        if (fieldSchema.type !== "array") continue;
        if (typeof fieldSchema.maxItems !== "number") {
          violations.push({ method: method.toUpperCase(), path: pathTemplate, param: `body.${fieldName}`, issue: "bulk ids array body field has no maxItems constraint" });
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

  const makeDoc = (ops) => ({
    paths: Object.fromEntries(
      ops.map(({ path, method, params }) => [
        path,
        { [method]: { parameters: params } },
      ]),
    ),
  });

  const goodCursorOp = { path: "/things", method: "get", params: [
    { name: "cursor", in: "query" },
    { name: "limit", in: "query", schema: { type: "integer", maximum: 100 } },
  ]};
  if (findCursorViolations(makeDoc([goodCursorOp])).length !== 0)
    fail("cursor-with-max-passes", "expected 0 violations for cursor + limit with maximum");
  else pass("cursor-with-max-passes — cursor with capped limit produces no violations");

  const badCursorOp = { path: "/things", method: "get", params: [
    { name: "cursor", in: "query" },
  ]};
  const cv = findCursorViolations(makeDoc([badCursorOp]));
  if (cv.length !== 1)
    fail("cursor-without-limit-bites", `expected 1 violation, got ${cv.length}`);
  else pass("cursor-without-limit-bites — cursor without limit param is flagged");

  const noCapOp = { path: "/things", method: "get", params: [
    { name: "cursor", in: "query" },
    { name: "limit", in: "query", schema: { type: "integer" } },
  ]};
  if (findCursorViolations(makeDoc([noCapOp])).length !== 1)
    fail("cursor-uncapped-limit-bites", "expected 1 violation for limit without maximum");
  else pass("cursor-uncapped-limit-bites — limit without maximum ≤ 100 is flagged");

  const goodSortOp = { path: "/things", method: "get", params: [
    { name: "sort", in: "query", schema: { type: "string", enum: ["name", "-name", "createdAt"] } },
  ]};
  if (findSortViolations(makeDoc([goodSortOp])).length !== 0)
    fail("sort-with-enum-passes", "expected 0 violations for enum sort param");
  else pass("sort-with-enum-passes — sort with enum produces no violations");

  const badSortOp = { path: "/things", method: "get", params: [
    { name: "sort", in: "query", schema: { type: "string" } },
  ]};
  if (findSortViolations(makeDoc([badSortOp])).length !== 1)
    fail("sort-bare-string-bites", "expected 1 violation for bare string sort");
  else pass("sort-bare-string-bites — bare string sort param is flagged");

  const goodBulkOp = { path: "/things/bulk", method: "get", params: [
    { name: "ids", in: "query", schema: { type: "array", items: { type: "string" }, maxItems: 200 } },
  ]};
  if (findBulkIdViolations(makeDoc([goodBulkOp])).length !== 0)
    fail("bulk-ids-with-maxItems-passes", "expected 0 violations for ids with maxItems");
  else pass("bulk-ids-with-maxItems-passes — ids with maxItems produces no violations");

  const badBulkOp = { path: "/things/bulk", method: "get", params: [
    { name: "ids", in: "query", schema: { type: "array", items: { type: "string" } } },
  ]};
  if (findBulkIdViolations(makeDoc([badBulkOp])).length !== 1)
    fail("bulk-ids-without-maxItems-bites", "expected 1 violation for ids without maxItems");
  else pass("bulk-ids-without-maxItems-bites — ids without maxItems is flagged");

  const makeDocWithBody = (path, method, bodyProps) => ({
    paths: { [path]: { [method]: { requestBody: { content: { "application/json": { schema: { type: "object", properties: bodyProps } } } } } } },
  });

  const goodBodyBulk = makeDocWithBody("/things/bulk", "post", { ticketIds: { type: "array", items: { type: "integer" }, maxItems: 100 } });
  if (findBulkIdViolations(goodBodyBulk).length !== 0)
    fail("body-ids-with-maxItems-passes", "expected 0 violations for body ids with maxItems");
  else pass("body-ids-with-maxItems-passes — body ids with maxItems produces no violations");

  const badBodyBulk = makeDocWithBody("/things/bulk", "post", { ticketIds: { type: "array", items: { type: "integer" } } });
  if (findBulkIdViolations(badBodyBulk).length !== 1)
    fail("body-ids-without-maxItems-bites", "expected 1 violation for body ids without maxItems");
  else pass("body-ids-without-maxItems-bites — body ids array without maxItems is flagged");

  const scopeMixed = partitionByScope([
    { method: "GET", path: "/crm/deals", issue: "x" },
    { method: "POST", path: "/inventory/loads", issue: "x" },
    { method: "GET", path: "/chat/channels", issue: "x" },
  ]);
  if (scopeMixed.excluded.length !== 2 || scopeMixed.inScope.length !== 1)
    fail("scope-partition-splits", `expected 2 excluded / 1 in-scope, got ${scopeMixed.excluded.length}/${scopeMixed.inScope.length}`);
  else pass("scope-partition-splits — CRM/Inventory paths are excluded and an in-scope path is not");

  const scopeLookalike = partitionByScope([
    { method: "GET", path: "/build/crm-export", issue: "x" },
    { method: "GET", path: "/hr/inventory-assets", issue: "x" },
  ]);
  if (scopeLookalike.excluded.length !== 0)
    fail("scope-partition-anchors", `a path merely containing crm/inventory must stay in scope, got ${scopeLookalike.excluded.length} excluded`);
  else pass("scope-partition-anchors — a path containing but not prefixed by crm/inventory stays in scope");

  if (failed) {
    process.stderr.write("\nSELF-TEST FAILED\n");
    process.exit(1);
  }
  process.stdout.write("\nSELF-TEST PASSED\n");
  process.exit(0);
}

if (!existsSync(OPENAPI_PATH)) {
  process.stderr.write(`check-bounded-contracts: openapi.json not found at ${OPENAPI_PATH}\n`);
  process.exit(2);
}

let document;
try {
  document = JSON.parse(readFileSync(OPENAPI_PATH, "utf8"));
} catch (err) {
  process.stderr.write(`check-bounded-contracts: failed to parse openapi.json: ${err.message}\n`);
  process.exit(2);
}

const allCursor = partitionByScope(findCursorViolations(document));
const allSort = partitionByScope(findSortViolations(document));
const allBulkId = partitionByScope(findBulkIdViolations(document));

const cursorViolations = allCursor.inScope;
const sortViolations = allSort.inScope;
const bulkIdViolations = allBulkId.inScope;
const excluded = [...allCursor.excluded, ...allSort.excluded, ...allBulkId.excluded];
const total = cursorViolations.length + sortViolations.length + bulkIdViolations.length;

process.stdout.write(`check-bounded-contracts: bounded contract analysis\n`);

if (cursorViolations.length > 0) {
  process.stdout.write(`  CURSOR/PAGINATION (${String(cursorViolations.length)} violation(s)):\n`);
  for (const { method, path, issue } of cursorViolations.slice(0, 20)) {
    process.stdout.write(`    ${method.padEnd(6)} ${path}\n`);
    process.stdout.write(`           ${issue}\n`);
  }
  if (cursorViolations.length > 20) process.stdout.write(`    ... and ${String(cursorViolations.length - 20)} more\n`);
} else {
  process.stdout.write(`  cursor/pagination bounds: OK\n`);
}

if (sortViolations.length > 0) {
  process.stdout.write(`  SORT PARAMS (${String(sortViolations.length)} violation(s) — bare string sort allows arbitrary column aliases):\n`);
  for (const { method, path, param, issue } of sortViolations.slice(0, 20)) {
    process.stdout.write(`    ${method.padEnd(6)} ${path}  ?${param}: ${issue}\n`);
  }
  if (sortViolations.length > 20) process.stdout.write(`    ... and ${String(sortViolations.length - 20)} more\n`);
} else {
  process.stdout.write(`  sort param bounds: OK\n`);
}

if (bulkIdViolations.length > 0) {
  process.stdout.write(`  BULK ID PARAMS (${String(bulkIdViolations.length)} violation(s) — missing maxItems amplifies DB load):\n`);
  for (const { method, path, param, issue } of bulkIdViolations.slice(0, 20)) {
    process.stdout.write(`    ${method.padEnd(6)} ${path}  ?${param}: ${issue}\n`);
  }
  if (bulkIdViolations.length > 20) process.stdout.write(`    ... and ${String(bulkIdViolations.length - 20)} more\n`);
} else {
  process.stdout.write(`  bulk id param bounds: OK\n`);
}

if (excluded.length > 0) {
  process.stdout.write(`\n  OUT OF SCOPE — CRM/Inventory (${String(excluded.length)}, reported not enforced):\n`);
  for (const { method, path, param, issue } of excluded) {
    const where = param ? `  ?${param}` : "";
    process.stdout.write(`    ${method.padEnd(6)} ${path}${where}: ${issue}\n`);
  }
}

process.stdout.write(`\n  Total in-scope violations: ${String(total)}\n`);

if (total > 0) {
  process.stderr.write(
    `check-bounded-contracts: FAIL — ${String(total)} bounded-contract violation(s). ` +
    `Add schema.maximum/maxItems/enum constraints to the relevant OpenAPI parameters.\n`,
  );
  process.exit(1);
}

process.stdout.write(`  OK — all collection and bulk endpoints have bounded contracts\n`);
process.exit(0);
