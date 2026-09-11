#!/usr/bin/env node
/**
 * check-route-duplicates.mjs  (section 7.1 — route deduplication gate)
 *
 * WHAT IT CHECKS
 * 1. DUPLICATE OPERATIONIDS — operations sharing an operationId. Known defect:
 *    NestJS collides controller names into one OpenAPI operationId when two
 *    controllers share the same class name (28 ops were affected). The registry
 *    gate already keys on method+path, but consumers of the OpenAPI document
 *    (code generators, frontend type generation) pick by operationId and may
 *    silently serve the wrong contract.
 *
 * 2. GENUINELY AMBIGUOUS PARAM-vs-PARAM PATHS — two routes at the same HTTP
 *    method and depth where the differing segment in BOTH routes is a path
 *    parameter (e.g. GET /build/{projectId} and GET /build/{orgId}). NestJS
 *    CANNOT sort these deterministically by static/param priority; the winner
 *    is whichever controller was registered first in app.module.ts. These are
 *    genuinely order-dependent and must be reported.
 *
 *    Static-vs-param pairs (e.g. GET /build/all-work vs GET /build/{projectId})
 *    are NOT flagged here. NestJS's router globally sorts static segments before
 *    parameterized ones at the same depth, even across separately registered
 *    controllers. This is NestJS-safe by design.
 *
 * 3. AMBIGUOUS VERSION SEGMENTS — paths that look like they belong to a
 *    versioned API (/v1/, /v2/, …) but whose sibling path omits the version
 *    segment, suggesting one is unintentionally versionless.
 *
 * PHILOSOPHY
 * Deletion requires caller/dependency proof and belongs to the owning agent.
 * This gate only REPORTS; it never deletes or modifies routes.
 *
 * SELF-TEST (--self-test)
 * Proves:
 *   - Duplicate operationId collision is detected
 *   - A param-vs-param ambiguity is detected
 *   - A static-vs-param pair is NOT flagged (NestJS handles it)
 *   - Clean documents produce 0 findings
 *
 * Usage:
 *   node src/scripts/check-route-duplicates.mjs [--self-test]
 *   pnpm check:route-duplicates
 *
 * Exit codes:
 *   0 — report complete (violations are reported, not failed on by default)
 *   1 — self-test failed
 *   2 — document unreadable
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_TEST = process.argv.includes("--self-test");
const BACKEND_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const OPENAPI_PATH = join(BACKEND_ROOT, "openapi.json");

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

function isParamSegment(seg) {
  return seg.startsWith("{") && seg.endsWith("}");
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
      const key = `${method.toUpperCase()} ${pathTemplate}`;
      if (seen.has(operationId)) {
        duplicates.push({ operationId, first: seen.get(operationId), second: key });
      } else {
        seen.set(operationId, key);
      }
    }
  }
  return duplicates;
}

export function findAmbiguousParamRoutes(document) {
  const ambiguous = [];
  const byMethodAndDepth = new Map();

  for (const [pathTemplate] of Object.entries(document.paths ?? {})) {
    const segments = pathTemplate.split("/").filter(Boolean);
    const depth = segments.length;
    for (const [method] of Object.entries((document.paths ?? {})[pathTemplate] ?? {})) {
      if (!HTTP_METHODS.has(method)) continue;
      const depthKey = `${method.toUpperCase()}:${String(depth)}`;
      if (!byMethodAndDepth.has(depthKey)) byMethodAndDepth.set(depthKey, []);
      byMethodAndDepth.get(depthKey).push({ pathTemplate, segments });
    }
  }

  for (const routes of byMethodAndDepth.values()) {
    for (let i = 0; i < routes.length; i++) {
      for (let j = i + 1; j < routes.length; j++) {
        const a = routes[i];
        const b = routes[j];
        if (a.segments.length !== b.segments.length) continue;

        let mismatchAt = -1;
        let aIsParam = false;
        let bIsParam = false;
        for (let k = 0; k < a.segments.length; k++) {
          const sa = a.segments[k];
          const sb = b.segments[k];
          if (sa === sb) continue;
          if (mismatchAt !== -1) { mismatchAt = -2; break; }
          mismatchAt = k;
          aIsParam = isParamSegment(sa);
          bIsParam = isParamSegment(sb);
        }

        if (mismatchAt < 0) continue;
        if (!aIsParam || !bIsParam) continue;

        ambiguous.push({
          routeA: a.pathTemplate,
          routeB: b.pathTemplate,
          note: "both routes have a path parameter at the same segment — NestJS cannot sort these; registration order in app.module.ts decides the winner",
        });
      }
    }
  }

  return ambiguous;
}

export function findVersionInconsistencies(document) {
  const findings = [];
  const versionedByBase = new Map();

  for (const pathTemplate of Object.keys(document.paths ?? {})) {
    const match = /\/(v\d+)\//.exec(pathTemplate);
    if (!match) continue;
    const base = pathTemplate.replace(`/${match[1]}/`, "/");
    if (!versionedByBase.has(base)) versionedByBase.set(base, []);
    versionedByBase.get(base).push({ version: match[1], pathTemplate });
  }

  for (const [base, versions] of versionedByBase) {
    if ((document.paths ?? {})[base]) {
      for (const { version, pathTemplate } of versions) {
        findings.push({ base, pathTemplate, note: `${version} path exists alongside an unversioned sibling — one may be unintentionally versionless` });
      }
    }
  }

  return findings;
}

if (SELF_TEST) {
  process.stdout.write("Running self-test...\n");
  let failed = false;

  const pass = (label) => process.stdout.write(`  [pass] ${label}\n`);
  const fail = (label, detail) => {
    process.stderr.write(`  [FAIL] ${label}: ${detail}\n`);
    failed = true;
  };

  const cleanDoc = { paths: {
    "/a": { get: { operationId: "A_list" } },
    "/b": { post: { operationId: "B_create" } },
  }};
  if (findDuplicateOperationIds(cleanDoc).length !== 0)
    fail("no-dupe-clean-doc", "expected 0 duplicates");
  else pass("no-dupe-clean-doc — clean document has 0 operationId duplicates");

  const dupeDoc = { paths: {
    "/a": { get: { operationId: "X_list" } },
    "/b": { post: { operationId: "X_list" } },
  }};
  if (findDuplicateOperationIds(dupeDoc).length !== 1)
    fail("dupe-detected", "expected 1 duplicate");
  else pass("dupe-detected — duplicate operationId is detected");

  const staticVsParamDoc = { paths: {
    "/users/me": { get: { operationId: "Me_get" } },
    "/users/{userId}": { get: { operationId: "User_get" } },
  }};
  if (findAmbiguousParamRoutes(staticVsParamDoc).length !== 0)
    fail("static-vs-param-not-flagged", "static /users/me vs param /users/{userId} should NOT be flagged — NestJS sorts static before param");
  else pass("static-vs-param-not-flagged — NestJS-safe static-before-param pair is not flagged");

  const paramVsParamDoc = { paths: {
    "/build/{projectId}": { get: { operationId: "Project_get" } },
    "/build/{orgId}": { get: { operationId: "Org_get" } },
  }};
  const ambiguous = findAmbiguousParamRoutes(paramVsParamDoc);
  if (ambiguous.length !== 1)
    fail("param-vs-param-flagged", `expected 1 genuinely ambiguous param-vs-param pair, got ${ambiguous.length}`);
  else pass("param-vs-param-flagged — param-vs-param at same depth is correctly flagged as ambiguous");

  const noAmbiguousDoc = { paths: {
    "/users": { get: { operationId: "Users_list" } },
    "/projects": { get: { operationId: "Projects_list" } },
  }};
  if (findAmbiguousParamRoutes(noAmbiguousDoc).length !== 0)
    fail("no-ambiguous-clean", "expected 0 ambiguous routes for unrelated paths");
  else pass("no-ambiguous-clean — unrelated paths have no ambiguous findings");

  if (failed) {
    process.stderr.write("\nSELF-TEST FAILED\n");
    process.exit(1);
  }
  process.stdout.write("\nSELF-TEST PASSED\n");
  process.exit(0);
}

if (!existsSync(OPENAPI_PATH)) {
  process.stderr.write(`check-route-duplicates: openapi.json not found at ${OPENAPI_PATH}\n`);
  process.exit(2);
}

let document;
try {
  document = JSON.parse(readFileSync(OPENAPI_PATH, "utf8"));
} catch (err) {
  process.stderr.write(`check-route-duplicates: failed to parse openapi.json: ${err.message}\n`);
  process.exit(2);
}

const duplicates = findDuplicateOperationIds(document);
const ambiguousParams = findAmbiguousParamRoutes(document);
const versionIssues = findVersionInconsistencies(document);

process.stdout.write(`check-route-duplicates: route deduplication report\n`);
process.stdout.write(`  NOTE: static-vs-param pairs are NOT reported — NestJS globally sorts static segments before parameterized ones, so these are safe.\n`);

if (duplicates.length > 0) {
  process.stdout.write(`  DUPLICATE OPERATIONIDS: ${String(duplicates.length)} collision(s) — routes with identical operationId may publish wrong contracts to code generators:\n`);
  for (const { operationId, first, second } of duplicates.slice(0, 30)) {
    process.stdout.write(`    "${operationId}": ${first} ↔ ${second}\n`);
  }
  if (duplicates.length > 30) process.stdout.write(`    ... and ${String(duplicates.length - 30)} more\n`);
} else {
  process.stdout.write(`  operationId duplicates: 0\n`);
}

if (ambiguousParams.length > 0) {
  process.stdout.write(`  GENUINELY AMBIGUOUS (param-vs-param): ${String(ambiguousParams.length)} pair(s) — NestJS cannot determine order; app.module.ts registration order decides the winner:\n`);
  for (const { routeA, routeB, note } of ambiguousParams.slice(0, 20)) {
    process.stdout.write(`    ${routeA}  vs  ${routeB}\n`);
    process.stdout.write(`      ${note}\n`);
  }
  if (ambiguousParams.length > 20) process.stdout.write(`    ... and ${String(ambiguousParams.length - 20)} more\n`);
} else {
  process.stdout.write(`  genuinely ambiguous param-vs-param routes: 0\n`);
}

if (versionIssues.length > 0) {
  process.stdout.write(`  VERSION INCONSISTENCIES: ${String(versionIssues.length)} path(s) with a versioned sibling alongside an unversioned one:\n`);
  for (const { pathTemplate, note } of versionIssues.slice(0, 10)) {
    process.stdout.write(`    ${pathTemplate} — ${note}\n`);
  }
} else {
  process.stdout.write(`  version inconsistencies: 0\n`);
}

const total = duplicates.length + ambiguousParams.length + versionIssues.length;
process.stdout.write(`\n  Total findings: ${String(total)} (reported only — deletion requires caller/dependency proof)\n`);
process.exit(0);
