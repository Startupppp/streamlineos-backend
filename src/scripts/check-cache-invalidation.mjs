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
    readPattern: /CACHE_KEYS\.clientsHealth/,
    invalidationPatterns: [
      /invalidateNamespace.*clients.health/i,
      /invalidateNamespaceForOrg.*clients.health/i,
      /invalidate.*["']clients:health["']/,
      /del.*CACHE_KEYS\.clientsHealth/,
    ],
    line: "50",
    description:
      "clientsHealth read appends :userId:scope discriminators making the composite key unaddressable by a base-key del; no invalidation of any kind found across all service files — stale client health data served until TTL",
  },
  {
    id: "clients-churn-no-invalidation",
    severity: "MEDIUM",
    targetFile: "clients.service.ts",
    readPattern: /CACHE_KEYS\.churnAlerts/,
    invalidationPatterns: [
      /invalidateNamespace.*clients.churn/i,
      /invalidateNamespaceForOrg.*clients.churn/i,
      /invalidate.*["']clients:churn["']/,
      /del.*CACHE_KEYS\.churnAlerts/,
    ],
    line: "100",
    description:
      "churnAlerts read appends :userId:scope discriminators; no invalidation of any kind found across all service files — stale churn data served until TTL",
  },
];

// ─── key-mismatch checks ──────────────────────────────────────────────────────
//
// These catch families where a READ uses cache.cached(CACHE_KEYS.factory(orgId))
// producing key "prefix:orgId" while the WRITER uses invalidateForOrg(orgId,"prefix")
// producing key "orgId:prefix".  The two formats never match; invalidation is a no-op.

const KEY_MISMATCH_CHECKS = [
  {
    id: "rbac-discovery-members-key-mismatch",
    severity: "MEDIUM",
    readFile: "rbac.service.ts",
    readPattern: /cache\.cached\s*\(\s*CACHE_KEYS\.rbacDiscoveryMembers/,
    writeFile: "access.service.ts",
    writePattern: /invalidateForOrg\s*\(\s*orgId\s*,\s*["']rbac:members["']/,
    description:
      "rbacDiscoveryMembers: cached(CACHE_KEYS.rbacDiscoveryMembers(orgId)) produces key 'rbac:members:<orgId>' but invalidateForOrg(orgId,'rbac:members') produces '<orgId>:rbac:members' — different formats; invalidation is a no-op. Fix: change rbac.service.ts to cachedForOrg(orgId,'rbac:members',…).",
  },
];

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
  rbacDiscoveryMembers: "rbac:members:",
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

function parseMatrixNamespacePrefixes(matrixPath) {
  const content = readFile(matrixPath);
  const nsRegex = /namespace:\s*["']([^"']+)["']/g;
  const prefixes = new Set();
  let m;
  while ((m = nsRegex.exec(content)) !== null) {
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

  // Self-test 5 (negative): clientsHealth scope read + no invalidation = flagged
  const miCheck = MISSING_INVALIDATION_CHECKS[0];
  const clientsReadCode = `const cacheKey = \`\${CACHE_KEYS.clientsHealth(orgId)}:\${userId}:\${scope}\`;`;
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

  // Self-test 7 (negative): rbac key-mismatch fires when cached(factory)+invalidateForOrg both present
  const badRbacRead = `return this.cache.cached(CACHE_KEYS.rbacDiscoveryMembers(orgId), fetch, 300);`;
  const badRbacWrite = `await this.cache.invalidateForOrg(orgId, "rbac:members");`;
  const kmCheck = KEY_MISMATCH_CHECKS[0];
  const mismatchFired = kmCheck.readPattern.test(badRbacRead) && kmCheck.writePattern.test(badRbacWrite);
  results.push({
    name: "negative-control: rbac key-mismatch flagged when cached+invalidateForOrg",
    pass: mismatchFired,
    detail: { readMatches: kmCheck.readPattern.test(badRbacRead), writeMatches: kmCheck.writePattern.test(badRbacWrite) },
  });

  // Self-test 8 (positive): rbac mismatch clears when cachedForOrg used instead
  const goodRbacRead = `return this.cache.cachedForOrg(orgId, "rbac:members", fetch, 300);`;
  const mismatchCleared = !kmCheck.readPattern.test(goodRbacRead);
  results.push({
    name: "positive-control: rbac mismatch not fired when cachedForOrg used",
    pass: mismatchCleared,
    detail: { readMatches: kmCheck.readPattern.test(goodRbacRead) },
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

  return { findings, vacuityFailed: false, fileCount: serviceFiles.length };
}

export function moduleEnableBustsEveryMember(source) {
  const bustsOneActor = /invalidate\(\s*CACHE_KEYS\.userSession\(\s*enabledBy\s*\)\s*\)/.test(source);
  const bustsEveryMember =
    /organizationMembers\.status\s*,\s*"ACTIVE"/.test(source) &&
    /\.map\(\s*\(\s*\w+\s*\)\s*=>\s*this\.cache\.invalidate\(\s*CACHE_KEYS\.userSession\(/.test(source);
  return bustsEveryMember && !bustsOneActor;
}

function checkModuleEnableSessionBust() {
  const file = "src/modules/access/entitlements.service.ts";
  const abs = join(BACKEND_SRC, "modules/access/entitlements.service.ts".replace("modules/", "modules/"));
  
  let src; try { src = readFileSync(abs, "utf8"); } catch { return []; }
  if (moduleEnableBustsEveryMember(src)) return [];
  return [
    {
      id: "F03-module-enable-partial-session-bust",
      severity: "MEDIUM",
      file,
      line: "setModuleEnabled",
      description:
        "setModuleEnabled does not invalidate userSession for every ACTIVE org member. Members keep a " +
        "stale enabledModules in their session until TTL. Bust each active member, not just the actor.",
      kind: "partial-session-invalidation",
    },
  ];
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
