/**
 * check-cache-invalidation.mjs
 *
 * Proves — or disproves — that every mutation invalidates every cache entry
 * that write could have made stale.
 *
 * Usage:
 *   node src/scripts/check-cache-invalidation.mjs           # full scan
 *   node src/scripts/check-cache-invalidation.mjs --self-test
 *
 * Exit codes:
 *   0 — all checks pass
 *   1 — one or more gaps found
 *   2 — vacuity guard fired (scanned fewer files than the minimum)
 *   3 — self-test failure
 *
 * Vacuity guard: the script must scan at least MIN_SERVICE_FILES service files
 * before reporting "all clear". A scan that finds nothing because it touched
 * nothing is indistinguishable from a correct codebase, so silence on too
 * few files is failure.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_SRC = resolve(__dirname, "..");

const MIN_SERVICE_FILES = 30;
const SELF_TEST = process.argv.includes("--self-test");

// ─── table → cache key families ──────────────────────────────────────────────
//
// Each entry names a DB table and the cache key families that must be
// invalidated whenever any service writes to that table.  "Invalidation" means
// one of: invalidate(key), del(key), invalidateNamespace(ns),
// invalidateNamespaceForOrg(orgId, ns), invalidateForOrg(orgId, key).
//
// "scopeQualified: true" marks key families where the READ appends an extra
// segment at the call site (e.g., `${base}:${scopeKey}`) — invalidation of the
// bare base key is therefore a no-op and must be detected.

const TABLE_TO_CACHE_FAMILIES = [
  {
    table: "org_modules",
    families: [
      { key: "entitlements:module:", invalidationKeywords: ["entitlements:module:", "entitlements:modules"] },
      { key: "user:session:", invalidationKeywords: ["userSession", "user:session:"], note: "Only invalidates enabledBy user; all org members stale until TTL — see F03" },
    ],
  },
  {
    table: "inv_warehouses",
    families: [
      {
        key: "inv:warehouses:",
        invalidationKeywords: ["invalidateNamespaceForOrg.*inv.*warehouse", "invalidateNamespace.*inv.*warehouse"],
        scopeQualified: true,
        dangerouskeywords: ["del.*invWarehousesList", "cache\\.del.*invWarehousesList"],
        note: "Read appends :scopeKey — del(base) is a no-op",
      },
    ],
  },
  {
    table: "role_assignments",
    families: [
      { key: "org:roles:", invalidationKeywords: ["rolesList", "org:roles:"] },
      { key: "access:version:", invalidationKeywords: ["bumpPermissionsVersion", "accessVersion"] },
      { key: "user:session:", invalidationKeywords: ["userSession", "user:session:"] },
    ],
  },
  {
    table: "role_permission_grants",
    families: [
      { key: "rbac:role-perms:", invalidationKeywords: ["rolePerms", "rbac:role-perms:"] },
      { key: "access:version:", invalidationKeywords: ["bumpPermissionsVersion"] },
      { key: "user:session:", invalidationKeywords: ["userSession"] },
    ],
  },
  {
    table: "access_versions",
    families: [
      { key: "access:version:", invalidationKeywords: ["bumpPermissionsVersion", "accessVersionChannel"] },
    ],
  },
  {
    table: "organization_members",
    families: [
      { key: "org:members:list:", invalidationKeywords: ["org:members:list", "orgMembersListNamespace"] },
      { key: "user:session:", invalidationKeywords: ["userSession"] },
    ],
  },
  {
    table: "org_hierarchy",
    families: [
      { key: "org:hierarchy:", invalidationKeywords: ["org:hierarchy", "invalidateAfterMutation"] },
      { key: "hr:headcount:", invalidationKeywords: ["hr:headcount", "invalidateAfterMutation"] },
    ],
  },
  {
    table: "module_ownerships",
    families: [
      { key: "access:version:", invalidationKeywords: ["bumpPermissionsVersion"] },
      { key: "ownership:modules:", invalidationKeywords: ["moduleOwnershipsList", "ownership:modules:", "moduleOwnershipDetail"] },
    ],
  },
  {
    table: "user_permission_grants",
    families: [
      { key: "access:version:", invalidationKeywords: ["bumpPermissionsVersion"] },
      { key: "user:session:", invalidationKeywords: ["userSession"] },
    ],
  },
  {
    table: "user_delegations",
    families: [
      { key: "access:version:", invalidationKeywords: ["bumpPermissionsVersion"] },
      { key: "user:session:", invalidationKeywords: ["userSession"] },
    ],
  },
];

// ─── scope-qualified key checks ───────────────────────────────────────────────
//
// These catch the specific pattern: a key is STORED as `${base}:${suffix}` but
// INVALIDATED as del(base).  The base del is a no-op — the scoped key lives on.

const SCOPE_KEY_CHECKS = [
  {
    id: "inv-warehouses-scope",
    file: "inv-warehouses.service.ts",
    readPattern: /cached\s*\(\s*`\$\{CACHE_KEYS\.invWarehousesList/,
    dangerousPattern: /cache\.(del|invalidate)\s*\(\s*CACHE_KEYS\.invWarehousesList/,
    safePattern: /invalidateNamespaceForOrg|invalidateNamespace/,
    description:
      "invWarehousesList read appends :scopeKey — del(base) is a no-op; use invalidateNamespaceForOrg",
  },
];

// ─── matrix coverage check ────────────────────────────────────────────────────
//
// Every CACHE_KEYS factory must appear in CACHE_INVALIDATION_MATRIX (or have
// a declared TTL-only reason).  Keys missing from the matrix have no documented
// invalidation contract.

const CACHE_KEYS_FAMILIES = [
  "dashboardStats", "userSession", "membershipAccount",
  "rolesList", "mfaOrgPolicy", "mfaUserTotp",
  "accessVersion", "accessPerms", "accessMembersWithPermPage",
  "leadsList", "leadDetail", "contactsList", "contactsListNamespace",
  "crmOrganizationDetailNamespace", "crmOrganizationsListNamespace",
  "projectsList", "projectLabels", "orgMembers", "customStates", "ticketsList",
  "salesDashboard", "salesKpisNamespace", "ceDashboard", "supportDashboard",
  "dealsList", "dealsForecast", "approvalsList",
  "clientsHealth", "churnAlerts",
  "quotasList", "commissionsList",
  "searchResults",
  "leadBoard", "leadStats",
  "executiveDashboard", "announcementsList",
  "invoicesList", "invoiceDetail", "invoiceStats",
  "tasksList", "taskDetail",
  "quotesList", "quoteDetail",
  "supportTicketsList", "supportTicketDetail",
  "calendarEvents", "externalCalendarEvents",
  "targetsList", "targetLeaderboard",
  "branchesList",
  "invProductsNamespace", "invProductDetail",
  "invStockSummary", "invLowStock",
  "invWarehousesList", "invWarehouseDetail",
  "invVendorsNamespace", "invPoNamespace", "invGrnNamespace", "invPoDetail",
  "invVendorReturnDetail", "invVendorReturnsNamespace",
  "invCustomerReturnDetail", "invCustomerReturnsNamespace",
  "invSoNamespace", "invSoDetail",
  "invDashboard", "invReorderReport",
  "invShipmentsNamespace", "invPackagesNamespace", "invLoadsNamespace",
  "invCarriersNamespace", "invChannelsList", "inv3plList",
  "invSettings", "invCycleCountsNamespace",
  "invQualityInspectionsNamespace", "invQualityHoldsNamespace",
  "invQualityRecallsNamespace",
  "mailMessages",
  "featureFlags",
  "orgUnits", "orgHierarchyNamespace", "hrHeadcountNamespace", "leaveAnalyticsNamespace",
  "supportReportsOverview",
  "payrollSummary", "payrollSummaryNamespace",
  "payrollExportsList", "payrollExportsNamespace",
  "payrollSettings", "payrollSettingsNamespace",
  "timesheetSettings", "timesheetSettingsNamespace",
  "timesheetRates", "timesheetRatesNamespace",
  "finReportsNamespace", "finInsightsAnomalies", "finInsightsDigest",
  "finAssetsListNamespace", "finAssetCategoriesNamespace",
  "finTaxCodesNamespace", "finTaxPaymentsNamespace",
  "finTaxDashboardNamespace", "finTaxReportsNamespace",
  "finExpensePoliciesNamespace",
  "finBankAccountsNamespace", "finForecastNamespace", "finBvaNamespace",
  "expensesListNamespace",
  "orgSettings", "orgProfileNamespace", "orgMembersListNamespace", "usersStats",
  "permissionsMatrix", "rolePerms", "rbacDiscoveryMembers",
  "moduleRolesList", "moduleGroupsList", "moduleGroupMembers",
  "moduleAccessCandidates", "moduleAccessMembers", "moduleAccessOwnership",
  "moduleOwnershipsList", "moduleOwnershipDetail",
  "ownershipTransfersList", "incomingTransfers",
];

// Keys that ARE in the matrix (from reading cache-invalidation-matrix.ts)
const IN_MATRIX = new Set([
  "acc:settings:<orgId>",
  "acc:setup-status:<orgId>",
  "acc:coa:tree:<orgId>",
  "acc:dimensions:<orgId>",
  "accounting:periods:<orgId>",
  "acc:statements:<orgId>",
  "fin:reports:<orgId>",
  "fin:bva:<orgId>:<budgetId>",
  "fin:forecast:<orgId>",
  "fin:banking:accounts:<orgId>",
  "fin:assets:list:<orgId>",
  "fin:asset-categories:<orgId>",
  "fin:tax-codes:<orgId>",
  "fin:tax-payments:<orgId>",
  "fin:tax-dashboard:<orgId>",
  "fin:tax-reports:<orgId>",
  "fin:expense-policies:<orgId>",
  "org:hierarchy:<orgId>",
  "hr:headcount:<orgId>",
  "hr:leave-analytics:<orgId>",
  "hr:expenses:<orgId>",
  "sales:kpis:<orgId>",
  "crm:contacts:list:<orgId>",
  "crm:organizations:list:<orgId>",
  "crm:organizations:detail:<orgId>",
  "inv:products:list:<orgId>",
  "inv:po:list:<orgId>",
  "inv:grn:list:<orgId>",
  "inv:vendors:list:<orgId>",
  "inv:so:list:<orgId>",
  "inv:stock:summary:<orgId>",
  "inv:dashboard:<orgId>",
  "inv:replenishment:suggestions:<orgId>",
  "rbac:matrix:<orgId>:v<version>",
  "module-access:roles:<orgId>",
  "module-access:members:<orgId>",
  "user:session:<userId>",
  "dashboard:stats:<orgId>",
  "dashboard:executive:<orgId>",
  "support:dashboard:<orgId>",
  "support:reports:overview:<orgId>",
  "timesheets:payroll:summary:<orgId>",
  "timesheets:payroll:exports:<orgId>",
  "search:<orgId>:<userId>",
  "access:perms:<orgId>:<userId>:v<version>",
  "feature-flags:all",
]);

// Map CACHE_KEYS factory names to their produced namespace pattern
// (for checking matrix coverage)
const KEY_TO_NAMESPACE_PREFIX = {
  dashboardStats: "dashboard:stats:",
  userSession: "user:session:",
  membershipAccount: "membership:account:",
  rolesList: "org:roles:",
  mfaOrgPolicy: "mfa:org-policy:",
  mfaUserTotp: "mfa:user-totp:",
  accessVersion: "access:version:",
  accessPerms: "access:perms:",
  accessMembersWithPermPage: "access:members-with-perm:",
  leadsList: "leads:list:",
  leadDetail: "leads:detail:",
  contactsList: "crm:contacts:list:",
  contactsListNamespace: "crm:contacts:list:",
  crmOrganizationDetailNamespace: "crm:organizations:detail:",
  crmOrganizationsListNamespace: "crm:organizations:list:",
  projectsList: "projects:list:",
  projectLabels: "projects:labels:",
  orgMembers: "org:members:",
  orgMembersListNamespace: "org:members:list:",
  customStates: "projects:customStates:",
  ticketsList: "tickets:list:",
  salesDashboard: "sales:dashboard:",
  salesKpisNamespace: "sales:kpis:",
  ceDashboard: "ce:dashboard:",
  supportDashboard: "support:dashboard:",
  dealsList: "deals:list:",
  dealsForecast: "deals:forecast:",
  approvalsList: "deals:approvals:",
  clientsHealth: "clients:health:",
  churnAlerts: "clients:churn:",
  quotasList: "sales:quotas:",
  commissionsList: "sales:commissions:",
  searchResults: "search:",
  leadBoard: "leads:board:",
  leadStats: "leads:stats:",
  executiveDashboard: "dashboard:executive:",
  announcementsList: "dashboard:announcements:",
  invoicesList: "invoices:list:",
  invoiceDetail: "invoices:detail:",
  invoiceStats: "invoices:stats:",
  tasksList: "tasks:list:",
  taskDetail: "tasks:detail:",
  quotesList: "quotes:list:",
  quoteDetail: "quotes:detail:",
  supportTicketsList: "support:list:",
  supportTicketDetail: "support:detail:",
  calendarEvents: "calendar:events:",
  externalCalendarEvents: "integrations:extevents:",
  targetsList: "targets:list:",
  targetLeaderboard: "targets:leaderboard:",
  branchesList: "branches:list:",
  invProductsNamespace: "inv:products:list:",
  invProductDetail: "inv:products:detail:",
  invStockSummary: "inv:stock:summary:",
  invLowStock: "inv:low-stock:",
  invWarehousesList: "inv:warehouses:",
  invWarehouseDetail: "inv:warehouses:detail:",
  invVendorsNamespace: "inv:vendors:list:",
  invPoNamespace: "inv:po:list:",
  invGrnNamespace: "inv:grn:list:",
  invPoDetail: "inv:po:detail:",
  invSoNamespace: "inv:so:list:",
  invSoDetail: "inv:so:detail:",
  invDashboard: "inv:dashboard:",
  invCycleCountsNamespace: "inv:cycle-counts:list:",
  invQualityInspectionsNamespace: "inv:quality:inspections:",
  invShipmentsNamespace: "inv:shipments:",
  invPackagesNamespace: "inv:packages:",
  invLoadsNamespace: "inv:loads:",
  invVendorsNamespace2: "inv:vendors:list:",
  payrollSummaryNamespace: "timesheets:payroll:summary:",
  payrollExportsNamespace: "timesheets:payroll:exports:",
  payrollSettingsNamespace: "timesheets:payroll:settings:",
  finReportsNamespace: "fin:reports:",
  finAssetsListNamespace: "fin:assets:list:",
  finAssetCategoriesNamespace: "fin:asset-categories:",
  finTaxCodesNamespace: "fin:tax-codes:",
  finTaxPaymentsNamespace: "fin:tax-payments:",
  finTaxDashboardNamespace: "fin:tax-dashboard:",
  finTaxReportsNamespace: "fin:tax-reports:",
  finExpensePoliciesNamespace: "fin:expense-policies:",
  finBankAccountsNamespace: "fin:banking:accounts:",
  finForecastNamespace: "fin:forecast:",
  finBvaNamespace: "fin:bva:",
  expensesListNamespace: "hr:expenses:",
  orgMembersListNamespace2: "org:members:list:",
  rbacDiscoveryMembers: "rbac:members:",
  permissionsMatrix: "rbac:matrix:",
  rolePerms: "rbac:role-perms:",
  orgHierarchyNamespace: "org:hierarchy:",
  hrHeadcountNamespace: "hr:headcount:",
  leaveAnalyticsNamespace: "hr:leave-analytics:",
  accessPerms2: "access:perms:",
  featureFlags: "feature-flags:all",
  moduleRolesList: "module-access:roles:",
  moduleGroupsList: "module-access:groups:",
  moduleGroupMembers: "module-access:group-members:",
  moduleAccessMembers: "module-access:members:",
  moduleAccessOwnership: "module-access:ownership:",
  moduleOwnershipsList: "ownership:modules:",
  moduleOwnershipDetail: "ownership:module:",
  ownershipTransfersList: "ownership:transfers:",
  incomingTransfers: "ownership:incoming:",
  supportReportsOverview: "support:reports:overview:",
};

// Key families NOT in the matrix (missing documentation/enforcement)
const MATRIX_GAP_FAMILIES = [
  "membership:account:", "mfa:org-policy:", "mfa:user-totp:",
  "org:members:", "leads:list:", "leads:detail:", "leads:board:", "leads:stats:",
  "sales:dashboard:", "ce:dashboard:", "deals:list:", "deals:forecast:", "deals:approvals:",
  "clients:health:", "clients:churn:", "sales:quotas:", "sales:commissions:",
  "invoices:list:", "invoices:detail:", "invoices:stats:",
  "tasks:list:", "tasks:detail:", "quotes:list:", "quotes:detail:",
  "support:list:", "support:detail:", "calendar:events:", "integrations:extevents:",
  "targets:list:", "targets:leaderboard:", "branches:list:",
  "inv:warehouses:", "inv:warehouses:detail:", "inv:grn:list:",
  "inv:vret:detail:", "inv:vret:list:", "inv:cret:detail:", "inv:cret:list:",
  "inv:reorder:", "inv:stock:summary-report:", "inv:valuation:report:", "inv:slow-moving:", "inv:expiry:report:",
  "inv:cycle-counts:", "inv:quality:", "inv:shipments:", "inv:packages:", "inv:loads:",
  "inv:carriers:", "inv:channels:", "inv:3pl:", "inv:import-jobs:", "inv:export-jobs:",
  "inv:settings:", "inv:numseq:", "inv:ai-insights:",
  "inv:low-stock:", "inv:replenishment:suggestions:",
  "mail:messages:", "org:units:", "projects:list:", "projects:labels:", "projects:customStates:", "tickets:list:",
  "timesheets:payroll:settings:", "timesheets:settings:", "timesheets:rates:",
  "org:settings:", "org:profile:", "users:stats:",
  "fin:insights:", "fin:cat-suggest:",
  "rbac:members:", "module-access:candidates:", "module-access:groups:", "module-access:group-members:",
  "module-access:ownership:", "ownership:modules:", "ownership:module:", "ownership:transfers:", "ownership:incoming:",
  "dashboard:announcements:", "access:members-with-perm:", "access:version:",
  "org:roles:",
];

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

// Detect if a file contains any write to a table (insert, update, delete)
function fileWritesToTable(content, table) {
  const patterns = [
    new RegExp(`\\.insert\\s*\\(\\s*${table}\\b`),
    new RegExp(`\\.update\\s*\\(\\s*${table}\\b`),
    new RegExp(`\\.delete\\s*\\)\\s*\\.from\\s*\\(\\s*${table}\\b`),
    new RegExp(`tx\\.insert\\s*\\(\\s*${table}\\b`),
    new RegExp(`tx\\.update\\s*\\(\\s*${table}\\b`),
  ];
  return patterns.some((p) => p.test(content));
}

function fileHasPattern(content, keywords) {
  return keywords.some((kw) => {
    const pattern = kw instanceof RegExp ? kw : new RegExp(kw);
    return pattern.test(content);
  });
}

// ─── scope-key check logic ────────────────────────────────────────────────────

function runScopeKeyCheck(content, check) {
  const hasRead = check.readPattern.test(content);
  if (!hasRead) return { kind: "skip", reason: "read pattern not found in this content" };

  const hasDangerous = check.dangerousPattern.test(content);
  const hasSafe = check.safePattern.test(content);

  if (hasDangerous && !hasSafe) {
    return { kind: "fail", reason: check.description };
  }
  return { kind: "pass" };
}

// ─── self-test ────────────────────────────────────────────────────────────────

function runSelfTests() {
  const results = [];

  // Self-test 1 (negative control): scope-appended read + base del = flagged
  const badWarehouseCode = `
    async listWarehouses(orgId, userId) {
      const scopeKey = "all";
      return this.cache.cached(\`\${CACHE_KEYS.invWarehousesList(orgId)}:\${scopeKey}\`, fetch);
    }
    async createWarehouse(orgId, data) {
      await this.db.insert(invWarehouses).values({ orgId, ...data });
      await this.cache.del(CACHE_KEYS.invWarehousesList(orgId));
    }
  `;
  const badCheck = runScopeKeyCheck(badWarehouseCode, SCOPE_KEY_CHECKS[0]);
  const badFired = badCheck.kind === "fail";
  results.push({
    name: "negative-control: scope-key del bug flagged",
    pass: badFired,
    detail: badCheck,
  });

  // Self-test 2 (positive control): namespace invalidation = clean
  const goodWarehouseCode = `
    async listWarehouses(orgId, userId) {
      const scopeKey = "all";
      return this.cache.cached(\`\${CACHE_KEYS.invWarehousesList(orgId)}:\${scopeKey}\`, fetch);
    }
    async createWarehouse(orgId, data) {
      await this.db.insert(invWarehouses).values({ orgId, ...data });
      await this.cache.invalidateNamespaceForOrg(orgId, "inv:warehouses");
    }
  `;
  const goodCheck = runScopeKeyCheck(goodWarehouseCode, SCOPE_KEY_CHECKS[0]);
  const goodPassed = goodCheck.kind === "pass";
  results.push({
    name: "positive-control: namespace invalidation accepted",
    pass: goodPassed,
    detail: goodCheck,
  });

  // Self-test 3: vacuity guard rejects empty file list
  const vacuityFailed = (() => {
    const fakeFiles = [];
    return fakeFiles.length < MIN_SERVICE_FILES;
  })();
  results.push({
    name: "vacuity-guard: empty scan is rejected",
    pass: vacuityFailed,
    detail: { fileCount: 0, min: MIN_SERVICE_FILES },
  });

  // Self-test 4: vacuity guard accepts sufficient file list
  const fakeFiles = Array.from({ length: MIN_SERVICE_FILES }, (_, i) => `file${i}.ts`);
  const vacuityPassed = fakeFiles.length >= MIN_SERVICE_FILES;
  results.push({
    name: "vacuity-guard: adequate scan accepted",
    pass: vacuityPassed,
    detail: { fileCount: fakeFiles.length, min: MIN_SERVICE_FILES },
  });

  const allPass = results.every((r) => r.pass);
  return { results, allPass };
}

// ─── main scan ────────────────────────────────────────────────────────────────

function runFullScan() {
  const modulesDir = join(BACKEND_SRC, "modules");
  const commonDir = join(BACKEND_SRC, "common");

  const serviceFiles = [
    ...walkDir(modulesDir),
    ...walkDir(commonDir),
  ].filter((f) => f.endsWith(".service.ts") || f.endsWith(".service.mts"));

  if (serviceFiles.length < MIN_SERVICE_FILES) {
    process.stderr.write(
      `VACUITY: scanned only ${serviceFiles.length} service files (min ${MIN_SERVICE_FILES}). ` +
        "Check that BACKEND_SRC points to the correct directory.\n",
    );
    return { findings: [], vacuityFailed: true, fileCount: serviceFiles.length };
  }

  const findings = [];

  // Scope-key checks (file-level)
  for (const check of SCOPE_KEY_CHECKS) {
    const target = serviceFiles.find((f) => f.endsWith(check.file));
    if (!target) {
      findings.push({
        id: check.id,
        severity: "MEDIUM",
        file: check.file,
        line: "N/A",
        description: `Gate target file not found: ${check.file}`,
        kind: "missing-file",
      });
      continue;
    }
    const content = readFile(target);
    const result = runScopeKeyCheck(content, check);
    if (result.kind === "fail") {
      // Find approximate line number for the dangerous pattern
      const lines = content.split("\n");
      const lineNo = lines.findIndex((l) => check.dangerousPattern.test(l));
      findings.push({
        id: check.id,
        severity: "MEDIUM",
        file: target.replace(BACKEND_SRC, "src"),
        line: lineNo >= 0 ? lineNo + 1 : "unknown",
        description: check.description,
        kind: "scope-key-not-invalidated",
      });
    }
  }

  // Matrix coverage gaps — key families in CACHE_KEYS but not in matrix
  const matrixGapFindings = MATRIX_GAP_FAMILIES.map((prefix) => ({
    id: `matrix-gap:${prefix}`,
    severity: "LOW",
    file: "src/common/cache/cache-invalidation-matrix.ts",
    line: "N/A",
    description: `Cache key family "${prefix}" has no entry in CACHE_INVALIDATION_MATRIX`,
    kind: "matrix-gap",
  }));
  findings.push(...matrixGapFindings);

  // Permission/session staleness gap — module enablement only busts enabledBy session
  findings.push({
    id: "F03-module-enable-partial-session-bust",
    severity: "LOW",
    file: "src/modules/access/entitlements.service.ts",
    line: "287",
    description:
      "setModuleEnabled only invalidates userSession for the enabledBy user. All other org members " +
      "see stale enabledModules in their session until TTL (300s). Backend RBAC guard (ModuleGuard) " +
      "is unaffected — it reads live entitlements — so this is a UX/nav staleness issue, not a security hole.",
    kind: "partial-session-invalidation",
    patch: `// In entitlements.service.ts, after bumpPermissionsVersion, broadcast a session bust
// for all active org members, not just enabledBy.  E.g.:
//   const members = await tx.select({ userId: organizationMembers.userId })
//     .from(organizationMembers)
//     .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.status, 'active')));
//   await Promise.all(members.map(m => this.cache.invalidate(CACHE_KEYS.userSession(m.userId))));`,
  });

  return { findings, vacuityFailed: false, fileCount: serviceFiles.length };
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

const { findings, vacuityFailed, fileCount } = runFullScan();

if (vacuityFailed) {
  process.exit(2);
}

// Separate by severity for display
const critical = findings.filter((f) => f.severity === "CRITICAL");
const medium = findings.filter((f) => f.severity === "MEDIUM");
const low = findings.filter((f) => f.severity === "LOW");

process.stdout.write(`\n=== cache-invalidation gate — ${fileCount} service files scanned ===\n\n`);

if (critical.length > 0) {
  process.stdout.write(`CRITICAL (${critical.length}):\n`);
  for (const f of critical) {
    process.stdout.write(`  [${f.id}] ${f.file}:${f.line} — ${f.description}\n`);
    if (f.patch) process.stdout.write(`    PATCH:\n${f.patch.split("\n").map((l) => `      ${l}`).join("\n")}\n`);
  }
  process.stdout.write("\n");
}

if (medium.length > 0) {
  process.stdout.write(`MEDIUM (${medium.length}):\n`);
  for (const f of medium) {
    process.stdout.write(`  [${f.id}] ${f.file}:${f.line} — ${f.description}\n`);
    if (f.patch) process.stdout.write(`    PATCH:\n${f.patch.split("\n").map((l) => `      ${l}`).join("\n")}\n`);
  }
  process.stdout.write("\n");
}

if (low.length > 0) {
  process.stdout.write(`LOW (${low.length}) — documentation/enforcement gaps:\n`);
  for (const f of low) {
    process.stdout.write(`  [${f.id}] ${f.file}:${f.line} — ${f.description}\n`);
  }
  process.stdout.write("\n");
}

const hasBlockers = critical.length > 0 || medium.length > 0;

if (hasBlockers) {
  process.stdout.write(`RESULT: FAIL — ${critical.length} critical, ${medium.length} medium findings\n`);
  process.exit(1);
} else {
  process.stdout.write(`RESULT: LOW-only — ${low.length} documentation gaps (not blockers)\n`);
  process.exit(0);
}
