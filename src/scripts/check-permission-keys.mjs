/**
 * check-permission-keys.mjs
 *
 * Cross-checks every @RequirePermission key used on a backend route against
 * two catalogs and fails (exit 1) when a ghost key is found.
 *
 * GHOST KEY — a key used in @RequirePermission on a real route that is absent
 * from the backend permission catalog. Such a route can never be granted to
 * anyone and 403s forever for non-owners. A real instance was "hr:employees:export"
 * which broke CSV export for every non-owner. This script makes that class of
 * defect a build-breaking failure.
 *
 * THREE CHECKS (all fail exit 1):
 *
 *   1. Key used on a route but absent from the BACKEND catalog.
 *      The route can never be granted — authorize() returns NO_MODULE or FORBIDDEN
 *      for an unknown key, so the route 403s for every non-owner permanently.
 *
 *   2. Key used on a route but absent from the FRONTEND PermissionKey union
 *      (frontend/lib/rbac/permissions/permission-key-*.ts).
 *      useCan(key) silently returns false for any key TypeScript does not accept,
 *      hiding every control that calls it.
 *
 *   3. A decorator argument this scanner could not resolve to a key. 21 routes
 *      pass a module-level constant rather than a literal, and the original
 *      literal-only regex skipped them without saying so — a check that quietly
 *      declines to check. An unresolvable argument now fails; it never counts as
 *      "no finding".
 *
 * NON-FAILURE (intentional subset):
 *   Backend catalog keys that are NOT used on any route are fine — they may be
 *   checked programmatically inside service methods or reserved for future routes.
 *   Frontend PERMISSIONS runtime array is a deliberate subset of the union; the
 *   ~206-key gap is tested in catalog-sync.test.ts and must NOT be reported here.
 *
 * SCOPE:
 *   Routes scanned: backend/src/modules/ (all .ts files, spec files excluded).
 *   Backend catalog: loaded from the real module through ts-node, not greped —
 *     `<module>:access:view` is a generated template literal and a text scan
 *     misses all twelve of them.
 *   Frontend union:  frontend/lib/rbac/permissions/permission-key-{foundation,extended,business}.ts
 *
 * Usage (run from backend/ or anywhere — paths are resolved from this file):
 *   node src/scripts/check-permission-keys.mjs
 *   node src/scripts/check-permission-keys.mjs --self-test
 *
 * Exit codes:
 *   0  — every route key exists in both catalogs
 *   1  — at least one ghost or unresolvable key found (or self-test failed)
 *   2  — usage error (e.g. catalog unreadable)
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BACKEND_ROOT,
  WORKSPACE_ROOT,
  resolveBackendModulesDir,
  resolveFrontendRoot,
} from "./lib/repo-roots.mjs";
import {
  loadBackendCatalog,
  loadModuleManifest,
  parsePermissionConstants,
  parseRouteRefs,
  parseUnionKeys,
} from "./permission-key-extractors.mjs";

export { parsePermissionConstants, parseRouteRefs, parseUnionKeys };

const PILOT_MODULE = "timesheets";

/**
 * Returns { ok, violations } where violations lists resolved permission keys that
 * fall outside the namespaces the manifest entry declares for the pilot module.
 *
 * @param {{ id: string, administersNamespaces: string[] }} pilotEntry
 * @param {Array<{ key: string|null, resolved: boolean, file: string, line: number }>} routeRefs
 * @param {string} modulesDir  absolute path to backend/src/modules/
 */
export function checkNamespacePilot(pilotEntry, routeRefs, modulesDir) {
  const allowedNamespaces = [pilotEntry.id, ...pilotEntry.administersNamespaces];
  const prefix = `modules/${pilotEntry.id}/`;
  const violations = routeRefs.filter((ref) => {
    if (!ref.resolved || ref.key === null) return false;
    const filePath = ref.file.replace(/\\/g, "/");
    if (!filePath.includes(prefix)) return false;
    const ns = ref.key.split(":")[0];
    return !allowedNamespaces.includes(ns);
  });
  return { ok: violations.length === 0, violations };
}

const args = process.argv.slice(2);

// Roots are RESOLVED, not assumed: this gate spent its whole life exiting 2
// because it hardcoded a `<root>/backend` + `<root>/frontend` monorepo layout
// that this checkout does not use. See src/scripts/lib/repo-roots.mjs.
const REPO_ROOT = WORKSPACE_ROOT;
const { root: FRONTEND_ROOT, candidates: FRONTEND_CANDIDATES } = resolveFrontendRoot();
const { root: RESOLVED_MODULES_DIR } = resolveBackendModulesDir();
const BACKEND_MODULES_DIR = RESOLVED_MODULES_DIR ?? join(BACKEND_ROOT, "src", "modules");
const FRONTEND_UNION_FILES = (FRONTEND_ROOT === null ? [] : [
  join(FRONTEND_ROOT, "lib", "rbac", "permissions", "permission-key-foundation.ts"),
  join(FRONTEND_ROOT, "lib", "rbac", "permissions", "permission-key-extended.ts"),
  join(FRONTEND_ROOT, "lib", "rbac", "permissions", "permission-key-business.ts"),
]);

// The extractors live in ./permission-key-extractors.mjs so this check and
// check-navigation-permissions read keys through one implementation.
const SPEC_RE = /\.(spec|e2e-spec)\.ts$/;

// ── self-test ───────────────────────────────────────────────────────────────

if (args.includes("--self-test")) {
  // Synthetic frontend union: view key present, manage key absent (intentional subset).
  // A third key "real:other:read" is in the union but unused on any route — that is fine.
  const syntheticUnionSources = [
    `export type RealPermKey =\n  | "real:thing:view"\n  | "real:other:read";\n`,
  ];

  // Synthetic route file. Line numbers matter — the report names file:line.
  //   Line 2  — a constant declaration the resolver must pick up
  //   Line 4  — good key (in both catalogs)
  //   Line 7  — ghost key (absent from backend catalog entirely)
  //   Line 10 — backend-only key (in backend, absent from frontend union)
  //   Line 13 — constant argument, resolvable through line 2
  //   Line 16 — constant argument nothing declares: unresolvable, must fail
  const syntheticRouteFile = [
    "",
    `const REVIEW_PERMISSION = "real:thing:view";`,
    "",
    `  @RequirePermission("real:thing:view")`,
    "  async viewThings() { return []; }",
    "",
    `  @RequirePermission("ghost:key:missing")`,
    "  async ghostAction() { return null; }",
    "",
    `  @RequirePermission("real:thing:manage")`,
    "  async manageThings() { return null; }",
    "",
    `  @RequirePermission(REVIEW_PERMISSION)`,
    "  async reviewThings() { return null; }",
    "",
    `  @RequirePermission(UNDECLARED_CONSTANT)`,
    "  async mysteryThings() { return null; }",
  ].join("\n");

  // The real catalog is loaded, not parsed, so the self-test asserts against it
  // directly: a generated key must be present, which is exactly what the old
  // grep-based catalog reader got wrong.
  let realCatalog = null;
  let catalogError = null;
  try {
    realCatalog = loadBackendCatalog();
  } catch (err) {
    catalogError = err.message;
  }

  const backendKeys = new Set(["real:thing:view", "real:thing:manage"]);
  const frontendKeys = parseUnionKeys(syntheticUnionSources);
  const constants = parsePermissionConstants(syntheticRouteFile);
  const routeRefs = parseRouteRefs(syntheticRouteFile, "synthetic/route.controller.ts", constants);

  const resolvedRefs = routeRefs.filter((r) => r.resolved);
  const unresolvedRefs = routeRefs.filter((r) => !r.resolved);
  const ghostsFromBackend = resolvedRefs.filter((r) => !backendKeys.has(r.key));
  const ghostsFromFrontend = resolvedRefs.filter((r) => !frontendKeys.has(r.key));
  const backendOnlyGhost = ghostsFromBackend.find((r) => r.key === "ghost:key:missing");

  const checks = {
    realCatalogLoads: realCatalog !== null,
    // The twelve generated <module>:access:* keys are the reason this is loaded
    // rather than greped. If this fails, every navigation gate on an access
    // screen reads as a ghost key.
    realCatalogContainsGeneratedAccessKey: realCatalog?.names.has("crm:access:view") === true,
    realCatalogContainsLiteralKey: realCatalog?.names.has("hr:employees:view") === true,
    realCatalogHasNoBareIdentifiers: realCatalog
      ? [...realCatalog.names].every((k) => k.includes(":"))
      : false,
    frontendUnionParsesViewKey: frontendKeys.has("real:thing:view"),
    frontendUnionOmitsManageKey: !frontendKeys.has("real:thing:manage"),
    constantDeclarationIsPickedUp: constants.get("REVIEW_PERMISSION") === "real:thing:view",
    routeRefsFoundFiveUsages: routeRefs.length === 5,
    constantArgumentResolves: routeRefs.some(
      (r) => r.line === 13 && r.resolved && r.key === "real:thing:view",
    ),
    undeclaredConstantIsReportedNotSkipped:
      unresolvedRefs.length === 1 &&
      unresolvedRefs[0].line === 16 &&
      unresolvedRefs[0].identifier === "UNDECLARED_CONSTANT",
    ghostKeyDetectedOnLine7: backendOnlyGhost?.line === 7,
    ghostKeyFiresBackendCheck: ghostsFromBackend.length === 1,
    ghostKeyFiresFrontendCheck: ghostsFromFrontend.length === 2,
    cleanKeyPassesBothChecks:
      !ghostsFromBackend.some((r) => r.key === "real:thing:view") &&
      !ghostsFromFrontend.some((r) => r.key === "real:thing:view"),
    intentionalSubsetDoesNotFire: !ghostsFromBackend.some((r) => r.key === "real:other:read"),
  };

  // --- Pilot: namespace mismatch is detected ---
  const pilotEntry = { id: "timesheets", administersNamespaces: [] };
  const insideRef = {
    key: "timesheets:entries:view",
    resolved: true,
    file: "src/modules/timesheets/timesheets.controller.ts",
    line: 5,
  };
  const outsideRef = {
    key: "hr:employees:view",
    resolved: true,
    file: "src/modules/timesheets/timesheets.controller.ts",
    line: 10,
  };
  const otherModuleRef = {
    key: "hr:employees:view",
    resolved: true,
    file: "src/modules/hr/hr.controller.ts",
    line: 5,
  };
  const pilotOk = checkNamespacePilot(pilotEntry, [insideRef, otherModuleRef], BACKEND_MODULES_DIR);
  const pilotFail = checkNamespacePilot(pilotEntry, [insideRef, outsideRef], BACKEND_MODULES_DIR);
  checks.pilotNamespaceMatchPasses = pilotOk.ok;
  checks.pilotNamespaceMismatchDetected = !pilotFail.ok && pilotFail.violations.length === 1;
  checks.pilotOtherModuleRefNotFlagged = pilotOk.violations.length === 0;

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(
    JSON.stringify({ selfTest: true, pass, checks, catalogError }, null, 2) + "\n",
  );
  process.exit(pass ? 0 : 1);
}

// ── filesystem walk ─────────────────────────────────────────────────────────

function walkTs(dir, skipSpecs) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkTs(full, skipSpecs));
    } else if (entry.name.endsWith(".ts")) {
      if (skipSpecs && SPEC_RE.test(entry.name)) continue;
      results.push(full);
    }
  }
  return results;
}

// ── load catalogs ───────────────────────────────────────────────────────────

let backendCatalog, frontendCatalog;
try {
  backendCatalog = loadBackendCatalog().names;
} catch (err) {
  process.stderr.write(`Cannot load the backend permission catalog: ${err.message}\n`);
  process.exit(2);
}

try {
  const unionSources = FRONTEND_UNION_FILES.map((f) => readFileSync(f, "utf8"));
  frontendCatalog = parseUnionKeys(unionSources);
} catch (err) {
  process.stderr.write(`Cannot read frontend PermissionKey union files: ${err.message}\n`);
  process.exit(2);
}

// ── scan route files ────────────────────────────────────────────────────────

const files = walkTs(BACKEND_MODULES_DIR, true).map((file) => ({
  file,
  src: readFileSync(file, "utf8"),
}));

// Two passes: a constant may be declared in the file that exports it and used in
// the controller that imports it, so the map has to be complete before any
// decorator is resolved.
const constants = new Map();
for (const { src } of files)
  for (const [name, key] of parsePermissionConstants(src)) constants.set(name, key);

const routeRefs = files.flatMap(({ file, src }) => parseRouteRefs(src, file, constants));

// ── collect offenders ───────────────────────────────────────────────────────

// Group by key so each key shows all locations it is used.
const missingBackend = new Map();
const missingFrontend = new Map();
const unresolved = new Map();

for (const ref of routeRefs) {
  const rel = relative(REPO_ROOT, ref.file);
  if (!ref.resolved) {
    if (!unresolved.has(ref.identifier)) unresolved.set(ref.identifier, []);
    unresolved.get(ref.identifier).push(`${rel}:${ref.line}`);
    continue;
  }
  if (!backendCatalog.has(ref.key)) {
    if (!missingBackend.has(ref.key)) missingBackend.set(ref.key, []);
    missingBackend.get(ref.key).push(`${rel}:${ref.line}`);
  }
  if (!frontendCatalog.has(ref.key)) {
    if (!missingFrontend.has(ref.key)) missingFrontend.set(ref.key, []);
    missingFrontend.get(ref.key).push(`${rel}:${ref.line}`);
  }
}

// ── report ──────────────────────────────────────────────────────────────────

const viaConstant = routeRefs.filter((r) => r.identifier !== null).length;
const uniqueKeys = new Set(routeRefs.filter((r) => r.resolved).map((r) => r.key)).size;
console.log(`Scanned  ${routeRefs.length} @RequirePermission usages  (${uniqueKeys} unique keys)`);
console.log(`  of which ${viaConstant} pass a constant rather than a literal`);
console.log(`Backend catalog   ${backendCatalog.size} keys`);
console.log(`Frontend PermissionKey union  ${frontendCatalog.size} keys`);
console.log("");

if (unresolved.size > 0) {
  console.error("UNRESOLVED ARGUMENTS — a decorator argument this check could not resolve to a key:");
  console.error("  These routes are unverified. Declare the constant as `const NAME = \"module:resource:action\"`.");
  for (const [identifier, locs] of [...unresolved].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.error(`  FAIL  ${identifier}`);
    for (const loc of locs) console.error(`        ${loc}`);
  }
  console.error("");
}

if (missingBackend.size > 0) {
  console.error("GHOST KEYS — used on routes but absent from the backend catalog:");
  console.error("  These keys can never be granted, so the route 403s for every non-owner.");
  for (const [key, locs] of [...missingBackend].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.error(`  FAIL  "${key}"`);
    for (const loc of locs) console.error(`        ${loc}`);
  }
  console.error("");
}

if (missingFrontend.size > 0) {
  console.error("FRONTEND-MISSING KEYS — used on routes but absent from the frontend PermissionKey union:");
  console.error("  useCan(key) returns false forever; every gated control is permanently hidden.");
  for (const [key, locs] of [...missingFrontend].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.error(`  FAIL  "${key}"`);
    for (const loc of locs) console.error(`        ${loc}`);
  }
  console.error("");
}

const totalFailures = missingBackend.size + missingFrontend.size + unresolved.size;
if (totalFailures === 0) {
  console.log("OK — every @RequirePermission key resolves and exists in the backend catalog and the frontend PermissionKey union.");
} else {
  console.error(
    `FAIL — ${unresolved.size} unresolvable argument(s), ` +
      `${missingBackend.size} key(s) absent from backend catalog, ` +
      `${missingFrontend.size} key(s) absent from frontend PermissionKey union.`,
  );
}

// ── Manifest pilot: namespace check for timesheets ──────────────────────────

let pilotFailed = false;
try {
  const manifest = loadModuleManifest();
  const pilotManifestEntry = manifest.modules.find((m) => m.id === PILOT_MODULE);
  if (pilotManifestEntry) {
    const pilotCheck = checkNamespacePilot(pilotManifestEntry, routeRefs, BACKEND_MODULES_DIR);
    if (pilotCheck.ok) {
      console.log(`\nManifest pilot (${PILOT_MODULE}): all @RequirePermission keys in its folder use declared namespaces — OK`);
    } else {
      console.error(`\nManifest pilot (${PILOT_MODULE}): FAIL — keys outside declared namespaces:`);
      for (const v of pilotCheck.violations) {
        console.error(`  "${v.key}"  ${relative(REPO_ROOT, v.file)}:${v.line}`);
      }
      pilotFailed = true;
    }
  }
} catch (err) {
  process.stderr.write(`Manifest pilot check skipped: ${err.message}\n`);
}

if (totalFailures === 0 && !pilotFailed) {
  process.exit(0);
} else {
  process.exit(1);
}
