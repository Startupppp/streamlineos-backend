#!/usr/bin/env node
/**
 * verify-permission-catalog.mjs
 *
 * Enumerates every @RequirePermission key referenced on backend routes and
 * checks that each exists verbatim in the backend permission catalog and is
 * typeable in the frontend `PermissionKey` union. The frontend `PERMISSIONS`
 * runtime array is a deliberate subset of that union and is NOT the target —
 * comparing against it re-raises an already-adjudicated non-issue.
 *
 * Exit 0  — every key exists in the backend catalog and the frontend union.
 * Exit 1  — at least one key is missing; offenders are listed on stderr.
 *
 * Run from backend/:
 *   node src/common/auth/verify-permission-catalog.mjs
 *
 * Or via package.json script (to be wired by the CI lane):
 *   pnpm verify:permissions
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../../..");

const BACKEND_PERMISSIONS_DIR = join(REPO_ROOT, "backend", "src", "modules", "rbac", "permissions");
const BACKEND_MODULES_DIR = join(REPO_ROOT, "backend", "src", "modules");

// The frontend `PERMISSIONS` runtime array (lib/rbac/permissions/roles.ts) is a
// deliberate subset — only `catalog-sync.test.ts` consumes it as a value. The
// contract this checker must honour is "backend key set is typeable", i.e. every
// backend key appears in the `PermissionKey` union, which is these three files —
// never the PERMISSIONS array. See CLAUDE.md backend §5 "Both catalog directions
// are tested".
const FRONTEND_PERMISSION_KEY_UNION_FILES = [
  join(REPO_ROOT, "frontend", "lib", "rbac", "permissions", "permission-key-foundation.ts"),
  join(REPO_ROOT, "frontend", "lib", "rbac", "permissions", "permission-key-extended.ts"),
  join(REPO_ROOT, "frontend", "lib", "rbac", "permissions", "permission-key-business.ts"),
];

const SPEC_SUFFIX_RE = /\.(spec|e2e-spec)\.ts$/;

function walkTs(dir, skipSpecs) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkTs(full, skipSpecs));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      if (skipSpecs && SPEC_SUFFIX_RE.test(entry.name)) continue;
      results.push(full);
    }
  }
  return results;
}

function extractCatalogKeys(dir) {
  const keys = new Set();
  for (const file of walkTs(dir, false)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/\bname:\s*["']([^"']+)["']/g)) {
      if (m[1].includes(":")) keys.add(m[1]);
    }
  }
  return keys;
}

function extractPermissionKeyUnion(files) {
  const keys = new Set();
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/\|\s*["']([^"']+)["']/g)) {
      if (m[1].includes(":")) keys.add(m[1]);
    }
  }
  return keys;
}

function extractRouteRefs(dir) {
  const refs = [];
  for (const file of walkTs(dir, true)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/@RequirePermission\(\s*["']([^"']+)["']\s*\)/g)) {
      refs.push({ key: m[1], file });
    }
  }
  return refs;
}

const backendCatalog = extractCatalogKeys(BACKEND_PERMISSIONS_DIR);
const frontendCatalog = extractPermissionKeyUnion(FRONTEND_PERMISSION_KEY_UNION_FILES);
const routeRefs = extractRouteRefs(BACKEND_MODULES_DIR);

const missingFromBackend = new Map();
const missingFromFrontend = new Map();

for (const { key, file } of routeRefs) {
  const rel = relative(REPO_ROOT, file);
  if (!backendCatalog.has(key) && !missingFromBackend.has(key)) {
    missingFromBackend.set(key, rel);
  }
  if (!frontendCatalog.has(key) && !missingFromFrontend.has(key)) {
    missingFromFrontend.set(key, rel);
  }
}

const uniqueKeys = new Set(routeRefs.map((r) => r.key)).size;
console.log(`Scanned ${routeRefs.length} @RequirePermission references (${uniqueKeys} unique keys)`);
console.log(`Backend catalog: ${backendCatalog.size} permission keys`);
console.log(`Frontend PermissionKey union: ${frontendCatalog.size} permission keys`);

if (missingFromBackend.size > 0) {
  console.error("\nKeys used on routes but MISSING FROM BACKEND CATALOG:");
  for (const [key, file] of [...missingFromBackend].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.error(`  "${key}"  — first seen in ${file}`);
  }
}

if (missingFromFrontend.size > 0) {
  console.error("\nKeys used on routes but MISSING FROM FRONTEND CATALOG:");
  for (const [key, file] of [...missingFromFrontend].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.error(`  "${key}"  — first seen in ${file}`);
  }
}

const totalMissing = missingFromBackend.size + missingFromFrontend.size;
if (totalMissing === 0) {
  console.log("OK — every route permission key exists in both catalogs.");
  process.exit(0);
} else {
  console.error(
    `\nFAIL — ${missingFromBackend.size} key(s) missing from backend catalog, ` +
      `${missingFromFrontend.size} missing from frontend catalog.`,
  );
  process.exit(1);
}
