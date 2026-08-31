/**
 * Every non-universal navigation destination must name the permission its own
 * route enforces. Walks navigation -> route, the opposite direction to
 * check-permission-keys, and fails on a gate naming a key no route checks.
 *
 * Does not re-check that every route carries a requirement; that lives in
 * frontend sidebar-permission-coverage.test.ts with the section 8 allowlist.
 *
 * Usage:  node src/scripts/check-navigation-permissions.mjs [--self-test]
 * Exit:   0 clean · 1 unknown or unenforced gate · 2 catalog unreachable
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadBackendCatalog,
  loadModuleManifest,
  parseNavGates,
  parsePermissionConstants,
  parseRouteRefs,
} from "./permission-key-extractors.mjs";

const PILOT_MODULE = "timesheets";

/**
 * Extracts { product, href } pairs from a sidebar nav file source.
 * Tracks the most recent `product:` declaration and associates each `href:` with it.
 *
 * @param {string} src
 * @returns {Array<{ product: string, href: string, line: number }>}
 */
export function parseNavProductRoutes(src) {
  const routes = [];
  const lines = src.split("\n");
  let currentProduct = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const productMatch = line.match(/\bproduct:\s*["']([^"']*)["']/);
    if (productMatch) {
      currentProduct = productMatch[1];
      continue;
    }
    const hrefMatch = line.match(/\bhref:\s*["']([^"']*)["']/);
    if (hrefMatch && currentProduct !== null) {
      routes.push({ product: currentProduct, href: hrefMatch[1], line: i + 1 });
    }
  }
  return routes;
}

/**
 * For the pilot module, every nav route with a matching productKey must have
 * an href that starts with the manifest's declared route.
 *
 * @param {{ productKey: string|null, route: string|null }} pilotEntry
 * @param {Array<{ product: string, href: string, line: number }>} navRoutes
 */
export function checkNavRoutePilot(pilotEntry, navRoutes) {
  if (pilotEntry.productKey === null || pilotEntry.route === null) {
    return { ok: true, violations: [] };
  }
  const violations = navRoutes.filter(
    (r) => r.product === pilotEntry.productKey && !r.href.startsWith(pilotEntry.route),
  );
  return { ok: violations.length === 0, violations };
}

const args = process.argv.slice(2);

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
// scripts/ -> src/ -> backend/ -> repo root
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const BACKEND_MODULES_DIR = join(REPO_ROOT, "backend", "src", "modules");
const NAV_DIR = join(REPO_ROOT, "frontend", "components", "layout", "sidebar");

const SPEC_RE = /\.(spec|e2e-spec|test)\.ts$/;
const NAV_FILE_RE = /^sidebar-(home-nav|nav-groups-.+|nav-routes-.+)\.ts$/;

// The one class of key a navigation gate may name that no @RequirePermission carries: the access screens
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

  // One route enforces the view key via a literal, one via a constant
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

  // Nav manifest exercising every shape the parser must survive
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

  // The real catalog is loaded, not parsed
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
    // A route enforcing its key through a constant still counts as enforced, or every gate pointing at one of those 21 routes reads as decorative
    constantEnforcedKeyCountsAsEnforced: enforced.has("real:thing:manage"),
    unknownKeyDetected: unknown.length === 1 && unknown[0].key === "ghost:key:missing",
    unknownKeyNamesItsLine: ghostGate?.line === 26 && ghostGate?.href === "/things/ghost",
    unenforcedKeyDetected: unenforced.length === 1 && unenforced[0].key === "real:orphan:view",
    unenforcedKeyNamesItsLine: orphanGate?.line === 20 && orphanGate?.href === "/things/orphan",
    enforcedKeyPasses:
      !unknown.some((g) => g.key === "real:thing:view") &&
      !unenforced.some((g) => g.key === "real:thing:view"),
  };

  // --- Pilot: nav route outside declared module route is detected ---
  const pilotManEntry = { productKey: "timesheets", route: "/timesheets" };
  const correctNavRoutes = [
    { product: "timesheets", href: "/timesheets/my-hours", line: 5 },
    { product: "timesheets", href: "/timesheets/approvals", line: 8 },
    { product: "crm", href: "/crm/deals", line: 12 },
  ];
  const wrongNavRoutes = [
    { product: "timesheets", href: "/timesheets/my-hours", line: 5 },
    { product: "timesheets", href: "/wrong-path/timesheets-export", line: 9 },
  ];
  const pilotNavOk = checkNavRoutePilot(pilotManEntry, correctNavRoutes);
  const pilotNavFail = checkNavRoutePilot(pilotManEntry, wrongNavRoutes);
  checks.pilotNavRouteMatchPasses = pilotNavOk.ok;
  checks.pilotNavRouteMismatchDetected = !pilotNavFail.ok && pilotNavFail.violations.length === 1;

  // productRoutes parser: extracts product + href pairs correctly
  const syntheticNavSrc = [
    `  {`,
    `    label: "My Hours",`,
    `    product: "timesheets",`,
    `    routes: [`,
    `      { href: "/timesheets/my-hours", label: "My Hours", icon: X },`,
    `      { href: "/timesheets/approvals", label: "Approvals", icon: X },`,
    `    ],`,
    `  },`,
    `  {`,
    `    label: "CRM",`,
    `    product: "crm",`,
    `    routes: [`,
    `      { href: "/crm/deals", label: "Deals", icon: X },`,
    `    ],`,
    `  },`,
  ].join("\n");
  const parsed = parseNavProductRoutes(syntheticNavSrc);
  checks.pilotNavParserExtractsTimesheetsRoutes =
    parsed.filter((r) => r.product === "timesheets").length === 2;
  checks.pilotNavParserExtractsCrmRoutes =
    parsed.filter((r) => r.product === "crm").length === 1;

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
} else {
  console.error(
    `FAIL — ${unknown.size} key(s) absent from the backend catalog, ` +
      `${unenforced.size} key(s) enforced by no route.`,
  );
}

// -- Manifest pilot: nav routes for timesheets are under /timesheets ----------

let pilotFailed = false;
try {
  const manifest = loadModuleManifest();
  const pilotEntry = manifest.modules.find((m) => m.id === PILOT_MODULE);
  if (pilotEntry) {
    const allNavRoutes = [];
    for (const name of navFiles) {
      const full = join(NAV_DIR, name);
      allNavRoutes.push(...parseNavProductRoutes(readFileSync(full, "utf8")));
    }
    const pilotCheck = checkNavRoutePilot(pilotEntry, allNavRoutes);
    if (pilotCheck.ok) {
      console.log(`\nManifest pilot (${PILOT_MODULE}): all nav routes are under "${pilotEntry.route}" — OK`);
    } else {
      console.error(`\nManifest pilot (${PILOT_MODULE}): FAIL — nav routes outside declared route:`);
      for (const v of pilotCheck.violations) {
        console.error(`  product="${v.product}"  href="${v.href}"  line=${v.line}`);
      }
      pilotFailed = true;
    }
  }
} catch (err) {
  process.stderr.write(`Manifest pilot check skipped: ${err.message}\n`);
}

if (failures === 0 && !pilotFailed) {
  process.exit(0);
} else {
  process.exit(1);
}
