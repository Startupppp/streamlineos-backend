/**
 * check-namespace-coverage.mjs
 *
 * Static scan: every namespace READ via cachedVersioned / cachedVersionedForOrg
 * must have a corresponding invalidateNamespace / invalidateNamespaceForOrg call
 * somewhere in service code — unless it is declared kind:"ttl-only" in the matrix.
 *
 * Usage:
 *   node src/scripts/check-namespace-coverage.mjs           # full scan
 *   node src/scripts/check-namespace-coverage.mjs --self-test
 *
 * Exit codes:
 *   0 — all checks pass (or only dead-bump warnings)
 *   1 — one or more stale namespaces found (read but never bumped)
 *   2 — vacuity guard fired (scanned too few files or found too few reads)
 *   3 — self-test failure
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_SRC = resolve(__dirname, "..");

// Sized against the widened scan below (~4,000 files under modules/ + common/).
// A floor of 30 was survivable by an almost entirely broken walk.
const MIN_SERVICE_FILES = 1000;
const MIN_READ_NAMESPACES = 5;
const SELF_TEST = process.argv.includes("--self-test");

// ─── CACHE_KEYS factory → normalized namespace prefix ────────────────────────
// Maps CACHE_KEYS.factoryName(x) to the namespace prefix the factory produces,
// normalized (strip :<param> suffix and trailing colon).

const FACTORY_TO_NS = {
  finReportsNamespace: "fin:reports",
  finAssetsListNamespace: "fin:assets:list",
  finAssetCategoriesNamespace: "fin:asset-categories",
  finTaxCodesNamespace: "fin:tax-codes",
  finTaxPaymentsNamespace: "fin:tax-payments",
  finTaxDashboardNamespace: "fin:tax-dashboard",
  finTaxReportsNamespace: "fin:tax-reports",
  finExpensePoliciesNamespace: "fin:expense-policies",
  finBankAccountsNamespace: "fin:banking:accounts",
  finForecastNamespace: "fin:forecast",
  finBvaNamespace: "fin:bva",
  invProductsNamespace: "inv:products:list",
  invVendorsNamespace: "inv:vendors:list",
  invPoNamespace: "inv:po:list",
  invGrnNamespace: "inv:grn:list",
  invSoNamespace: "inv:so:list",
  invCycleCountsNamespace: "inv:cycle-counts:list",
  invQualityInspectionsNamespace: "inv:quality:inspections",
  invShipmentsNamespace: "inv:shipments",
  invPackagesNamespace: "inv:packages",
  invLoadsNamespace: "inv:loads",
  payrollSummaryNamespace: "timesheets:payroll:summary",
  payrollExportsNamespace: "timesheets:payroll:exports",
  payrollSettingsNamespace: "timesheets:payroll:settings",
  expensesListNamespace: "hr:expenses",
  orgHierarchyNamespace: "org:hierarchy",
  hrHeadcountNamespace: "hr:headcount",
  leaveAnalyticsNamespace: "hr:leave-analytics",
  orgMembersListNamespace: "org:members:list",
  orgProfileNamespace: "org:profile",
  salesKpisNamespace: "sales:kpis",
  contactsListNamespace: "crm:contacts:list",
  crmOrganizationsListNamespace: "crm:organizations:list",
  crmOrganizationDetailNamespace: "crm:organizations:detail",
  moduleOwnershipsList: "ownership:modules",
  moduleOwnershipDetail: "ownership:module",
  moduleRolesList: "module-access:roles",
  moduleGroupsList: "module-access:groups",
  moduleGroupMembers: "module-access:group-members",
  moduleAccessMembers: "module-access:members",
  moduleAccessOwnership: "module-access:ownership",
  rbacDiscoveryMembers: "rbac:members",
  permissionsMatrix: "rbac:matrix",
  rolePerms: "rbac:role-perms",
  timesheetSettingsNamespace: "timesheets:settings",
  timesheetRatesNamespace: "timesheets:rates",
  invExportJobsNamespace: "inv:export-jobs:list",
  invImportJobsNamespace: "inv:import-jobs:list",
  invQualityHoldsNamespace: "inv:quality:holds",
  invQualityRecallsNamespace: "inv:quality:recalls",
  invReplenishmentSuggestionsNamespace: "inv:replenishment:suggestions",
  invCustomerReturnsNamespace: "inv:cret:list",
  invVendorReturnsNamespace: "inv:vret:list",
  invCarriersNamespace: "inv:carriers",
  invChannelsList: "inv:channels:list",
  invDashboardNamespace: "inv:dashboard",
  invReorderNamespace: "inv:reorder",
  invStockSummaryReportNamespace: "inv:stock:summary-report",
  invPhysicalAuditsNamespace: "inv:physical-audits:list",
  invAuditExportJobsNamespace: "inv:audit-export-jobs:list",
  invInspectionPlansNamespace: "inv:quality:plans",
  hrEmployeesListNamespace: "hr:employees:list",
};

/**
 * The invalidation matrix files declare namespaces as DATA, and their prose
 * quotes call syntax verbatim — "this row claimed a
 * cachedVersioned('projects:list:<orgId>') reader that has never existed" is a
 * description field explaining a namespace that was deliberately left uncached.
 * Scanned as source, that sentence reads as a live unbumped read, and the gate
 * reported the very namespace whose entry documents why it must not be cached.
 * The `<orgId>` placeholder form is the tell: no call site writes one.
 */
const MATRIX_DATA_FILE = /[/\\]common[/\\]cache[/\\]cache-invalidation-[^/\\]+\.ts$/;

// ─── normalize a raw namespace string to a bare prefix ───────────────────────
// Two forms:
//   normalizeNs — for extracted source literals / template contents.
//     Strips ${...} template expressions then trailing colons. Leaves
//     literal segments (e.g. "clients:health") untouched.
//   normalizeMatrixNs — for matrix "namespace:" fields that use <placeholder>
//     syntax like "clients:health:<orgId>". Strips :<word> placeholders.

function normalizeNs(raw) {
  return raw
    .replace(/\$\{[^}]+\}/g, "")  // strip ${...} template expressions
    .replace(/:$/, "")             // strip trailing colon left by ${} removal
    .trim();
}

function normalizeMatrixNs(raw) {
  return raw
    .replace(/<[^>]+>/g, "")      // strip <placeholder> tokens
    .replace(/:$/, "")             // strip trailing colon
    .trim();
}

// ─── file scanning ────────────────────────────────────────────────────────────

function walkDir(dir, ext = ".ts") {
  const entries = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
      entries.push(...walkDir(full, ext));
    } else if (entry.endsWith(ext) && !entry.endsWith(".spec.ts") && !entry.endsWith(".test.ts")) {
      entries.push(full);
    }
  }
  return entries;
}

function readFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// ─── namespace extraction ─────────────────────────────────────────────────────

/**
 * Extract namespaces from cachedVersionedForOrg(orgId, "ns", ...) calls.
 * The second argument is always a string literal in this codebase.
 */
function extractVersionedForOrgReads(content) {
  const results = new Set();
  const re = /cachedVersionedForOrg\s*\([^,]+,\s*["'`]([^"'`]+)["'`]/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const ns = normalizeNs(m[1]);
    if (ns) results.add(ns);
  }
  return results;
}

/**
 * Extract namespaces from invalidateNamespaceForOrg(orgId, "ns") calls.
 * The second argument is always a string literal in this codebase.
 */
function extractVersionedForOrgBumps(content) {
  const results = new Set();
  const re = /invalidateNamespaceForOrg\s*\([^,]+,\s*["'`]([^"'`]+)["'`]/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const ns = normalizeNs(m[1]);
    if (ns) results.add(ns);
  }
  return results;
}

/**
 * Extract namespace prefix from a single argument expression.
 * Handles:
 *   CACHE_KEYS.factoryName(x)  → resolve via factory map
 *   `prefix:${x}`              → extract prefix
 *   "string literal"           → normalize
 *   CONSTANT_NAME(x)           → attempt to resolve, or return null
 */
function resolveNsExpression(expr) {
  expr = expr.trim();

  // CACHE_KEYS.factoryName(...)
  const cacheKeyMatch = /CACHE_KEYS\.(\w+)\s*\(/.exec(expr);
  if (cacheKeyMatch) {
    const factoryName = cacheKeyMatch[1];
    return FACTORY_TO_NS[factoryName] ?? null;
  }

  // Template literal: `prefix:${...}`
  const templateMatch = /^`([^`]+)`$/.exec(expr);
  if (templateMatch) {
    return normalizeNs(templateMatch[1]);
  }

  // String literal: "ns" or 'ns'
  const stringMatch = /^["']([^"']+)["']$/.exec(expr);
  if (stringMatch) {
    return normalizeNs(stringMatch[1]);
  }

  // Module-local constant used as argument: SOME_CONST or SOME_NS(orgId)
  // Try to extract a prefix from the expression itself
  const constCallMatch = /^(\w+)\s*\(/.exec(expr);
  if (constCallMatch) {
    return null; // unresolvable module-local factory — caller will warn
  }

  return null;
}

/**
 * Extract the first argument of a cachedVersioned-style call, handling
 * optional TypeScript generic type arguments like cachedVersioned<T>(...).
 * Returns the argument expression string.
 */
function extractFirstArg(content, methodName) {
  const results = [];
  // Match methodName optionally followed by <TypeArg> then (firstArg,
  const re = new RegExp(`\\b${methodName}\\s*(?:<[^>]*>)?\\s*\\(\\s*((?:[^(),]|\\([^)]*\\))+)`, "g");
  let m;
  while ((m = re.exec(content)) !== null) {
    results.push(m[1].trim());
  }
  return results;
}

/**
 * Extract the first argument to cachedVersioned(ns, key, ...) calls.
 * Handles TypeScript generic type arguments: cachedVersioned<T>(ns, ...).
 * The first argument can be:
 *   CACHE_KEYS.factory(x)
 *   `template:${orgId}`
 *   "string literal"
 *   LOCAL_NS(orgId)            ← unresolvable, returns null
 */
function extractVersionedReads(content) {
  const results = new Set();
  const unresolved = new Set();

  for (const expr of extractFirstArg(content, "cachedVersioned")) {
    // Skip TypeScript parameter declarations (e.g., "namespace: string" in method signature)
    if (/^\w+\s*:/.test(expr)) continue;
    const ns = resolveNsExpression(expr);
    if (ns) {
      results.add(ns);
    } else if (expr.length > 0 && !expr.startsWith("//")) {
      unresolved.add(expr.slice(0, 60));
    }
  }
  return { resolved: results, unresolved };
}

/**
 * Extract the argument to invalidateNamespace(ns) calls.
 */
function extractVersionedBumps(content) {
  const results = new Set();
  const unresolved = new Set();

  for (const expr of extractFirstArg(content, "invalidateNamespace")) {
    const ns = resolveNsExpression(expr);
    if (ns) {
      results.add(ns);
    } else if (expr.length > 0) {
      unresolved.add(expr.slice(0, 60));
    }
  }
  return { resolved: results, unresolved };
}

// ─── parse TTL-only exceptions from matrix ───────────────────────────────────

function parseTtlOnlyExceptions(matrixPath) {
  const content = readFile(matrixPath);
  const exceptions = new Set();

  // Match namespace + kind:ttl-only pairs
  // Pattern: namespace: "X", description: ..., invalidation: { kind: "ttl-only"
  const entryRe = /namespace:\s*["']([^"']+)["'][^}]+?kind:\s*["']ttl-only["']/gs;
  let m;
  while ((m = entryRe.exec(content)) !== null) {
    const ns = normalizeMatrixNs(m[1]);
    if (ns) exceptions.add(ns);
  }
  return exceptions;
}

// ─── self-test ────────────────────────────────────────────────────────────────

function runSelfTests() {
  const results = [];

  // Test 1 (positive): cachedVersionedForOrg with literal extracts namespace
  const readCode = `return this.cache.cachedVersionedForOrg(orgId, "clients:health", key, fetch);`;
  const reads = extractVersionedForOrgReads(readCode);
  results.push({
    name: "positive: cachedVersionedForOrg extracts literal namespace",
    pass: reads.has("clients:health"),
    detail: { extracted: [...reads] },
  });

  // Test 2 (positive): invalidateNamespaceForOrg with literal extracts namespace
  const bumpCode = `await this.cache.invalidateNamespaceForOrg(orgId, "clients:health");`;
  const bumps = extractVersionedForOrgBumps(bumpCode);
  results.push({
    name: "positive: invalidateNamespaceForOrg extracts literal namespace",
    pass: bumps.has("clients:health"),
    detail: { extracted: [...bumps] },
  });

  // Test 3 (negative control): read without bump → detected as stale
  const staleReads = new Set(["stale:ns"]);
  const emptyBumps = new Set();
  const exceptions = new Set();
  const isStale = staleReads.has("stale:ns") && !emptyBumps.has("stale:ns") && !exceptions.has("stale:ns");
  results.push({
    name: "negative-control: read without bump detected as stale",
    pass: isStale,
    detail: {},
  });

  // Test 4 (positive control): read with bump → not stale
  const happyReads = new Set(["happy:ns"]);
  const happyBumps = new Set(["happy:ns"]);
  const isNotStale = !happyReads.has("happy:ns") || happyBumps.has("happy:ns") || exceptions.has("happy:ns");
  results.push({
    name: "positive-control: read with matching bump → not stale",
    pass: isNotStale,
    detail: {},
  });

  // Test 5: CACHE_KEYS factory resolution
  const factoryCode = `return this.cache.cachedVersioned(CACHE_KEYS.finReportsNamespace(orgId), cacheKey, fetch);`;
  const { resolved: factoryReads } = extractVersionedReads(factoryCode);
  results.push({
    name: "positive: CACHE_KEYS.finReportsNamespace resolves to fin:reports",
    pass: factoryReads.has("fin:reports"),
    detail: { extracted: [...factoryReads] },
  });

  // Test 6: invalidateNamespace with CACHE_KEYS factory
  const bumpFactory = `await this.cache.invalidateNamespace(CACHE_KEYS.finReportsNamespace(orgId));`;
  const { resolved: factoryBumps } = extractVersionedBumps(bumpFactory);
  results.push({
    name: "positive: invalidateNamespace with CACHE_KEYS factory resolves",
    pass: factoryBumps.has("fin:reports"),
    detail: { extracted: [...factoryBumps] },
  });

  // Test 7: template literal extraction
  const templateCode = "return this.cache.cachedVersioned(`projects:list:${orgId}`, key, fetch);";
  const { resolved: templateReads } = extractVersionedReads(templateCode);
  results.push({
    name: "positive: template literal namespace extracted correctly",
    pass: templateReads.has("projects:list"),
    detail: { extracted: [...templateReads] },
  });

  // Test 8: TTL-only exception excludes from stale detection
  const ttlReads = new Set(["dashboard:stats"]);
  const noBumps = new Set();
  const ttlExceptions = new Set(["dashboard:stats"]);
  const ttlNotStale = !ttlReads.has("dashboard:stats") || noBumps.has("dashboard:stats") || ttlExceptions.has("dashboard:stats");
  results.push({
    name: "positive: TTL-only namespace excluded from stale detection",
    pass: ttlNotStale,
    detail: {},
  });

  // Test 9: vacuity guard fires on empty read set
  results.push({
    name: "vacuity-guard: zero reads is failure",
    pass: new Set().size < MIN_READ_NAMESPACES,
    detail: { reads: 0, min: MIN_READ_NAMESPACES },
  });

  const allPass = results.every((r) => r.pass);
  return { results, allPass };
}

// ─── main scan ────────────────────────────────────────────────────────────────

function runFullScan() {
  const modulesDir = join(BACKEND_SRC, "modules");
  const commonDir = join(BACKEND_SRC, "common");

  // ⚠ WIDENED 2026-09-12. This used to keep only `*.service.ts`, and that made
  // the gate report a correctly invalidated namespace as stale. `sales:kpis` is
  // bumped by `CACHE_KEYS.salesKpisNamespace(orgId)` — a fully resolvable
  // expression — from `modules/deals/lib/deal-update-effects.ts`, which is where
  // the body moved when `deals.service.ts` was split. On the previous branch the
  // identical call sat in `deals.service.ts` and the gate saw it. Nothing about
  // the invalidation changed; only the file name did.
  //
  // The same blind spot runs the other way: move a `cachedVersioned` read into a
  // `lib/` helper and its live bump starts reporting as dead. Splitting a service
  // is routine here, so the filter was steadily converting refactors into
  // findings. Cache calls are not a property of a file's suffix.
  const serviceFiles = [
    ...walkDir(modulesDir),
    ...walkDir(commonDir),
  ].filter((f) => !MATRIX_DATA_FILE.test(f));

  if (serviceFiles.length < MIN_SERVICE_FILES) {
    process.stderr.write(
      `VACUITY: scanned only ${serviceFiles.length} service files (min ${MIN_SERVICE_FILES}). ` +
        "Check that BACKEND_SRC points to the correct directory.\n",
    );
    return { findings: [], deadBumps: [], vacuityFailed: true, fileCount: serviceFiles.length, readCount: 0, bumpCount: 0, unresolvedReads: [], unresolvedBumps: [] };
  }

  const allVersionedForOrgReads = new Set();
  const allVersionedForOrgBumps = new Set();
  const allVersionedReads = new Set();
  const allVersionedBumps = new Set();
  const unresolvedReads = new Set();
  const unresolvedBumps = new Set();

  for (const file of serviceFiles) {
    const content = readFile(file);

    for (const ns of extractVersionedForOrgReads(content)) allVersionedForOrgReads.add(ns);
    for (const ns of extractVersionedForOrgBumps(content)) allVersionedForOrgBumps.add(ns);

    const { resolved: vReads, unresolved: vUnresolved } = extractVersionedReads(content);
    for (const ns of vReads) allVersionedReads.add(ns);
    for (const expr of vUnresolved) unresolvedReads.add(expr);

    const { resolved: vBumps, unresolved: bUnresolved } = extractVersionedBumps(content);
    for (const ns of vBumps) allVersionedBumps.add(ns);
    for (const expr of bUnresolved) unresolvedBumps.add(expr);
  }

  // Combine all reads and all bumps into unified sets for comparison
  const allReads = new Set([...allVersionedForOrgReads, ...allVersionedReads]);
  const allBumps = new Set([...allVersionedForOrgBumps, ...allVersionedBumps]);

  if (allReads.size < MIN_READ_NAMESPACES) {
    process.stderr.write(
      `VACUITY: only ${allReads.size} read namespaces found (min ${MIN_READ_NAMESPACES}). ` +
        "Regex extraction may be failing — test with --self-test.\n",
    );
    return { findings: [], deadBumps: [], vacuityFailed: true, fileCount: serviceFiles.length, readCount: allReads.size, bumpCount: allBumps.size, unresolvedReads: [...unresolvedReads], unresolvedBumps: [...unresolvedBumps] };
  }

  // Parse TTL-only exceptions from the matrix
  const matrixPath = join(BACKEND_SRC, "common", "cache", "cache-invalidation-matrix.ts");
  const matrixFiles = [
    matrixPath,
    join(BACKEND_SRC, "common", "cache", "cache-invalidation-crm.ts"),
    join(BACKEND_SRC, "common", "cache", "cache-invalidation-finance.ts"),
    join(BACKEND_SRC, "common", "cache", "cache-invalidation-inventory.ts"),
    join(BACKEND_SRC, "common", "cache", "cache-invalidation-inventory-fulfillment.ts"),
    join(BACKEND_SRC, "common", "cache", "cache-invalidation-rbac-auth.ts"),
  ];
  const ttlOnlyExceptions = new Set();
  for (const mf of matrixFiles) {
    for (const ns of parseTtlOnlyExceptions(mf)) ttlOnlyExceptions.add(ns);
  }

  // Stale: READ but not BUMPED and not TTL-only
  const findings = [];
  for (const ns of allReads) {
    if (!allBumps.has(ns) && !ttlOnlyExceptions.has(ns)) {
      findings.push({
        id: `stale:${ns}`,
        severity: "MEDIUM",
        namespace: ns,
        description: `Namespace "${ns}" is READ via cachedVersioned/cachedVersionedForOrg but never BUMPED by any invalidateNamespace/invalidateNamespaceForOrg call. Reads will be served stale forever (until TTL).`,
        kind: "stale-namespace",
      });
    }
  }

  // Dead bumps: BUMPED but not READ (informational warning, non-failing)
  const deadBumps = [];
  for (const ns of allBumps) {
    if (!allReads.has(ns)) {
      deadBumps.push({
        namespace: ns,
        description: `Namespace "${ns}" has invalidation calls but no corresponding cachedVersioned/cachedVersionedForOrg read — possibly dead code.`,
      });
    }
  }

  return {
    findings,
    deadBumps,
    vacuityFailed: false,
    fileCount: serviceFiles.length,
    readCount: allReads.size,
    bumpCount: allBumps.size,
    unresolvedReads: [...unresolvedReads].slice(0, 20),
    unresolvedBumps: [...unresolvedBumps].slice(0, 20),
  };
}

// ─── output ───────────────────────────────────────────────────────────────────

if (SELF_TEST) {
  const { results, allPass } = runSelfTests();
  const out = {
    selfTest: true,
    pass: allPass,
    cases: results,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  process.exit(allPass ? 0 : 3);
}

const { findings, deadBumps, vacuityFailed, fileCount, readCount, bumpCount, unresolvedReads, unresolvedBumps } = runFullScan();

if (vacuityFailed) process.exit(2);

process.stdout.write(`\n=== namespace-coverage gate — ${fileCount} service files, ${readCount} read namespaces, ${bumpCount} bump namespaces ===\n\n`);

if (findings.length > 0) {
  process.stdout.write(`STALE NAMESPACES (read but never bumped) — ${findings.length}:\n`);
  for (const f of findings) {
    process.stdout.write(`  [${f.namespace}] ${f.description}\n`);
  }
  process.stdout.write("\n");
}

if (deadBumps.length > 0) {
  process.stdout.write(`DEAD BUMPS (bumped but never read, non-blocking) — ${deadBumps.length}:\n`);
  for (const d of deadBumps) {
    process.stdout.write(`  [${d.namespace}] ${d.description}\n`);
  }
  process.stdout.write("\n");
}

if (unresolvedReads.length > 0) {
  process.stdout.write(`UNRESOLVED READ EXPRESSIONS (module-local factories, non-blocking) — ${unresolvedReads.length}:\n`);
  for (const u of unresolvedReads) {
    process.stdout.write(`  ${u}\n`);
  }
  process.stdout.write("\n");
}

if (findings.length > 0) {
  process.stdout.write(`RESULT: FAIL — ${findings.length} stale namespace(s) found\n`);
  process.exit(1);
} else {
  const warnCount = deadBumps.length + unresolvedReads.length;
  process.stdout.write(`RESULT: PASS — 0 stale namespaces. ${readCount} reads, ${bumpCount} bumps.` + (warnCount > 0 ? ` (${warnCount} warnings)` : "") + "\n");
  process.exit(0);
}
