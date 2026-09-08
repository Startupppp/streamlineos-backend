/**
 * check-settings-route-e2e-coverage.mjs
 *
 * Derives the route list directly from the 12 Settings / Organisation /
 * Module-access / RBAC controllers by parsing their source files, then scans
 * every non-seeded *.e2e-spec.ts file for supertest HTTP method calls.  A
 * route is "covered" when at least one supertest call in the corpus matches it.
 *
 * Route extraction
 * ────────────────
 * 1. Class-level `@Controller("prefix")` — regex on the source.
 * 2. Method-level HTTP decorator (`@Get`, `@Post`, `@Patch`, `@Put`,
 *    `@Delete`) with an optional path argument.
 * 3. Full route = join(prefix, methodPath), leading slash normalised.
 *
 * Normalisation (both sides)
 * ──────────────────────────
 * Controller side — every `:paramName` segment is replaced with the regex
 * wildcard `[^/]+`.  The resulting per-route pattern is anchored (`^…$`) so
 * `/roles/1/members` does NOT match the `/roles` route.
 *
 * Test side — the literal path string extracted from a supertest call is split
 * on `/`.  Any segment that is a UUID, a pure integer, or a bare colon-led
 * token is already covered by the `[^/]+` wildcard on the controller side; no
 * extra normalisation is needed on the test side because the match is positional
 * (the regex accepts any value at a param position).
 *
 * Anti-vacuity
 * ────────────
 * Exit 2 when fewer than MIN_CONTROLLERS controller files produce routes, or
 * when fewer than MIN_ROUTES total routes are derived.  A filesystem walk that
 * matches zero controllers reports 100 % covered — that is a bug, not a pass.
 *
 * Self-test  (--self-test)
 * ────────────────────────
 * Proves the matcher BITES:
 *   - a route with no matching call is reported uncovered
 *   - a path-param route IS matched by a call that uses a literal value at the
 *     param position
 *   - a call at the wrong HTTP method does NOT satisfy coverage
 *
 * Usage
 *   node src/scripts/check-settings-route-e2e-coverage.mjs [--self-test]
 *   pnpm check:settings-route-coverage
 *
 * Exit codes
 *   0  all routes covered (or self-test passed)
 *   1  uncovered route count exceeds (total − RATCHET)
 *   2  anti-vacuity check failed
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const BACKEND_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

const SELF_TEST = process.argv.includes("--self-test");

const MIN_CONTROLLERS = 12;
const MIN_ROUTES = 100;

/**
 * Minimum number of routes that must be covered before the gate passes.
 * Set to the honest number reached after writing the permission-fence specs.
 * Do not lower this to make a failing suite pass.
 */
const RATCHET = 159;

const CONTROLLER_PATHS = [
  "src/modules/settings/settings.controller.ts",
  "src/modules/settings/settings-deprecated-routes.controller.ts",
  "src/modules/module-access/module-access.controller.ts",
  "src/modules/module-access/user-permission-grants.controller.ts",
  "src/modules/organization/core/organization.controller.ts",
  "src/modules/organization/hierarchy/org-hierarchy.controller.ts",
  "src/modules/organization/onboarding/workspace-onboarding.controller.ts",
  "src/modules/organization/setup/announcements.controller.ts",
  "src/modules/organization/setup/org.controller.ts",
  "src/modules/rbac/principal-groups.controller.ts",
  "src/modules/rbac/rbac.controller.ts",
  "src/modules/rbac/roles.controller.ts",
].map((p) => join(BACKEND_ROOT, p));

const HTTP_METHODS = ["Get", "Post", "Patch", "Put", "Delete"];

/**
 * Parse a controller source file and return every (method, fullPath) pair.
 *
 * Strategy: one-pass regex scan.
 * 1. Find the first `@Controller("…")` to get the class-level prefix.
 * 2. For each HTTP decorator (`@Get(…)`, `@Post(…)`, …) capture the optional
 *    path argument.  Decorators with no argument (e.g. `@Get()`) produce an
 *    empty sub-path so the full route equals the prefix.
 * 3. Join prefix + sub-path, normalise leading slash.
 *
 * Limitation: does not resolve dynamic expressions (`@Get(SOME_CONST)`) — all
 * controllers in the target set use string literals, so this is acceptable.
 */
function extractRoutes(src) {
  const prefixMatch = /@Controller\("([^"]*)"\)/.exec(src);
  if (!prefixMatch) return [];
  const prefix = prefixMatch[1];

  const routes = [];
  const methodRe = new RegExp(
    `@(${HTTP_METHODS.join("|")})\\s*\\((?:"([^"]*)")?(?:'([^']*)')?\\s*\\)`,
    "g",
  );
  let m;
  while ((m = methodRe.exec(src)) !== null) {
    const method = m[1].toUpperCase();
    const subPath = m[2] ?? m[3] ?? "";
    const parts = [prefix, subPath].filter(Boolean);
    const fullPath = parts.join("/");
    routes.push({ method, path: fullPath });
  }
  return routes;
}

/**
 * Build a regex that matches the given route path, treating every `:paramName`
 * segment as a wildcard.  The regex is anchored and case-insensitive.
 *
 * Example: "module-access/:moduleKey/groups/:groupId"
 *       →  /^\/module-access\/[^/]+\/groups\/[^/]+\/?$/i
 */
function routeToPattern(method, path) {
  const segments = path.split("/").map((seg) => {
    if (seg.startsWith(":")) return "[^/]+";
    return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  const pathRegex = segments.join("\\/");
  return { method, re: new RegExp(`^\\/?${pathRegex}\\/?$`, "i") };
}

/**
 * Extract (method, path) pairs from supertest calls in a spec file.
 *
 * Matches patterns like:
 *   .get("/path")   .post('/path')   .delete(`/path`)
 *   agent.get(...)  request(app.getHttpServer()).post(...)
 *
 * Template literals without interpolation are handled; interpolated ones are
 * silently skipped (no false positives from half-parsed expressions).
 */
function extractTestCalls(src) {
  const calls = [];
  const re = /\.(get|post|patch|put|delete)\s*\(\s*(?:"([^"]+)"|'([^']+)'|`([^`$]+)`)\s*\)/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const method = m[1].toUpperCase();
    const path = m[2] ?? m[3] ?? m[4] ?? "";
    if (path) calls.push({ method, path });
  }
  return calls;
}

/**
 * Walk a directory tree and return all .ts file paths that match the predicate.
 */
function walkTs(dir, predicate = () => true) {
  if (!existsSync(dir)) return [];
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkTs(full, predicate));
    else if (entry.name.endsWith(".ts") && predicate(entry.name)) results.push(full);
  }
  return results;
}

const isNonSeededE2eSpec = (name) =>
  name.endsWith(".e2e-spec.ts") && !name.includes("seeded");

// ─── Self-test ────────────────────────────────────────────────────────────────

if (SELF_TEST) {
  const controllerSrc = `
    @Controller("test-resources")
    export class TestController {
      @Get()
      list() {}
      @Get(":id")
      get() {}
      @Post("sub/:childId")
      create() {}
      @Delete(":id")
      remove() {}
    }
  `;

  const coveredSpecSrc = `
    describe("covered", () => {
      it("lists", async () => {
        const res = await request(app.getHttpServer()).get("/test-resources");
      });
      it("gets", async () => {
        const res = await request(app.getHttpServer()).get("/test-resources/123");
      });
      it("creates", async () => {
        const res = await agent.post("/test-resources/sub/uuid-abc-def");
      });
    });
  `;

  const notCoveredSpecSrc = `
    describe("not covered", () => {
      it("posts to wrong route", async () => {
        const res = await agent.get("/test-resources/123");
      });
    });
  `;

  const routes = extractRoutes(controllerSrc);
  const patterns = routes.map((r) => routeToPattern(r.method, r.path));

  const coveredCalls = extractTestCalls(coveredSpecSrc);
  const uncoveredCalls = extractTestCalls(notCoveredSpecSrc);

  function isRouteHit(pattern, calls) {
    return calls.some(
      (c) => c.method === pattern.method && pattern.re.test(c.path),
    );
  }

  const checks = {
    extractsListRoute: routes.some((r) => r.method === "GET" && r.path === "test-resources"),
    extractsParamRoute: routes.some((r) => r.method === "GET" && r.path === "test-resources/:id"),
    extractsSubParamRoute: routes.some((r) => r.method === "POST" && r.path === "test-resources/sub/:childId"),
    extractsDeleteRoute: routes.some((r) => r.method === "DELETE" && r.path === "test-resources/:id"),
    routeCount: routes.length === 4,
    paramRouteMatchesLiteralId: isRouteHit(
      routeToPattern("GET", "test-resources/:id"),
      [{ method: "GET", path: "/test-resources/123" }],
    ),
    subParamMatchesUuid: isRouteHit(
      routeToPattern("POST", "test-resources/sub/:childId"),
      [{ method: "POST", path: "/test-resources/sub/uuid-abc-def" }],
    ),
    wrongMethodDoesNotMatch: !isRouteHit(
      routeToPattern("DELETE", "test-resources/:id"),
      [{ method: "GET", path: "/test-resources/123" }],
    ),
    coveredSpecSatisfiesListRoute: isRouteHit(patterns[0], coveredCalls),
    coveredSpecSatisfiesParamRoute: isRouteHit(patterns[1], coveredCalls),
    coveredSpecSatisfiesCreateRoute: isRouteHit(patterns[2], coveredCalls),
    uncoveredSpecDoesNotSatisfyDeleteRoute: !isRouteHit(patterns[3], uncoveredCalls),
    testCallExtraction: coveredCalls.length === 3,
  };

  const pass = Object.values(checks).every(Boolean);
  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (!pass) {
    process.stderr.write(
      `Self-test FAILED — ${failures.length} check(s): ${failures.join(", ")}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`Self-test PASSED — ${Object.keys(checks).length} checks OK\n`);
  process.exit(0);
}

// ─── Main scan ────────────────────────────────────────────────────────────────

const allRoutes = [];
let resolvedControllers = 0;

for (const controllerPath of CONTROLLER_PATHS) {
  if (!existsSync(controllerPath)) {
    process.stderr.write(`Controller not found: ${controllerPath}\n`);
    continue;
  }
  const src = readFileSync(controllerPath, "utf8");
  const routes = extractRoutes(src);
  if (routes.length > 0) resolvedControllers++;
  for (const r of routes) {
    allRoutes.push({ ...r, controller: relative(BACKEND_ROOT, controllerPath).replace(/\\/g, "/") });
  }
}

if (resolvedControllers < MIN_CONTROLLERS) {
  process.stderr.write(
    `Anti-vacuity: only ${resolvedControllers} of ${CONTROLLER_PATHS.length} controller files ` +
      `produced routes (expected ≥ ${MIN_CONTROLLERS}). ` +
      `Check that CONTROLLER_PATHS are correct.\n`,
  );
  process.exit(2);
}

if (allRoutes.length < MIN_ROUTES) {
  process.stderr.write(
    `Anti-vacuity: only ${allRoutes.length} routes derived (expected ≥ ${MIN_ROUTES}). ` +
      `The route extractor may be broken.\n`,
  );
  process.exit(2);
}

const TEST_DIRS = [
  join(BACKEND_ROOT, "test"),
  join(BACKEND_ROOT, "src", "modules"),
];

const allSpecFiles = TEST_DIRS.flatMap((d) => walkTs(d, isNonSeededE2eSpec));

if (allSpecFiles.length === 0) {
  process.stderr.write(
    `Anti-vacuity: no *.e2e-spec.ts files found under test/ or src/modules/. ` +
      `The filesystem walk is broken.\n`,
  );
  process.exit(2);
}

const allTestCalls = [];
for (const specFile of allSpecFiles) {
  const src = readFileSync(specFile, "utf8");
  const calls = extractTestCalls(src);
  allTestCalls.push(...calls);
}

const patterns = allRoutes.map((r) => ({
  ...r,
  pattern: routeToPattern(r.method, r.path),
}));

const covered = [];
const uncovered = [];

for (const route of patterns) {
  const hit = allTestCalls.some(
    (c) => c.method === route.method && route.pattern.re.test(c.path),
  );
  if (hit) covered.push(route);
  else uncovered.push(route);
}

const coveragePercent =
  allRoutes.length > 0 ? Math.round((covered.length / allRoutes.length) * 100) : 0;

console.log(`Controllers resolved           ${resolvedControllers} / ${CONTROLLER_PATHS.length}`);
console.log(`Routes derived                 ${allRoutes.length}`);
console.log(`Spec files scanned             ${allSpecFiles.length}`);
console.log(`Supertest calls found          ${allTestCalls.length}`);
console.log(`Routes covered                 ${covered.length} / ${allRoutes.length}  (${coveragePercent} %)`);
console.log(`Ratchet (minimum required)     ${RATCHET}`);
console.log(``);
console.log(
  `NOTE: this gate is static.  It proves a spec file CONTAINS a supertest call`,
);
console.log(
  `      that matches the route — it does not prove the call succeeds or that`,
);
console.log(
  `      the assertion is non-vacuous.  Execution proof is the e2e test run.`,
);
console.log(``);

if (uncovered.length > 0) {
  console.log("UNCOVERED routes:");
  for (const r of uncovered) {
    console.log(`  MISSING  ${r.method.padEnd(7)} /${r.path}  (${r.controller})`);
  }
  console.log(``);
}

const deficit = allRoutes.length - covered.length;
if (deficit > allRoutes.length - RATCHET) {
  console.error(
    `FAIL — ${uncovered.length} route(s) uncovered; ${covered.length} of ${allRoutes.length} covered ` +
      `(${coveragePercent} %) which is below the ratchet of ${RATCHET}.`,
  );
  process.exit(1);
}

if (uncovered.length > 0) {
  console.log(
    `WARN — ${uncovered.length} route(s) uncovered but above the ratchet of ${RATCHET}.`,
  );
  process.exit(0);
}

console.log(`OK — all ${allRoutes.length} routes in scope have at least one e2e-spec call.`);
process.exit(0);
