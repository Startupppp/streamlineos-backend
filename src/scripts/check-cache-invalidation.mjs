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

import {
  findFalsePrefixDeletes,
  findNamespaceCounterMismatches,
  parseCacheKeyFactories,
  resolveAllSites,
  resolveFileSites,
  segmentPrefix,
} from "./check-cache-key-shapes.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_SRC = resolve(__dirname, "..");

const MIN_SERVICE_FILES = 30;
const MIN_WRITE_SITES = 100;
const MIN_INVALIDATE_SITES = 200;
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
      { key: "user:session:", invalidationKeywords: ["userSession", "user:session:"], note: "Every ACTIVE member's session carries enabledModules — see F03/F03b" },
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
    // The Drizzle object is `orgUnits` (`org_units`); there has never been an
    // `org_hierarchy` table, which is why this row matched nothing.
    table: "org_units",
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

// ─── missing-invalidation checks (cross-file) ─────────────────────────────────
//
// These catch families where the READ is scope-qualified (extra discriminators
// appended) AND no invalidation of any kind exists across all service files.
// A base-key del would be a no-op, so only namespace-invalidation is safe.

const MISSING_INVALIDATION_CHECKS = [
  {
    id: "clients-health-no-invalidation",
    severity: "MEDIUM",
    targetFile: "clients.service.ts",
    readPattern: /cachedVersionedForOrg\s*\([^)]*"clients:health"/,
    invalidationPatterns: [
      /invalidateNamespace.*clients.health/i,
      /invalidateNamespaceForOrg.*clients.health/i,
      /invalidate.*["']clients:health["']/,
    ],
    line: "50",
    description:
      "clients:health read (cachedVersionedForOrg) appends :userId:scope:status:limit discriminators making the composite key unaddressable by a base-key del; no namespace invalidation found across all service files — stale client health data served until TTL",
  },
  {
    id: "clients-churn-no-invalidation",
    severity: "MEDIUM",
    targetFile: "clients.service.ts",
    readPattern: /cachedVersionedForOrg\s*\([^)]*"clients:churn"/,
    invalidationPatterns: [
      /invalidateNamespace.*clients.churn/i,
      /invalidateNamespaceForOrg.*clients.churn/i,
      /invalidate.*["']clients:churn["']/,
    ],
    line: "100",
    description:
      "clients:churn read (cachedVersionedForOrg) appends :userId:scope discriminators; no namespace invalidation found across all service files — stale churn data served until TTL",
  },
];

// ─── key-mismatch checks ──────────────────────────────────────────────────────
//
// These catch families where a READ uses cache.cached(CACHE_KEYS.factory(orgId))
// producing key "prefix:orgId" while the WRITER uses invalidateForOrg(orgId,"prefix")
// producing key "orgId:prefix".  The two formats never match; invalidation is a no-op.

const KEY_MISMATCH_CHECKS = [];

// ─── matrix coverage map ──────────────────────────────────────────────────────
//
// Maps CACHE_KEYS factory names to the key namespace prefix they produce.
// Used to verify every factory family has an entry in CACHE_INVALIDATION_MATRIX.
// The matrix uses `namespace:` fields; after stripping `<placeholder>` parts
// (everything from the first `<` onward) the prefix must appear here.

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
  invProductsNamespace: "inv:products:list:",
  invProductDetail: "inv:products:detail:",
  invWarehouseDetail: "inv:warehouses:detail:",
  invVendorsNamespace: "inv:vendors:list:",
  invPoNamespace: "inv:po:list:",
  invGrnNamespace: "inv:grn:list:",
  invPoDetail: "inv:po:detail:",
  invSoNamespace: "inv:so:list:",
  invSoDetail: "inv:so:detail:",
  invDashboardNamespace: "inv:dashboard:",
  invCycleCountsNamespace: "inv:cycle-counts:list:",
  invQualityInspectionsNamespace: "inv:quality:inspections:",
  invShipmentsNamespace: "inv:shipments:",
  invPackagesNamespace: "inv:packages:",
  invLoadsNamespace: "inv:loads:",
  invCarriersNamespace: "inv:carriers:",
  invChannelsList: "inv:channels:list:",
  invChannelDetail: "inv:channels:detail:",
  inv3plList: "inv:3pl:list:",
  invImportJobsNamespace: "inv:import-jobs:list:",
  invExportJobsNamespace: "inv:export-jobs:list:",
  invSettings: "inv:settings:",
  invNumberSequences: "inv:numseq:",
  invAiInsightsList: "inv:ai-insights:",
  invVendorReturnsNamespace: "inv:vret:list:",
  invVendorReturnDetail: "inv:vret:detail:",
  invCustomerReturnsNamespace: "inv:cret:list:",
  invCustomerReturnDetail: "inv:cret:detail:",
  invCycleCountDetail: "inv:cycle-counts:detail:",
  invQualityHoldsNamespace: "inv:quality:holds:",
  invQualityRecallsNamespace: "inv:quality:recalls:",
  invReorderNamespace: "inv:reorder:",
  invStockSummaryReportNamespace: "inv:stock:summary-report:",
  invReplenishmentSuggestionsNamespace: "inv:replenishment:suggestions:",
  invValuationReport: "inv:valuation:report:",
  invSlowMovingReport: "inv:slow-moving:",
  invExpiryReport: "inv:expiry:report:",
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
  finInsightsAnomalies: "fin:insights:anomalies:",
  finInsightsDigest: "fin:insights:digest:",
  finCategorizeSuggest: "fin:cat-suggest:",
  permissionsMatrix: "rbac:matrix:",
  rolePerms: "rbac:role-perms:",
  orgHierarchyNamespace: "org:hierarchy:",
  hrHeadcountNamespace: "hr:headcount:",
  leaveAnalyticsNamespace: "hr:leave-analytics:",
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
  orgProfileNamespace: "org:profile:",
  usersStats: "users:stats:",
};

// ─── dynamic matrix parsing ───────────────────────────────────────────────────
//
// The CACHE_INVALIDATION_MATRIX is spread across five files that are imported
// into the main matrix barrel.  We must scan all five to avoid treating every
// RBAC / Finance / Inventory / CRM entry as a gap.

const MATRIX_SIBLING_FILES = [
  "cache-invalidation-rbac-auth.ts",
  "cache-invalidation-finance.ts",
  "cache-invalidation-inventory.ts",
  "cache-invalidation-inventory-fulfillment.ts",
  "cache-invalidation-crm.ts",
  "cache-invalidation-hr.ts",
];

function parseMatrixNamespacePrefixes(matrixPath) {
  const cacheDir = join(matrixPath, "..");
  const allPaths = [matrixPath, ...MATRIX_SIBLING_FILES.map((f) => join(cacheDir, f))];
  const combined = allPaths.map(readFile).join("\n");
  const nsRegex = /namespace:\s*["']([^"']+)["']/g;
  const prefixes = new Set();
  let m;
  while ((m = nsRegex.exec(combined)) !== null) {
    const prefix = m[1].split("<")[0];
    prefixes.add(prefix);
  }
  return prefixes;
}

// ─── missing-invalidation check logic ────────────────────────────────────────

function checkMissingInvalidation(targetContent, allContents, check) {
  if (!check.readPattern.test(targetContent)) return { kind: "skip" };
  const found = allContents.some((c) => check.invalidationPatterns.some((p) => p.test(c)));
  return found ? { kind: "pass" } : { kind: "fail", reason: check.description };
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

/**
 * Drizzle schema objects are camelCase; TABLE_TO_CACHE_FAMILIES names the
 * snake_case Postgres tables. Matching only the snake_case form made all 10
 * entries match 0 of 1069 files, so not one family check ever executed — the
 * `org_hierarchy -> hr:headcount` row that was meant to guard the headcount
 * defect had never run. Both spellings are accepted now, and
 * `tableMatchCoverage` fails the gate if any entry matches nothing.
 */
export function snakeToCamel(name) {
  return name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

export function tableIdentifiers(table) {
  const camel = snakeToCamel(table);
  return camel === table ? [table] : [table, camel];
}

function fileWritesToTable(content, table) {
  for (const ident of tableIdentifiers(table)) {
    const patterns = [
      new RegExp(`\\.insert\\s*\\(\\s*${ident}\\b`),
      new RegExp(`\\.update\\s*\\(\\s*${ident}\\b`),
      new RegExp(`\\.delete\\s*\\(\\s*${ident}\\b`),
      new RegExp(`\\.delete\\s*\\)\\s*\\.from\\s*\\(\\s*${ident}\\b`),
      new RegExp(`tx\\.insert\\s*\\(\\s*${ident}\\b`),
      new RegExp(`tx\\.update\\s*\\(\\s*${ident}\\b`),
      new RegExp(`tx\\.delete\\s*\\(\\s*${ident}\\b`),
    ];
    if (patterns.some((pat) => pat.test(content))) return true;
  }
  return false;
}

/** How many scanned files write to each declared table. A zero is a rotted map. */
export function tableMatchCoverage(tables, contents) {
  const coverage = new Map();
  for (const table of tables)
    coverage.set(table, contents.filter((c) => fileWritesToTable(c, table)).length);
  return coverage;
}

/**
 * Namespace-counter mismatches that are known, reported and owned elsewhere.
 * Each entry must still be a live finding — a stale entry fails the gate, so
 * this cannot rot into a silent permanent exemption.
 */
const NAMESPACE_MISMATCH_ALLOWLIST = [];

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
  results.push({
    name: "negative-control: scope-key del bug flagged",
    pass: badCheck.kind === "fail",
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
  results.push({
    name: "positive-control: namespace invalidation accepted",
    pass: goodCheck.kind === "pass",
    detail: goodCheck,
  });

  // Self-test 3: vacuity guard rejects empty file list
  results.push({
    name: "vacuity-guard: empty scan is rejected",
    pass: [].length < MIN_SERVICE_FILES,
    detail: { fileCount: 0, min: MIN_SERVICE_FILES },
  });

  // Self-test 4: vacuity guard accepts sufficient file list
  const fakeFiles = Array.from({ length: MIN_SERVICE_FILES }, (_, i) => `file${i}.ts`);
  results.push({
    name: "vacuity-guard: adequate scan accepted",
    pass: fakeFiles.length >= MIN_SERVICE_FILES,
    detail: { fileCount: fakeFiles.length, min: MIN_SERVICE_FILES },
  });

  // Self-test 5 (negative): clientsHealth scope read (raw string) + no invalidation = flagged
  const miCheck = MISSING_INVALIDATION_CHECKS[0];
  const clientsReadCode = `return this.cache.cachedVersionedForOrg(orgId, "clients:health", key, fetch);`;
  const miResult = checkMissingInvalidation(clientsReadCode, [clientsReadCode], miCheck);
  results.push({
    name: "negative-control: clientsHealth missing-invalidation flagged",
    pass: miResult.kind === "fail",
    detail: miResult,
  });

  // Self-test 6 (positive): clientsHealth read + namespace invalidation in another file = passes
  const clientsInvalidateCode = `await this.cache.invalidateNamespaceForOrg(orgId, "clients:health");`;
  const miResult2 = checkMissingInvalidation(clientsReadCode, [clientsReadCode, clientsInvalidateCode], miCheck);
  results.push({
    name: "positive-control: clientsHealth passes when namespace invalidation exists",
    pass: miResult2.kind === "pass",
    detail: miResult2,
  });

  // ── Bite proofs against the eight defects report 20b enumerates ───────────
  // Each is reconstructed here in its PRE-FIX wiring. The old gate passed green
  // over all eight; every one of these assertions fails without the shape rules.
  const factories = parseCacheKeyFactories(
    readFile(join(BACKEND_SRC, "common", "cache", "cache-keys.ts")),
  );
  const shapesOf = (source) => resolveFileSites(source, "fixture.ts", factories);
  const check = (label, pass, detail) => results.push({ name: label, pass, detail });

  // Defect 1 — hr:headcount read and bumped two different counters.
  const headcountPreFix = shapesOf(`
    class OrgStructureService {
      getHeadcount(orgId, query) {
        return this.cache.cachedVersioned(\`hr:headcount:\${orgId}\`, \`group:\${query.groupBy}\`, fn, TTL);
      }
    }
    class OrgHierarchyCacheService {
      async invalidateAfterMutation(orgId) {
        await this.cache.invalidateNamespaceForOrg(orgId, "hr:headcount");
      }
    }
  `);
  const headcountMismatch = findNamespaceCounterMismatches(
    headcountPreFix.writes,
    headcountPreFix.invalidates,
  );
  check(
    "defect 1: hr:headcount bump to <ORG>:hr:headcount while the read uses hr:headcount:* is a mismatch",
    headcountMismatch.length === 1 && headcountMismatch[0].shape === "<ORG>:hr:headcount",
    JSON.stringify(headcountMismatch.map((f) => f.shape)),
  );
  check(
    "the <ORG>: prefix is NOT normalised away — that erasure is what hid defect 1",
    headcountPreFix.writes[0]?.shape.startsWith("hr:headcount") === true &&
      headcountPreFix.invalidates[0]?.shape.startsWith("<ORG>:") === true,
    `${headcountPreFix.writes[0]?.shape} vs ${headcountPreFix.invalidates[0]?.shape}`,
  );
  const headcountFixed = shapesOf(`
    getHeadcount(orgId, query) {
      return this.cache.cachedVersionedForOrg(orgId, "hr:headcount", \`group:\${query.groupBy}\`, fn, TTL);
    }
    async invalidateAfterMutation(orgId) {
      await this.cache.invalidateNamespaceForOrg(orgId, "hr:headcount");
    }
  `);
  check(
    "the shipped fix for defect 1 produces no finding",
    findNamespaceCounterMismatches(headcountFixed.writes, headcountFixed.invalidates).length === 0,
  );

  // Defects 2-3 — hr:celebrations: delete of a stem nothing writes.
  const celebrationsPreFix = shapesOf(`
    list(orgId, actorId, scope, day) {
      return this.cache.cached(\`hr:celebrations:\${orgId}:\${actorId}:\${scope}:\${day}\`, fn, TTL);
    }
    async onboard(orgId) {
      await this.cache.invalidate(\`hr:celebrations:\${orgId}\`);
    }
    async terminate(orgId) {
      await this.cache.invalidate(\`hr:celebrations:\${orgId}\`);
    }
  `);
  const celebrationsFindings = findFalsePrefixDeletes(
    celebrationsPreFix.writes,
    celebrationsPreFix.invalidates,
  );
  check(
    "defects 2-3: hr:celebrations stem delete cannot reach the 5-segment key it is meant to clear",
    celebrationsFindings.length === 2 && celebrationsFindings[0].shape === "hr:celebrations:*",
    JSON.stringify(celebrationsFindings.map((f) => f.shape)),
  );

  // Defects 4-5 — hr:analytics: stem delete reaches the overview key but silently
  // misses its two siblings.
  const analyticsPreFix = shapesOf(`
    overview(orgId) { return this.cache.cached(\`hr:analytics:\${orgId}\`, fn, TTL); }
    attendance(orgId, y, m) { return this.cache.cached(\`hr:analytics:attendance:\${orgId}:\${y}:\${m}\`, fn, TTL); }
    attrition(orgId, y) { return this.cache.cached(\`hr:analytics:attrition:\${orgId}:\${y}\`, fn, TTL); }
    async onboard(orgId) { await this.cache.invalidate(\`hr:analytics:\${orgId}\`); }
    async terminate(orgId) { await this.cache.invalidate(\`hr:analytics:\${orgId}\`); }
  `);
  const analyticsFindings = findFalsePrefixDeletes(
    analyticsPreFix.writes,
    analyticsPreFix.invalidates,
  );
  check(
    "defects 4-5: a delete that matches one key exactly and misses two siblings is still reported",
    analyticsFindings.length === 2 && analyticsFindings[0].written.length === 2,
    JSON.stringify(analyticsFindings.map((f) => f.written)),
  );

  // Defects 6-8 — ownership:transfers bumped on the wrong counter from three sites.
  const ownershipPreFix = shapesOf(`
    list(orgId, hash) {
      return this.cache.cachedVersionedForOrg(orgId, "ownership:transfers", hash, fn, TTL);
    }
    async a(orgId) { await this.cache.invalidateNamespace(\`ownership:transfers:\${orgId}\`); }
    async b(orgId) { await this.cache.invalidateNamespace(\`ownership:transfers:\${orgId}\`); }
    async c(orgId) { await this.cache.invalidateNamespace(\`ownership:transfers:\${orgId}\`); }
  `);
  const ownershipFindings = findNamespaceCounterMismatches(
    ownershipPreFix.writes,
    ownershipPreFix.invalidates,
  );
  check(
    "defects 6-8: three invalidateNamespace bumps on a counter the *ForOrg read never uses",
    ownershipFindings.length === 3 && ownershipFindings.every((f) => f.shape === "ownership:transfers:*"),
    JSON.stringify(ownershipFindings.map((f) => f.shape)),
  );

  // Negatives — the rules must not cry wolf.
  const correct = shapesOf(`
    list(orgId, hash) { return this.cache.cachedVersionedForOrg(orgId, "invoices:list", hash, fn, TTL); }
    async write(orgId) { await this.cache.invalidateNamespaceForOrg(orgId, "invoices:list"); }
    one(orgId, id) { return this.cache.cached(\`crm:contact:\${orgId}:\${id}\`, fn, TTL); }
    async del(orgId, id) { await this.cache.invalidate(\`crm:contact:\${orgId}:\${id}\`); }
  `);
  check(
    "a correctly paired namespace produces no finding",
    findNamespaceCounterMismatches(correct.writes, correct.invalidates).length === 0,
  );
  check(
    "an exact-key delete of exactly what was written produces no finding",
    findFalsePrefixDeletes(correct.writes, correct.invalidates).length === 0,
  );
  check(
    "a one-literal-segment shape is filtered as noise rather than reported",
    findFalsePrefixDeletes(
      shapesOf("this.cache.cached(`org:${id}:x`, fn);").writes,
      shapesOf("this.cache.invalidate(`org:${id}`);").invalidates,
    ).length === 0,
  );

  // segmentPrefix semantics.
  check("segmentPrefix: strict prefix", segmentPrefix("a:b", "a:b:c") === true);
  check("segmentPrefix: equal length is not a prefix", segmentPrefix("a:b", "a:b") === false);
  check("segmentPrefix: divergent segment", segmentPrefix("a:b", "a:c:d") === false);
  check("segmentPrefix: wildcard on either side matches", segmentPrefix("a:*", "a:b:c") === true);

  // The rotted table map — the reason none of the 10 family checks ever ran.
  check(
    "snake_case table names are converted to the camelCase Drizzle identifier",
    snakeToCamel("organization_members") === "organizationMembers" &&
      snakeToCamel("org_units") === "orgUnits",
  );
  check(
    "a camelCase Drizzle write is detected (it was invisible before)",
    tableMatchCoverage(["organization_members"], ["await tx.insert(organizationMembers).values(x);"]).get(
      "organization_members",
    ) === 1,
  );
  check(
    "a table entry matching nothing is reported as zero, not silently skipped",
    tableMatchCoverage(["no_such_table"], ["await tx.insert(organizationMembers).values(x);"]).get(
      "no_such_table",
    ) === 0,
  );
  check(
    "every declared table entry matches at least one identifier form",
    TABLE_TO_CACHE_FAMILIES.every((e) => tableIdentifiers(e.table).length >= 1),
  );

  // ── F03 / F03b: the module-toggle session bust ────────────────────────────
  // Four fixtures pin both halves of the rule. Without them the correction to
  // moduleEnableBustsEveryMember would be indistinguishable from deleting it.
  const activeScan = `.where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.status, "ACTIVE")))`;

  const actorOnly = `
    async setModuleEnabled(orgId, moduleKey, enabled, enabledBy) {
      await this.cache.invalidate(CACHE_KEYS.userSession(enabledBy));
    }
  `;
  check(
    "F03 negative-control: busting only the actor is still a finding",
    moduleEnableBustsEveryMember(actorOnly) === false,
  );

  const noSessionBustAtAll = `
    async setModuleEnabled(orgId, moduleKey, enabled) {
      await this.cache.invalidateForOrg(orgId, "entitlements:modules");
    }
  `;
  check(
    "F03 negative-control: no session bust at all is a finding",
    moduleEnableBustsEveryMember(noSessionBustAtAll) === false,
  );

  const scanWithoutBust = `
    async setModuleEnabled(orgId) {
      const members = await tx.select({ userId: organizationMembers.userId })
        .from(organizationMembers)${activeScan};
      await this.cache.invalidateForOrg(orgId, "entitlements:modules");
    }
  `;
  check(
    "F03 negative-control: scanning ACTIVE members but never busting them is a finding",
    moduleEnableBustsEveryMember(scanWithoutBust) === false,
  );

  const perMemberLoop = `
    async setModuleEnabled(orgId) {
      const members = await tx.select({ userId: organizationMembers.userId })
        .from(organizationMembers)${activeScan}.limit(10000);
      await Promise.all(members.map((m) => this.cache.invalidate(CACHE_KEYS.userSession(m.userId))));
    }
  `;
  check(
    "F03 positive: a per-member loop does reach every member",
    moduleEnableBustsEveryMember(perMemberLoop) === true,
  );
  check(
    "F03b negative-control: that same per-member loop is reported as unbounded fan-out",
    moduleEnableFansOutPerMember(perMemberLoop) === true,
  );

  const batchedPaged = `
    async bustActiveMemberSessions(orgId) {
      const members = await tx.select({ membershipId: organizationMembers.id, userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.status, "ACTIVE"),
          gt(organizationMembers.id, afterMembershipId),
        ))
        .orderBy(asc(organizationMembers.id))
        .limit(page);
      await this.cache.invalidateMany(
        members.map((member) => CACHE_KEYS.userSession(member.userId)),
      );
    }
  `;
  check(
    "F03 positive: a batched, keyset-paged bust reaches every member",
    moduleEnableBustsEveryMember(batchedPaged) === true,
  );
  check(
    "F03b positive: the batched bust is NOT reported as unbounded fan-out",
    moduleEnableFansOutPerMember(batchedPaged) === false,
  );

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

  // Scope-key checks (single-file)
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

  // Missing-invalidation checks (cross-file)
  const allContents = serviceFiles.map((f) => readFile(f));
  for (const check of MISSING_INVALIDATION_CHECKS) {
    const targetIdx = serviceFiles.findIndex((f) => f.endsWith(check.targetFile));
    if (targetIdx < 0) continue;
    const result = checkMissingInvalidation(allContents[targetIdx], allContents, check);
    if (result.kind === "fail") {
      findings.push({
        id: check.id,
        severity: check.severity,
        file: serviceFiles[targetIdx].replace(BACKEND_SRC, "src"),
        line: check.line,
        description: check.description,
        kind: "missing-invalidation",
      });
    }
  }

  // Key-mismatch checks (two-file structural)
  for (const check of KEY_MISMATCH_CHECKS) {
    const readTarget = serviceFiles.find((f) => f.endsWith(check.readFile));
    const writeTarget = serviceFiles.find((f) => f.endsWith(check.writeFile));
    if (!readTarget || !writeTarget) continue;
    const readContent = readFile(readTarget);
    const writeContent = readFile(writeTarget);
    if (check.readPattern.test(readContent) && check.writePattern.test(writeContent)) {
      const lines = readContent.split("\n");
      const lineNo = lines.findIndex((l) => check.readPattern.test(l));
      findings.push({
        id: check.id,
        severity: check.severity,
        file: readTarget.replace(BACKEND_SRC, "src"),
        line: lineNo >= 0 ? lineNo + 1 : "unknown",
        description: check.description,
        kind: "key-format-mismatch",
      });
    }
  }

  // Dynamic matrix gap check — every KEY_TO_NAMESPACE_PREFIX prefix must appear in the matrix
  const matrixPath = join(BACKEND_SRC, "common", "cache", "cache-invalidation-matrix.ts");
  const matrixPrefixes = parseMatrixNamespacePrefixes(matrixPath);
  for (const [factory, prefix] of Object.entries(KEY_TO_NAMESPACE_PREFIX)) {
    const covered = [...matrixPrefixes].some((mp) => mp === prefix || prefix.startsWith(mp) || mp.startsWith(prefix));
    if (!covered) {
      findings.push({
        id: `matrix-gap:${factory}`,
        severity: "LOW",
        file: "src/common/cache/cache-invalidation-matrix.ts",
        line: "N/A",
        description: `Cache key family "${prefix}" (factory: ${factory}) has no entry in CACHE_INVALIDATION_MATRIX`,
        kind: "matrix-gap",
      });
    }
  }

  findings.push(...checkModuleEnableSessionBust());

  // ── Table-map vacuity: the lookup table must actually match something ──────
  // 10 entries matched 0 of 1069 files for the whole life of this gate.
  const allSrcContents = walkDir(BACKEND_SRC).map((f) => readFile(f));
  const coverage = tableMatchCoverage(
    TABLE_TO_CACHE_FAMILIES.map((e) => e.table),
    allSrcContents,
  );
  const deadTableEntries = [...coverage].filter(([, n]) => n === 0).map(([t]) => t);
  if (deadTableEntries.length > 0) {
    findings.push({
      id: "table-map-rotted",
      severity: "CRITICAL",
      file: "src/scripts/check-cache-invalidation.mjs",
      line: "TABLE_TO_CACHE_FAMILIES",
      description: `${deadTableEntries.length} of ${coverage.size} table entries match no file in src/ (${deadTableEntries.join(", ")}). Those family checks do not run, so a green result says nothing about them.`,
      kind: "vacuous-lookup-table",
    });
  }

  // ── Key-shape analysis (the defect class the keyword tests cannot see) ─────
  const shapes = resolveAllSites(BACKEND_SRC, join(BACKEND_SRC, "common", "cache", "cache-keys.ts"));
  const shapeCounts = {
    writeSites: shapes.writes.length,
    writeShapes: new Set(shapes.writes.map((w) => w.shape)).size,
    invalidateSites: shapes.invalidates.length,
    cacheKeyFactories: shapes.cacheKeyFactories.size,
  };

  if (shapeCounts.writeSites < MIN_WRITE_SITES || shapeCounts.invalidateSites < MIN_INVALIDATE_SITES) {
    findings.push({
      id: "shape-scan-vacuous",
      severity: "CRITICAL",
      file: "src/common/cache",
      line: "N/A",
      description: `Key-shape scan resolved ${shapeCounts.writeSites} write sites (floor ${MIN_WRITE_SITES}) and ${shapeCounts.invalidateSites} invalidate sites (floor ${MIN_INVALIDATE_SITES}). The resolver is broken; a clean result proves nothing.`,
      kind: "vacuous-shape-scan",
    });
  }

  for (const f of findFalsePrefixDeletes(shapes.writes, shapes.invalidates)) {
    findings.push({
      id: `false-prefix:${f.shape}`,
      severity: "CRITICAL",
      file: f.file,
      line: f.line,
      description: `${f.method}("${f.shape}") deletes a key nothing writes. There is no prefix delete — invalidate() is redis.del(exactKey). What is actually written: ${f.written.slice(0, 3).join(", ")}`,
      kind: "false-prefix-delete",
    });
  }

  const seenAllowlist = new Set();
  for (const f of findNamespaceCounterMismatches(shapes.writes, shapes.invalidates)) {
    const allow = NAMESPACE_MISMATCH_ALLOWLIST.find((a) => a.shape === f.shape);
    if (allow) {
      seenAllowlist.add(allow.shape);
      continue;
    }
    findings.push({
      id: `namespace-mismatch:${f.shape}`,
      severity: "MEDIUM",
      file: f.file,
      line: f.line,
      description: `${f.method} bumps generation counter "${f.shape}" but no cachedVersioned* read uses that namespace. The bump reaches nothing. Note that <ORG>: is significant: the *ForOrg family writes a different Redis key from the global family.`,
      kind: "namespace-counter-mismatch",
    });
  }

  for (const entry of NAMESPACE_MISMATCH_ALLOWLIST) {
    if (seenAllowlist.has(entry.shape)) continue;
    findings.push({
      id: `stale-allowlist:${entry.shape}`,
      severity: "MEDIUM",
      file: "src/scripts/check-cache-invalidation.mjs",
      line: "NAMESPACE_MISMATCH_ALLOWLIST",
      description: `Allowlisted namespace "${entry.shape}" is no longer a finding — remove the entry. (${entry.reason})`,
      kind: "stale-allowlist",
    });
  }

  return { findings, vacuityFailed: false, fileCount: serviceFiles.length, shapeCounts, coverage };
}

/**
 * A module toggle must reach every ACTIVE member's session, and must not cost one
 * Redis command per member to do it.
 *
 * ⚠ CORRECTED 2026-09-03. This check used to demand one literal shape:
 *
 *     members.map((m) => this.cache.invalidate(CACHE_KEYS.userSession(m.userId)))
 *
 * and reported F03 against anything else. That regex does not describe the
 * defect — it describes one implementation of the fix, and specifically the
 * implementation the cache layer had already measured and replaced.
 * `CacheService.invalidateMany` exists because that `.map` issues one command per
 * member against a single Upstash connection; its docblock names this very call
 * site, then reading members at `.limit(10000)`, as the worst measured instance.
 * So the gate failed the corrected code and would have passed the regression —
 * and it would do so worst on the tenant that matters, since the seeded database
 * puts 89.93% of rows in one organisation.
 *
 * The requirement has two halves and they are now checked separately, without
 * prescribing the shape of the fix:
 *
 *   F03  — the ACTIVE-member scan and a session bust covering it must both be
 *          present, and the bust must not be actor-only.
 *   F03b — the per-member `.map(... cache.invalidate(userSession(...)))` fan-out
 *          is itself a finding: it is unbounded in the tenant's member count.
 *          Batch it through `invalidateMany`, which chunks into variadic DELs.
 *
 * F03b is why the correction does not weaken the gate: before it, the ONLY shape
 * this file accepted is now the one shape it rejects.
 */
const ACTIVE_MEMBER_SCAN = /organizationMembers\.status\s*,\s*"ACTIVE"/;
const ACTOR_ONLY_SESSION_BUST = /invalidate\(\s*CACHE_KEYS\.userSession\(\s*enabledBy\s*\)\s*\)/;
const PER_MEMBER_SESSION_FANOUT =
  /\.map\(\s*\(\s*\w+\s*\)\s*=>\s*this\.cache\.invalidate\(\s*CACHE_KEYS\.userSession\(/;
const BATCHED_SESSION_BUST = /invalidateMany\(\s*[\s\S]{0,240}?CACHE_KEYS\.userSession\(/;

export function moduleEnableBustsEveryMember(source) {
  if (ACTOR_ONLY_SESSION_BUST.test(source)) return false;
  if (!ACTIVE_MEMBER_SCAN.test(source)) return false;
  return BATCHED_SESSION_BUST.test(source) || PER_MEMBER_SESSION_FANOUT.test(source);
}

/** True when the bust is one Redis command per member — correct, but unbounded. */
export function moduleEnableFansOutPerMember(source) {
  return PER_MEMBER_SESSION_FANOUT.test(source);
}

function checkModuleEnableSessionBust() {
  const file = "src/modules/access/entitlements.service.ts";
  const abs = join(BACKEND_SRC, "modules/access/entitlements.service.ts");

  let src; try { src = readFileSync(abs, "utf8"); } catch { return []; }

  const findings = [];
  if (!moduleEnableBustsEveryMember(src)) {
    findings.push({
      id: "F03-module-enable-partial-session-bust",
      severity: "MEDIUM",
      file,
      line: "setModuleEnabled",
      description:
        "setModuleEnabled does not invalidate userSession for every ACTIVE org member. Members keep a " +
        "stale enabledModules in their session until TTL. Bust every active member, not just the actor — " +
        "scan organizationMembers on status ACTIVE and pass their userSession keys to cache.invalidateMany.",
      kind: "partial-session-invalidation",
    });
  }
  if (moduleEnableFansOutPerMember(src)) {
    findings.push({
      id: "F03b-module-enable-unbounded-session-fanout",
      severity: "MEDIUM",
      file,
      line: "setModuleEnabled",
      description:
        "setModuleEnabled busts member sessions one Redis command at a time " +
        "(members.map((m) => cache.invalidate(CACHE_KEYS.userSession(...)))). That reads as batched and is " +
        "not: a 10,000-member org issues 10,000 commands from one toggle. Use cache.invalidateMany, which " +
        "collapses each page into variadic DELs.",
      kind: "unbounded-invalidation-fanout",
    });
  }
  return findings;
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

const { findings, vacuityFailed, fileCount, shapeCounts, coverage } = runFullScan();

if (vacuityFailed) {
  process.exit(2);
}

const critical = findings.filter((f) => f.severity === "CRITICAL");
const medium = findings.filter((f) => f.severity === "MEDIUM");
const low = findings.filter((f) => f.severity === "LOW");

process.stdout.write(`\n=== cache-invalidation gate — ${fileCount} service files scanned ===\n`);
process.stdout.write(
  `Key shapes: ${shapeCounts.writeSites} write sites / ${shapeCounts.writeShapes} distinct shapes · ${shapeCounts.invalidateSites} invalidate sites · ${shapeCounts.cacheKeyFactories} CACHE_KEYS factories\n`,
);
process.stdout.write(
  `Table map: ${[...coverage].filter(([, n]) => n > 0).length} of ${coverage.size} entries match at least one file\n\n`,
);

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
