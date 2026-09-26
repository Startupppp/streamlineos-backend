declare const cacheNamespaceBrand: unique symbol;

/**
 * A namespace is a generation counter, not an address: its entries are reached
 * through `cachedVersioned*` and retired by `invalidateNamespace*`. `ExactCacheKey`
 * refuses it, so deleting a prefix — which `redis.del` cannot do — will not compile.
 */
export type CacheNamespace = string & {
  readonly [cacheNamespaceBrand]: "namespace";
};
export type ExactCacheKey = string & { readonly [cacheNamespaceBrand]?: never };

const namespace = (value: string): CacheNamespace => value as CacheNamespace;

export const CACHE_KEYS = {
  dashboardStats: (orgId: string) => `dashboard:stats:${orgId}`,
  userSession: (userId: string) => `user:session:${userId}`,
  membershipAccount: (userId: string) => `membership:account:${userId}`,

  rolesList: (orgId: string) => `org:roles:${orgId}`,

  mfaOrgPolicy: (orgId: string) => `mfa:org-policy:${orgId}`,
  mfaUserTotp: (userId: string) => `mfa:user-totp:${userId}`,

  accessVersion: (orgId: string) => `access:version:${orgId}`,
  accessSnapshot: (userId: string, version: number, isOrgOwner: boolean) =>
    `access:snapshot:${userId}:v${version}:o${isOrgOwner ? 1 : 0}`,
  accessPerms: (orgId: string, userId: string, version: number) =>
    `access:perms:${orgId}:${userId}:v${version}`,
  accessMembersWithPermPage: (
    orgId: string,
    permissionKey: string,
    version: number,
    afterMembershipId: number,
    limit: number,
  ) =>
    `access:members-with-perm:${orgId}:${permissionKey}:v${version}:a${afterMembershipId}:l${limit}`,

  leadsList: (orgId: string, hash: string) => `leads:list:${orgId}:${hash}`,
  leadDetail: (orgId: string, id: number) => `leads:detail:${orgId}:${id}`,

  contactsList: (orgId: string, hash: string) =>
    `crm:contacts:list:${orgId}:${hash}`,
  contactsListNamespace: (orgId: string) =>
    namespace(`crm:contacts:list:${orgId}`),

  crmOrganizationDetailNamespace: (orgId: string) =>
    namespace(`crm:organizations:detail:${orgId}`),
  crmOrganizationsListNamespace: (orgId: string) =>
    namespace(`crm:organizations:list:${orgId}`),

  projectLabels: (orgId: string) => `projects:labels:${orgId}`,
  orgMembers: (orgId: string) => `org:members:${orgId}`,
  customStates: (orgId: string, projectId: number) =>
    `projects:customStates:${orgId}:${projectId}`,
  ticketsList: (orgId: string, projectId: number, hash: string) =>
    `tickets:list:${orgId}:${projectId}:${hash}`,

  salesDashboard: (orgId: string) => `sales:dashboard:${orgId}`,
  salesKpisNamespace: (orgId: string) => namespace(`sales:kpis:${orgId}`),
  salesKpisSubKey: (from: string, to: string, repId: string) =>
    `${from}:${to}:${repId}`,
  ceDashboard: (orgId: string) => `ce:dashboard:${orgId}`,
  supportDashboard: (orgId: string) => `support:dashboard:${orgId}`,

  dealsList: (orgId: string, hash: string) => `deals:list:${orgId}:${hash}`,
  dealsForecast: (orgId: string) => `deals:forecast:${orgId}`,
  approvalsList: (orgId: string) => `deals:approvals:${orgId}`,

  quotasList: (orgId: string, filters: string) =>
    `sales:quotas:${orgId}:${filters}`,
  commissionsList: (orgId: string, filters: string) =>
    `sales:commissions:${orgId}:${filters}`,

  searchResults: (orgId: string, userId: string, hash: string) =>
    `search:${orgId}:${userId}:${hash}`,

  kbQueryEmbedding: (model: string, queryHash: string) =>
    `kb:qembed:${model}:${queryHash}`,

  leadBoard: (orgId: string, hash: string) => `leads:board:${orgId}:${hash}`,
  leadStats: (orgId: string, hash: string) => `leads:stats:${orgId}:${hash}`,

  executiveDashboard: (orgId: string, projection: string) =>
    `dashboard:executive:${orgId}:${projection}`,
  announcementsList: (orgId: string) => `dashboard:announcements:${orgId}`,
  broadcastsListNamespace: (orgId: string) =>
    namespace(`broadcasts:list:${orgId}`),

  taskDetail: (orgId: string, id: number) => `tasks:detail:${orgId}:${id}`,

  quotesList: (orgId: string, hash: string) => `quotes:list:${orgId}:${hash}`,
  quoteDetail: (orgId: string, id: number) => `quotes:detail:${orgId}:${id}`,

  supportTicketsList: (orgId: string, hash: string) =>
    `support:list:${orgId}:${hash}`,
  supportTicketDetail: (orgId: string, id: number) =>
    `support:detail:${orgId}:${id}`,

  calendarEvents: (orgId: string, hash: string) =>
    `calendar:events:${orgId}:${hash}`,
  externalCalendarEvents: (
    connectionId: number,
    startIso: string,
    endIso: string,
  ) => `integrations:extevents:${connectionId}:${startIso}:${endIso}`,

  targetsList: (orgId: string, hash: string) => `targets:list:${orgId}:${hash}`,
  targetLeaderboard: (orgId: string, metricType: string) =>
    `targets:leaderboard:${orgId}:${metricType}`,

  invProductsNamespace: (orgId: string) =>
    namespace(`inv:products:list:${orgId}`),
  invProductDetail: (orgId: string, id: number) =>
    `inv:products:detail:${orgId}:${id}`,
  invWarehouseDetail: (orgId: string, id: number) =>
    `inv:warehouses:detail:${orgId}:${id}`,
  invVendorsNamespace: (orgId: string) =>
    namespace(`inv:vendors:list:${orgId}`),
  invPoNamespace: (orgId: string) => namespace(`inv:po:list:${orgId}`),
  invGrnNamespace: (orgId: string) => namespace(`inv:grn:list:${orgId}`),
  invPoDetail: (orgId: string, id: number) => `inv:po:detail:${orgId}:${id}`,
  invVendorReturnDetail: (orgId: string, id: number) =>
    `inv:vret:detail:${orgId}:${id}`,
  invVendorReturnsNamespace: (orgId: string) =>
    namespace(`inv:vret:list:${orgId}`),
  invCustomerReturnDetail: (orgId: string, id: number) =>
    `inv:cret:detail:${orgId}:${id}`,
  invCustomerReturnsNamespace: (orgId: string) =>
    namespace(`inv:cret:list:${orgId}`),
  invSoNamespace: (orgId: string) => namespace(`inv:so:list:${orgId}`),
  invSoDetail: (orgId: string, id: number) => `inv:so:detail:${orgId}:${id}`,
  invDashboardNamespace: (orgId: string) => namespace(`inv:dashboard:${orgId}`),
  invReorderNamespace: (orgId: string) => namespace(`inv:reorder:${orgId}`),
  invStockSummaryReportNamespace: (orgId: string) =>
    namespace(`inv:stock:summary-report:${orgId}`),
  invReplenishmentSuggestionsNamespace: (orgId: string) =>
    namespace(`inv:replenishment:suggestions:${orgId}`),

  invValuationReport: (orgId: string, hash: string) =>
    `inv:valuation:report:${orgId}:${hash}`,
  invSlowMovingReport: (orgId: string, hash: string) =>
    `inv:slow-moving:${orgId}:${hash}`,
  invExpiryReport: (orgId: string, hash: string) =>
    `inv:expiry:report:${orgId}:${hash}`,
  invCycleCountsNamespace: (orgId: string) =>
    namespace(`inv:cycle-counts:list:${orgId}`),
  invCycleCountDetail: (orgId: string, id: number) =>
    `inv:cycle-counts:detail:${orgId}:${id}`,
  // Physical audits sit beside cycle counts here rather than in their own module
  // for a reason beyond tidiness: the list namespace is bumped from
  // `counts/lib/physical-audit-commands.ts` and read from
  // `counts/inv-physical-audits.service.ts`, and a module-local `const` factory
  // resolves only within the file that declares it. Every static reader of this
  // codebase — the cache gates included — therefore saw the bump and not the
  // read, and reported a correctly paired namespace as a bump reaching nothing.
  invPhysicalAuditsNamespace: (orgId: string) =>
    namespace(`inv:physical-audits:list:${orgId}`),
  invPhysicalAuditDetail: (orgId: string, id: number) =>
    `inv:physical-audits:detail:${orgId}:${id}`,
  invQualityInspectionsNamespace: (orgId: string) =>
    namespace(`inv:quality:inspections:${orgId}`),
  invQualityHoldsNamespace: (orgId: string) =>
    namespace(`inv:quality:holds:${orgId}`),
  invQualityRecallsNamespace: (orgId: string) =>
    namespace(`inv:quality:recalls:${orgId}`),
  invInspectionPlansNamespace: (orgId: string) =>
    namespace(`inv:quality:plans:${orgId}`),
  invPackagesNamespace: (orgId: string) => namespace(`inv:packages:${orgId}`),
  invShipmentsNamespace: (orgId: string) => namespace(`inv:shipments:${orgId}`),
  invLoadsNamespace: (orgId: string) => namespace(`inv:loads:${orgId}`),
  invCarriersNamespace: (orgId: string) => namespace(`inv:carriers:${orgId}`),
  invChannelsList: (orgId: string) => `inv:channels:list:${orgId}`,
  invChannelDetail: (orgId: string, id: number) =>
    `inv:channels:detail:${orgId}:${id}`,
  inv3plList: (orgId: string) => `inv:3pl:list:${orgId}`,
  invImportJobsNamespace: (orgId: string) =>
    namespace(`inv:import-jobs:list:${orgId}`),
  invExportJobsNamespace: (orgId: string) =>
    namespace(`inv:export-jobs:list:${orgId}`),
  invAuditExportJobsNamespace: (orgId: string) =>
    namespace(`inv:audit-export-jobs:list:${orgId}`),
  invSettings: (orgId: string) => `inv:settings:${orgId}`,
  invNumberSequences: (orgId: string) => `inv:numseq:${orgId}`,
  invAiInsightsList: (orgId: string) => `inv:ai-insights:${orgId}`,

  mailMessages: (
    accountId: number,
    folder: string,
    cursor: string,
    q: string,
  ) => `mail:messages:${accountId}:${folder}:${cursor}:${q}`,

  featureFlags: () => "feature-flags:all",

  orgHierarchyNamespace: (orgId: string) => namespace(`org:hierarchy:${orgId}`),
  leaveAnalyticsNamespace: (orgId: string) =>
    namespace(`hr:leave-analytics:${orgId}`),
  hrEmployeesListNamespace: (orgId: string) =>
    namespace(`hr:employees:list:${orgId}`),

  /** Employee expense claims (`modules/expenses`), versioned per organisation. */
  expensesListNamespace: (orgId: string) => namespace(`expenses:list:${orgId}`),

  supportReportsOverview: (orgId: string) =>
    `support:reports:overview:${orgId}`,

  payrollSummary: (orgId: string, hash: string) =>
    `timesheets:payroll:summary:${orgId}:${hash}`,
  payrollSummaryNamespace: (orgId: string) =>
    namespace(`timesheets:payroll:summary:${orgId}`),
  payrollExportsList: (
    orgId: string,
    page: number | "*",
    pageSize: number | "*",
  ) => `timesheets:payroll:exports:${orgId}:${page}:${pageSize}`,
  payrollExportsNamespace: (orgId: string) =>
    namespace(`timesheets:payroll:exports:${orgId}`),
  payrollSettings: (orgId: string) => `timesheets:payroll:settings:${orgId}`,
  payrollSettingsNamespace: (orgId: string) =>
    namespace(`timesheets:payroll:settings:${orgId}`),

  timesheetSettings: (orgId: string) => `timesheets:settings:${orgId}`,
  timesheetSettingsNamespace: (orgId: string) =>
    namespace(`timesheets:settings:${orgId}`),
  timesheetRates: (orgId: string) => `timesheets:rates:${orgId}`,
  timesheetRatesNamespace: (orgId: string) =>
    namespace(`timesheets:rates:${orgId}`),

  finReportsNamespace: (orgId: string) => namespace(`fin:reports:${orgId}`),
  finInsightsAnomalies: (orgId: string, from: string, to: string) =>
    `fin:insights:anomalies:${orgId}:${from}:${to}`,
  finInsightsDigest: (orgId: string) => `fin:insights:digest:${orgId}`,
  finCategorizeSuggest: (orgId: string, merchant: string) =>
    `fin:cat-suggest:${orgId}:${merchant}`,

  finAssetsListNamespace: (orgId: string) =>
    namespace(`fin:assets:list:${orgId}`),
  finAssetCategoriesNamespace: (orgId: string) =>
    namespace(`fin:asset-categories:${orgId}`),
  finTaxCodesNamespace: (orgId: string) => namespace(`fin:tax-codes:${orgId}`),
  finTaxPaymentsNamespace: (orgId: string) =>
    namespace(`fin:tax-payments:${orgId}`),
  finTaxDashboardNamespace: (orgId: string) =>
    namespace(`fin:tax-dashboard:${orgId}`),
  finTaxReportsNamespace: (orgId: string) =>
    namespace(`fin:tax-reports:${orgId}`),
  finExpensePoliciesNamespace: (orgId: string) =>
    namespace(`fin:expense-policies:${orgId}`),
  finBankAccountsNamespace: (orgId: string) =>
    namespace(`fin:banking:accounts:${orgId}`),
  finForecastNamespace: (orgId: string) => namespace(`fin:forecast:${orgId}`),
  finBvaNamespace: (orgId: string, budgetId: number) =>
    namespace(`fin:bva:${orgId}:${budgetId}`),

  orgProfileNamespace: (orgId: string) => namespace(`org:profile:${orgId}`),
  orgMembersListNamespace: (orgId: string) =>
    namespace(`org:members:list:${orgId}`),
  usersStats: (orgId: string) => `users:stats:${orgId}`,

  permissionsMatrix: (orgId: string, version: number) =>
    `rbac:matrix:${orgId}:v${version}`,
  rolePerms: (orgId: string, roleId: number, version: number) =>
    `rbac:role-perms:${orgId}:${roleId}:v${version}`,

  moduleRolesList: (orgId: string, moduleKey: string, version: number) =>
    `module-access:roles:${orgId}:${moduleKey}:v${version}`,
  moduleGroupsList: (orgId: string, moduleKey: string, version: number) =>
    `module-access:groups:${orgId}:${moduleKey}:v${version}`,
  moduleGroupMembers: (
    orgId: string,
    moduleKey: string,
    groupId: number,
    version: number,
  ) =>
    `module-access:group-members:${orgId}:${moduleKey}:${groupId}:v${version}`,
  moduleAccessMembers: (
    orgId: string,
    moduleKey: string,
    limit: number,
    version: number,
    userId?: string,
    cursor?: number,
  ) =>
    `module-access:members:${orgId}:${moduleKey}:v${version}:limit:${limit}:cursor:${cursor ?? "start"}:${userId ?? "all"}`,
  moduleAccessOwnership: (orgId: string, moduleKey: string) =>
    `module-access:ownership:${orgId}:${moduleKey}`,

  moduleOwnershipsList: (orgId: string) => `ownership:modules:${orgId}`,
  moduleOwnershipDetail: (orgId: string, moduleKey: string) =>
    `ownership:module:${orgId}:${moduleKey}`,
  ownershipTransfersList: (orgId: string, hash: string) =>
    `ownership:transfers:${orgId}:${hash}`,
  incomingTransfers: (orgId: string, userId: string) =>
    `ownership:incoming:${orgId}:${userId}`,
} as const;

/**
 * Home's pending-approvals section is keyed per approver, so a leave decision
 * cannot name the entries it invalidates. The generation counter retires every
 * approver's entry in one O(1) bump.
 */
export const DASHBOARD_PENDING_APPROVALS_NAMESPACE = namespace(
  "dashboard-home:pending-approvals",
);

export const CACHE_TTL = {
  SHORT: 30,
  MEDIUM: 300,
  LONG: 600,
  HOUR: 3600,
  VERY_LONG: 1800,
} as const;
