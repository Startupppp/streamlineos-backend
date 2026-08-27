/**
 * check-navigation-permissions.mjs
 *
 * Every non-universal navigation destination must name the exact permission its
 * route enforces. This check fails (exit 1) when a sidebar gate names a key that
 * no backend route actually checks.
 *
 * WHY THIS IS NOT THE SAME CHECK AS check-permission-keys:
 *   check-permission-keys walks route -> catalog: it catches a route gated on a
 *   key nobody can hold. This one walks navigation -> route, the other direction,
 *   and catches a destination whose gate and whose handler disagree. Both keys
 *   can exist in both catalogs and the pair still be wrong.
 *
 * THE TWO FAILURES IT NAMES:
 *
 *   1. UNKNOWN KEY — a nav gate names a key absent from the backend catalog.
 *      `useCan` can never return true for it, so the destination is invisible to
 *      everyone including the org owner. This is the navigation-side twin of the
 *      historical "hr:employees:export" ghost key.
 *
 *   2. UNENFORCED KEY — a nav gate names a catalog key that appears in no
 *      @RequirePermission on any route. The link is shown to whoever holds that
 *      key, but the page behind it is gated on something else (or on nothing),
 *      so holding the key neither guarantees the page loads nor is required for
 *      it to. The gate is decorative, which is worse than absent: a reviewer sees
 *      a permission and stops looking.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK:
 *   - That every nav route carries some requirement, and that universal surfaces
 *     carry none. That is already asserted, with the root CLAUDE.md section 8
 *     universal allowlist in it, by
 *     frontend/components/layout/sidebar/sidebar-permission-coverage.test.ts.
 *     Re-implementing that allowlist here would fork it.
 *   - href -> handler resolution. A frontend href maps to an App Router folder,
 *     not to one backend route, and a page calls several endpoints. The honest
 *     invariant is that the key a destination advertises is a key some route
 *     enforces, which is what fails when the two drift.
 *   - The frontend PERMISSIONS runtime array, a deliberate subset of the union.
 *
 * Usage:
 *   node src/scripts/check-navigation-permissions.mjs
 *   node src/scripts/check-navigation-permissions.mjs --self-test
 *
 * Exit codes:
 *   0  every navigation gate names a key some route enforces
 *   1  at least one unknown or unenforced gate (or self-test failed)
 *   2  usage error (a catalog or manifest directory is unreachable)
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadBackendCatalog,
  parseNavGates,
  parsePermissionConstants,
  parseRouteRefs,
} from "./permission-key-extractors.mjs";

const args = process.argv.slice(2);

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
// scripts/ -> src/ -> backend/ -> repo root
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const BACKEND_MODULES_DIR = join(REPO_ROOT, "backend", "src", "modules");
const NAV_DIR = join(REPO_ROOT, "frontend", "components", "layout", "sidebar");

const SPEC_RE = /\.(spec|e2e-spec|test)\.ts$/;
const NAV_FILE_RE = /^sidebar-(home-nav|nav-groups-.+|nav-routes-.+)\.ts$/;

/**
 * The one class of key a navigation gate may name that no @RequirePermission
 * carries: the access screens.
 *
 * `<module>:access:view` and `:manage` are read by assertModuleAccessPolicy
 * (module-access.helpers.ts:100) rather than by the guard, because §5 makes a
 * delegated `access:manage` grant view-only and a permission key cannot express
 * management standing — which is why those routes carry
 * @AuthorizedInService("assertModuleAccessPolicy"). So the gate does name the
 * exact permission the destination enforces; the enforcement is one layer down.
 *
 * Derived from the same ACCESS_MANAGED_MODULES list the keys are generated from,
 * so this is the generator's own output rather than a hand-kept allowlist: a new
 * delegable module is covered on the day it exists, and a module leaving the
 * list starts failing again the same day. Every excused key is printed.
 */
function inServiceEnforcedKeys(accessManaged) {
  const keys = new Map();
  for (const moduleKey of accessManaged) {
    for (const action of ["view", "manage"]) {
      keys.set(
        `${moduleKey}:access:${action}`,
        `read by assertModuleAccessPolicy (module-access.helpers.ts:100); the route declares @AuthorizedInService`,
      );
    }
  }
  return keys;
}

// -- self-test ---------------------------------------------------------------

if (args.includes("--self-test")) {
  const syntheticCatalogNames = new Set([
    "real:thing:view",
    "real:thing:manage",
    "real:orphan:view",
  ]);

  // One route enforces the view key via a literal, one via a constant.
  // Nothing enforces real:orphan:view.
  const syntheticRouteFile = [
    "",
    `const MANAGE = "real:thing:manage";`,
    "",
    `  @RequirePermission("real:thing:view")`,
    "  async viewThings() { return []; }",
    "",
    `  @RequirePermission(MANAGE)`,
    "  async manageThings() { return null; }",
  ].join("\n");

  // Nav manifest exercising every shape the parser must survive:
  //   - a group gate written as a multi-line array, before any href
  //   - an inline single-key route gate
  //   - a route naming a catalog key that no route enforces  (line 20)
  //   - a route naming a key in no catalog at all            (line 26)
  //   - a universal route with no gate at all (must produce nothing)
  const syntheticNav = [
    `export const X_NAV_GROUPS: NavGroup[] = [`, //          1
    `  {`, //                                                2
    `    label: "Things",`, //                               3
    `    product: "crm",`, //                                4
    `    requiredPermission: [`, //                          5
    `      "real:thing:view",`, //                           6
    `      "real:thing:manage",`, //                         7
    `    ],`, //                                             8
    `    routes: [`, //                                      9
    `      {`, //                                           10
    `        label: "Overview",`, //                        11
    `        icon: LayoutDashboard,`, //                    12
    `        href: "/things",`, //                          13
    `        requiredPermission: "real:thing:view",`, //     14
    `      },`, //                                          15
    `      {`, //                                           16
    `        label: "Orphan",`, //                          17
    `        icon: Star,`, //                               18
    `        href: "/things/orphan",`, //                   19
    `        requiredPermission: "real:orphan:view",`, //    20
    `      },`, //                                          21
    `      {`, //                                           22
    `        label: "Ghost",`, //                           23
    `        icon: Star,`, //                               24
    `        href: "/things/ghost",`, //                    25
    `        requiredPermission: "ghost:key:missing",`, //   26
    `      },`, //                                          27
    `      {`, //                                           28
    `        label: "Universal",`, //                       29
    `        icon: Home,`, //                               30
    `        href: "/me/profile",`, //                      31
    `      },`, //                                          32
    `    ],`, //                                            33
    `  },`, //                                              34
    `];`, //                                                35
  ].join("\n");

  const constants = parsePermissionConstants(syntheticRouteFile);
  const routeRefs = parseRouteRefs(syntheticRouteFile, "r.ts", constants);
  const enforced = new Set(routeRefs.filter((r) => r.resolved).map((r) => r.key));
  const gates = parseNavGates(syntheticNav, "nav.ts");

  const unknown = gates.filter((g) => !syntheticCatalogNames.has(g.key));
  const unenforced = gates.filter(
    (g) => syntheticCatalogNames.has(g.key) && !enforced.has(g.key),
  );
  const orphanGate = gates.find((g) => g.key === "real:orphan:view");
  const ghostGate = gates.find((g) => g.key === "ghost:key:missing");
  const groupGates = gates.filter((g) => g.href === null);

  // The real catalog is loaded, not parsed. Assert against it directly: the
  // twelve generated <module>:access:view keys are exactly what a text scan of
  // the catalog folder misses, and every access screen in the sidebar is gated
  // on one of them.
  let realCatalog = null;
  let catalogError = null;
  try {
    realCatalog = loadBackendCatalog();
  } catch (err) {
    catalogError = err.message;
  }

  const checks = {
    realCatalogLoads: realCatalog !== null,
    realCatalogContainsGeneratedAccessKey: realCatalog?.names.has("crm:access:view") === true,
    parsesGroupArrayGate: groupGates.length === 2,
    groupGateHasNoHref: groupGates.every((g) => g.href === null && g.label === "Things"),
    groupGateLinesAreTheKeyLines: groupGates.map((g) => g.line).join(",") === "6,7",
    parsesInlineRouteGate: gates.some((g) => g.key === "real:thing:view" && g.href === "/things"),
    ungatedRouteProducesNothing: !gates.some((g) => g.href === "/me/profile"),
    hrefResetsOnLabelSoGroupIsNotMisattributed: !groupGates.some((g) => g.href !== null),
    // A route enforcing its key through a constant still counts as enforced,
    // or every gate pointing at one of those 21 routes reads as decorative.
    constantEnforcedKeyCountsAsEnforced: enforced.has("real:thing:manage"),
    unknownKeyDetected: unknown.length === 1 && unknown[0].key === "ghost:key:missing",
    unknownKeyNamesItsLine: ghostGate?.line === 26 && ghostGate?.href === "/things/ghost",
    unenforcedKeyDetected: unenforced.length === 1 && unenforced[0].key === "real:orphan:view",
    unenforcedKeyNamesItsLine: orphanGate?.line === 20 && orphanGate?.href === "/things/orphan",
    enforcedKeyPasses:
      !unknown.some((g) => g.key === "real:thing:view") &&
      !unenforced.some((g) => g.key === "real:thing:view"),
  };

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(
    JSON.stringify({ selfTest: true, pass, checks, catalogError }, null, 2) + "\n",
  );
  process.exit(pass ? 0 : 1);
}

// -- filesystem --------------------------------------------------------------

function walkTs(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkTs(full));
    else if (entry.name.endsWith(".ts") && !SPEC_RE.test(entry.name)) results.push(full);
  }
  return results;
}

let catalog, inServiceEnforced;
try {
  const loaded = loadBackendCatalog();
  catalog = loaded.names;
  inServiceEnforced = inServiceEnforcedKeys(loaded.accessManaged);
} catch (err) {
  process.stderr.write(`Cannot load the backend permission catalog: ${err.message}\n`);
  process.exit(2);
}

if (!existsSync(NAV_DIR)) {
  process.stderr.write(`Cannot read frontend navigation manifest dir: ${NAV_DIR}\n`);
  process.exit(2);
}

const files = walkTs(BACKEND_MODULES_DIR).map((file) => ({
  file,
  src: readFileSync(file, "utf8"),
}));
const constants = new Map();
for (const { src } of files)
  for (const [name, key] of parsePermissionConstants(src)) constants.set(name, key);

const enforced = new Set();
let unresolvedRouteArgs = 0;
for (const { file, src } of files)
  for (const ref of parseRouteRefs(src, file, constants)) {
    if (ref.resolved) enforced.add(ref.key);
    else unresolvedRouteArgs++;
  }

const navFiles = readdirSync(NAV_DIR).filter((n) => NAV_FILE_RE.test(n));
if (navFiles.length === 0) {
  process.stderr.write(`No navigation manifest files matched in ${NAV_DIR}\n`);
  process.exit(2);
}

const gates = [];
for (const name of navFiles) {
  const full = join(NAV_DIR, name);
  gates.push(...parseNavGates(readFileSync(full, "utf8"), full));
}

// -- report ------------------------------------------------------------------

const where = (g) => {
  const rel = relative(REPO_ROOT, g.file);
  const dest = g.href ?? `group "${g.label}"`;
  return `${rel}:${g.line}  ${dest}`;
};

const unknown = new Map();
const unenforced = new Map();
const excused = new Map();
for (const gate of gates) {
  if (inServiceEnforced.has(gate.key)) {
    if (!excused.has(gate.key)) excused.set(gate.key, []);
    excused.get(gate.key).push(where(gate));
    continue;
  }
  const bucket = !catalog.has(gate.key) ? unknown : !enforced.has(gate.key) ? unenforced : null;
  if (!bucket) continue;
  if (!bucket.has(gate.key)) bucket.set(gate.key, []);
  bucket.get(gate.key).push(where(gate));
}

const uniqueGateKeys = new Set(gates.map((g) => g.key)).size;
console.log(`Navigation gates  ${gates.length}  (${uniqueGateKeys} unique keys)`);
console.log(`Backend catalog   ${catalog.size} keys`);
console.log(`Keys enforced on a route  ${enforced.size}`);
if (unresolvedRouteArgs > 0)
  console.log(`  warning: ${unresolvedRouteArgs} decorator argument(s) unresolved — run check:permission-keys`);
console.log("");

if (excused.size > 0) {
  console.log("ENFORCED IN SERVICE — named, not hidden in an allowlist:");
  for (const [key, locs] of [...excused].sort((a, b) => a[0].localeCompare(b[0])))
    console.log(`  SKIP  "${key}"  ×${locs.length}  — ${inServiceEnforced.get(key)}`);
  console.log("");
}

if (unknown.size > 0) {
  console.error("UNKNOWN KEYS — a navigation gate names a key absent from the backend catalog:");
  console.error("  useCan can never return true, so the destination is invisible to everyone.");
  for (const [key, locs] of [...unknown].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.error(`  FAIL  "${key}"`);
    for (const loc of locs) console.error(`        ${loc}`);
  }
  console.error("");
}

if (unenforced.size > 0) {
  console.error("UNENFORCED KEYS — a navigation gate names a key no route enforces:");
  console.error("  The destination advertises a permission its handlers never check.");
  for (const [key, locs] of [...unenforced].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.error(`  FAIL  "${key}"`);
    for (const loc of locs) console.error(`        ${loc}`);
  }
  console.error("");
}

const failures = unknown.size + unenforced.size;
if (failures === 0) {
  console.log("OK — every navigation gate names a key that some route enforces.");
  process.exit(0);
}
console.error(
  `FAIL — ${unknown.size} key(s) absent from the backend catalog, ` +
    `${unenforced.size} key(s) enforced by no route.`,
);
process.exit(1);
