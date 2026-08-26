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
 * TWO CHECKS (both fail exit 1):
 *
 *   1. Key used on a route but absent from the BACKEND catalog
 *      (src/modules/rbac/permissions/).
 *      The route can never be granted — authorize() returns NO_MODULE or FORBIDDEN
 *      for an unknown key, so the route 403s for every non-owner permanently.
 *
 *   2. Key used on a route but absent from the FRONTEND PermissionKey union
 *      (frontend/lib/rbac/permissions/permission-key-*.ts).
 *      useCan(key) silently returns false for any key TypeScript does not accept,
 *      hiding every control that calls it.
 *
 * NON-FAILURE (intentional subset):
 *   Backend catalog keys that are NOT used on any route are fine — they may be
 *   checked programmatically inside service methods or reserved for future routes.
 *   Frontend PERMISSIONS runtime array is a deliberate subset of the union; the
 *   ~206-key gap is tested in catalog-sync.test.ts and must NOT be reported here.
 *
 * SCOPE:
 *   Routes scanned: backend/src/modules/ (all .ts files, spec files excluded).
 *   Backend catalog: backend/src/modules/rbac/permissions/*.ts (excl. barrel files).
 *   Frontend union:  frontend/lib/rbac/permissions/permission-key-{foundation,extended,business}.ts
 *
 * Usage (run from backend/ or anywhere — paths are resolved from this file):
 *   node src/scripts/check-permission-keys.mjs
 *   node src/scripts/check-permission-keys.mjs --self-test
 *
 * Exit codes:
 *   0  — every route key exists in both catalogs
 *   1  — at least one ghost key found (or self-test failed)
 *   2  — usage error (e.g. catalog directory unreachable)
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
// scripts/ → src/ → backend/ → repo root
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const BACKEND_ROOT = resolve(REPO_ROOT, "backend");
const BACKEND_MODULES_DIR = join(BACKEND_ROOT, "src", "modules");
const BACKEND_PERMISSIONS_DIR = join(BACKEND_MODULES_DIR, "rbac", "permissions");
const FRONTEND_UNION_FILES = [
  join(REPO_ROOT, "frontend", "lib", "rbac", "permissions", "permission-key-foundation.ts"),
  join(REPO_ROOT, "frontend", "lib", "rbac", "permissions", "permission-key-extended.ts"),
  join(REPO_ROOT, "frontend", "lib", "rbac", "permissions", "permission-key-business.ts"),
];

// catalog.ts re-exports everything; index.ts is the barrel; role-defaults.ts and
// types.ts hold role templates and the Permission type, not key declarations.
const EXCLUDED_CATALOG_FILES = new Set(["index.ts", "catalog.ts", "role-defaults.ts", "types.ts"]);
const SPEC_RE = /\.(spec|e2e-spec)\.ts$/;

// ── pure parsing functions ──────────────────────────────────────────────────
// These are the real extractors — the self-test calls them with fixture strings
// so that a bug in the extractor fails the self-test, not just the real run.

/**
 * Extract permission key names from backend catalog source files.
 * fileMap: Map<basename, source>
 */
export function parseCatalogKeys(fileMap) {
  const keys = new Set();
  for (const [name, src] of fileMap) {
    if (EXCLUDED_CATALOG_FILES.has(name)) continue;
    for (const m of src.matchAll(/\bname:\s*["']([^"']+)["']/g)) {
      if (m[1].includes(":")) keys.add(m[1]);
    }
  }
  return keys;
}

/**
 * Extract PermissionKey union literal values from the frontend type files.
 * sources: iterable of source strings (one per file).
 */
export function parseUnionKeys(sources) {
  const keys = new Set();
  for (const src of sources) {
    for (const m of src.matchAll(/\|\s*["']([^"']+)["']/g)) {
      if (m[1].includes(":")) keys.add(m[1]);
    }
  }
  return keys;
}

/**
 * Extract @RequirePermission("key") usages from a single source file.
 * Returns { key, file, line }[].
 * Line numbers are 1-based.
 */
export function parseRouteRefs(src, filePath) {
  const refs = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/@RequirePermission\(\s*["']([^"']+)["']\s*\)/);
    if (m) refs.push({ key: m[1], file: filePath, line: i + 1 });
  }
  return refs;
}

// ── self-test ───────────────────────────────────────────────────────────────

if (args.includes("--self-test")) {
  // Synthetic backend catalog: two real keys declared in the standard object shape.
  const syntheticCatalogMap = new Map([
    [
      "real.permissions.ts",
      `import type { Permission } from "./types";
export const REAL_PERMISSIONS: Permission[] = [
  { name: "real:thing:view", resource: "real:thing", action: "view", description: "View things" },
  { name: "real:thing:manage", resource: "real:thing", action: "manage", description: "Manage things" },
];`,
    ],
    // Excluded barrel — the parser must ignore it even though it references names.
    ["catalog.ts", `export const ALL = [...REAL_PERMISSIONS]; export const ALL_NAMES = ALL.map(p => p.name);`],
  ]);

  // Synthetic frontend union: view key present, manage key absent (intentional subset).
  // A third key "real:other:read" is in the union but unused on any route — that is fine.
  const syntheticUnionSources = [
    `export type RealPermKey =\n  | "real:thing:view"\n  | "real:other:read";\n`,
  ];

  // Synthetic route file: three @RequirePermission usages on separate lines.
  //   Line 2 — good key (in both catalogs)
  //   Line 5 — ghost key (absent from backend catalog entirely)
  //   Line 8 — backend-only key (in backend, absent from frontend union)
  const syntheticRouteFile = [
    "",
    `  @RequirePermission("real:thing:view")`,
    "  async viewThings() { return []; }",
    "",
    `  @RequirePermission("ghost:key:missing")`,
    "  async ghostAction() { return null; }",
    "",
    `  @RequirePermission("real:thing:manage")`,
    "  async manageThings() { return null; }",
  ].join("\n");

  const backendKeys = parseCatalogKeys(syntheticCatalogMap);
  const frontendKeys = parseUnionKeys(syntheticUnionSources);
  const routeRefs = parseRouteRefs(syntheticRouteFile, "synthetic/route.controller.ts");

  const ghostsFromBackend = routeRefs.filter((r) => !backendKeys.has(r.key));
  const ghostsFromFrontend = routeRefs.filter((r) => !frontendKeys.has(r.key));
  const backendOnlyGhost = ghostsFromBackend.find((r) => r.key === "ghost:key:missing");

  const checks = {
    backendCatalogParsesViewKey: backendKeys.has("real:thing:view"),
    backendCatalogParsesManageKey: backendKeys.has("real:thing:manage"),
    backendCatalogIgnoresGhostKey: !backendKeys.has("ghost:key:missing"),
    backendCatalogIgnoresExcludedFile: !backendKeys.has("ALL_NAMES"),
    frontendUnionParsesViewKey: frontendKeys.has("real:thing:view"),
    frontendUnionOmitsManageKey: !frontendKeys.has("real:thing:manage"),
    routeRefsFoundThreeKeys: routeRefs.length === 3,
    ghostKeyDetectedOnLine5: backendOnlyGhost?.line === 5,
    ghostKeyFiresBackendCheck: ghostsFromBackend.length === 1,
    ghostKeyFiresFrontendCheck: ghostsFromFrontend.length === 2,
    cleanKeyPassesBothChecks:
      !ghostsFromBackend.some((r) => r.key === "real:thing:view") &&
      !ghostsFromFrontend.some((r) => r.key === "real:thing:view"),
    intentionalSubsetDoesNotFire:
      !ghostsFromBackend.some((r) => r.key === "real:other:read"),
  };

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, checks }, null, 2) + "\n");
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
  const catalogFileMap = new Map();
  for (const f of readdirSync(BACKEND_PERMISSIONS_DIR).filter((n) => n.endsWith(".ts")))
    catalogFileMap.set(f, readFileSync(join(BACKEND_PERMISSIONS_DIR, f), "utf8"));
  backendCatalog = parseCatalogKeys(catalogFileMap);
} catch (err) {
  process.stderr.write(`Cannot read backend permissions dir: ${err.message}\n`);
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

const routeRefs = [];
for (const file of walkTs(BACKEND_MODULES_DIR, true)) {
  const src = readFileSync(file, "utf8");
  routeRefs.push(...parseRouteRefs(src, file));
}

// ── collect offenders ───────────────────────────────────────────────────────

// Group by key so each key shows all locations it is used.
const missingBackend = new Map();
const missingFrontend = new Map();

for (const { key, file, line } of routeRefs) {
  const rel = relative(REPO_ROOT, file);
  if (!backendCatalog.has(key)) {
    if (!missingBackend.has(key)) missingBackend.set(key, []);
    missingBackend.get(key).push(`${rel}:${line}`);
  }
  if (!frontendCatalog.has(key)) {
    if (!missingFrontend.has(key)) missingFrontend.set(key, []);
    missingFrontend.get(key).push(`${rel}:${line}`);
  }
}

// ── report ──────────────────────────────────────────────────────────────────

const uniqueKeys = new Set(routeRefs.map((r) => r.key)).size;
console.log(`Scanned  ${routeRefs.length} @RequirePermission usages  (${uniqueKeys} unique keys)`);
console.log(`Backend catalog   ${backendCatalog.size} keys`);
console.log(`Frontend PermissionKey union  ${frontendCatalog.size} keys`);
console.log("");

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

const totalFailures = missingBackend.size + missingFrontend.size;
if (totalFailures === 0) {
  console.log("OK — every @RequirePermission key exists in the backend catalog and the frontend PermissionKey union.");
  process.exit(0);
} else {
  console.error(
    `FAIL — ${missingBackend.size} key(s) absent from backend catalog, ` +
      `${missingFrontend.size} key(s) absent from frontend PermissionKey union.`,
  );
  process.exit(1);
}
