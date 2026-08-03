export const CACHE_KEYS = {
  dashboardStats: (orgId: string) => `dashboard:stats:${orgId}`,
  userSession: (userId: string) => `user:session:${userId}`,

  rolesList: (orgId: string) => `org:roles:${orgId}`,

  mfaOrgPolicy: (orgId: string) => `mfa:org-policy:${orgId}`,
  mfaUserTotp: (userId: string) => `mfa:user-totp:${userId}`,

  accessVersion: (orgId: string) => `access:version:${orgId}`,
  accessPerms: (orgId: string, userId: string, version: number) =>
    `access:perms:${orgId}:${userId}:v${version}`,
  accessMembersWithPerm: (
    orgId: string,
    permissionKey: string,
    version: number,
    limit = 50,
  ) => `access:members-with-perm:${orgId}:${permissionKey}:v${version}:l${limit}`,

  leadsList: (orgId: string, hash: string) => `leads:list:${orgId}:${hash}`,
  leadDetail: (orgId: string, id: number) => `leads:detail:${orgId}:${id}`,

  contactsList: (orgId: string, hash: string) =>
    `crm:contacts:list:${orgId}:${hash}`,

  projectsList: (orgId: string) => `projects:list:${orgId}`,
  projectLabels: (orgId: string) => `projects:labels:${orgId}`,
  orgMembers: (orgId: string) => `org:members:${orgId}`,
  customStates: (orgId: string, projectId: number) =>
    `projects:customStates:${orgId}:${projectId}`,
  ticketsList: (orgId: string, projectId: number, hash: string) =>
    `tickets:list:${orgId}:${projectId}:${hash}`,

  salesDashboard: (orgId: string) => `sales:dashboard:${orgId}`,
  salesKpis: (orgId: string) => `sales:kpis:${orgId}:::`,
  ceDashboard: (orgId: string) => `ce:dashboard:${orgId}`,
  supportDashboard: (orgId: string) => `support:dashboard:${orgId}`,

  dealsList: (orgId: string, hash: string) => `deals:list:${orgId}:${hash}`,
  dealsForecast: (orgId: string) => `deals:forecast:${orgId}`,
  approvalsList: (orgId: string) => `deals:approvals:${orgId}`,

  clientsHealth: (orgId: string) => `clients:health:${orgId}`,
  churnAlerts: (orgId: string) => `clients:churn:${orgId}`,

  quotasList: (orgId: string) => `sales:quotas:${orgId}`,
  commissionsList: (orgId: string) => `sales:commissions:${orgId}`,

  searchResults: (orgId: string, userId: string, hash: string) =>
    `search:${orgId}:${userId}:${hash}`,

  leadBoard: (orgId: string, hash: string) => `leads:board:${orgId}:${hash}`,
  leadStats: (orgId: string, hash: string) => `leads:stats:${orgId}:${hash}`,

  executiveDashboard: (orgId: string) => `dashboard:executive:${orgId}`,
  announcementsList: (orgId: string) => `dashboard:announcements:${orgId}`,

  invoicesList: (orgId: string, hash: string) =>
    `invoices:list:${orgId}:${hash}`,
  invoiceDetail: (orgId: string, id: number) =>
    `invoices:detail:${orgId}:${id}`,
  invoiceStats: (orgId: string) => `invoices:stats:${orgId}`,

  tasksList: (orgId: string, hash: string) => `tasks:list:${orgId}:${hash}`,
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

  branchesList: (orgId: string) => `branches:list:${orgId}`,

  invProductsList: (orgId: string, hash: string) =>
    `inv:products:list:${orgId}:${hash}`,
  invProductDetail: (orgId: string, id: number) =>
    `inv:products:detail:${orgId}:${id}`,
  invStockLevels: (orgId: string, hash: string) =>
    `inv:stock:levels:${orgId}:${hash}`,
  invStockSummary: (orgId: string) => `inv:stock:summary:${orgId}`,
  invLowStock: (orgId: string) => `inv:low-stock:${orgId}`,
  invWarehousesList: (orgId: string) => `inv:warehouses:${orgId}`,
  invWarehouseDetail: (orgId: string, id: number) =>
    `inv:warehouses:detail:${orgId}:${id}`,
  invVendorsList: (orgId: string, hash: string) =>
    `inv:vendors:list:${orgId}:${hash}`,
  invPoList: (orgId: string, hash: string) => `inv:po:list:${orgId}:${hash}`,
  invPoDetail: (orgId: string, id: number) => `inv:po:detail:${orgId}:${id}`,
  invVendorReturnDetail: (orgId: string, id: number) =>
    `inv:vret:detail:${orgId}:${id}`,
  invCustomerReturnDetail: (orgId: string, id: number) =>
    `inv:cret:detail:${orgId}:${id}`,
  invSoList: (orgId: string, hash: string) => `inv:so:list:${orgId}:${hash}`,
  invSoDetail: (orgId: string, id: number) => `inv:so:detail:${orgId}:${id}`,
  invDashboard: (orgId: string) => `inv:dashboard:${orgId}`,
  invReorderReport: (orgId: string) => `inv:reorder:${orgId}`,
  invReorderReportPaged: (orgId: string, hash: string) =>
    `inv:reorder:paged:${orgId}:${hash}`,
  invStockSummaryReport: (orgId: string, hash: string) =>
    `inv:stock:summary-report:${orgId}:${hash}`,
  invLotsList: (orgId: string, hash: string) =>
    `inv:lots:list:${orgId}:${hash}`,
  invLotsListPattern: (orgId: string) => `inv:lots:list:${orgId}:*`,
  invAdjustmentsList: (orgId: string, hash: string) =>
    `inv:adjustments:list:${orgId}:${hash}`,
  invAdjustmentsListPattern: (orgId: string) =>
    `inv:adjustments:list:${orgId}:*`,
  invReplenishmentSuggestions: (orgId: string, hash: string) =>
    `inv:replenishment:suggestions:${orgId}:${hash}`,

  invReservationsList: (orgId: string, hash: string) =>
    `inv:reservations:list:${orgId}:${hash}`,
  invLotDetail: (orgId: string, id: number) => `inv:lots:detail:${orgId}:${id}`,
  invValuationReport: (orgId: string, hash: string) =>
    `inv:valuation:report:${orgId}:${hash}`,
  invSlowMovingReport: (orgId: string, hash: string) =>
    `inv:slow-moving:${orgId}:${hash}`,
  invExpiryReport: (orgId: string, hash: string) =>
    `inv:expiry:report:${orgId}:${hash}`,
  invReorderRulesList: (orgId: string, hash: string) =>
    `inv:reorder-rules:list:${orgId}:${hash}`,
  invCycleCountsList: (orgId: string, hash: string) =>
    `inv:cycle-counts:list:${orgId}:${hash}`,
  invCycleCountDetail: (orgId: string, id: number) =>
    `inv:cycle-counts:detail:${orgId}:${id}`,
  invQualityInspectionsList: (orgId: string, hash: string) =>
    `inv:quality:inspections:${orgId}:${hash}`,
  invQualityHoldsList: (orgId: string, hash: string) =>
    `inv:quality:holds:${orgId}:${hash}`,
  invQualityHoldDetail: (orgId: string, id: number) =>
    `inv:quality:holds:detail:${orgId}:${id}`,
  invQualityRecallsList: (orgId: string, hash: string) =>
    `inv:quality:recalls:${orgId}:${hash}`,
  invPackagesList: (orgId: string, hash: string) =>
    `inv:packages:list:${orgId}:${hash}`,
  invPackageDetail: (orgId: string, id: number) =>
    `inv:packages:detail:${orgId}:${id}`,
  invShipmentsList: (orgId: string, hash: string) =>
    `inv:shipments:list:${orgId}:${hash}`,
  invShipmentDetail: (orgId: string, id: number) =>
    `inv:shipments:detail:${orgId}:${id}`,
  invLoadsList: (orgId: string, hash: string) =>
    `inv:loads:list:${orgId}:${hash}`,
  invLoadDetail: (orgId: string, id: number) =>
    `inv:loads:detail:${orgId}:${id}`,
  invCarriersList: (orgId: string) => `inv:carriers:${orgId}`,
  invChannelsList: (orgId: string) => `inv:channels:list:${orgId}`,
  invChannelDetail: (orgId: string, id: number) =>
    `inv:channels:detail:${orgId}:${id}`,
  inv3plList: (orgId: string) => `inv:3pl:list:${orgId}`,
  invImportJobsList: (orgId: string, hash: string) =>
    `inv:import-jobs:list:${orgId}:${hash}`,
  invExportJobsList: (orgId: string, hash: string) =>
    `inv:export-jobs:list:${orgId}:${hash}`,
  invSettings: (orgId: string) => `inv:settings:${orgId}`,
  invNumberSequences: (orgId: string) => `inv:numseq:${orgId}`,
  invAiInsightsList: (orgId: string) => `inv:ai-insights:${orgId}`,
  invTraceabilityLot: (orgId: string, lotId: number) =>
    `inv:trace:lot:${orgId}:${lotId}`,
  invTraceabilitySerial: (orgId: string, serialId: number) =>
    `inv:trace:serial:${orgId}:${serialId}`,
  invStockLevelPattern: (orgId: string) => `inv:stock:levels:${orgId}:*`,

  mailMessages: (
    accountId: number,
    folder: string,
    cursor: string,
    q: string,
  ) => `mail:messages:${accountId}:${folder}:${cursor}:${q}`,
  mailMessagesPattern: (accountId: number) => `mail:messages:${accountId}:*`,

  featureFlags: () => "feature-flags:all",

  orgUnits: (orgId: string, kind?: string) =>
    kind ? `org:units:${orgId}:${kind}` : `org:units:${orgId}`,

  supportReportsOverview: (orgId: string) =>
    `support:reports:overview:${orgId}`,

  payrollSummary: (orgId: string, hash: string) =>
    `timesheets:payroll:summary:${orgId}:${hash}`,
  payrollExportsList: (
    orgId: string,
    page: number | "*",
    pageSize: number | "*",
  ) => `timesheets:payroll:exports:${orgId}:${page}:${pageSize}`,
  payrollSettings: (orgId: string) => `timesheets:payroll:settings:${orgId}`,

  timesheetSettings: (orgId: string) => `timesheets:settings:${orgId}`,
  timesheetRates: (orgId: string) => `timesheets:rates:${orgId}`,

  finOverview: (orgId: string) => `fin:overview:${orgId}`,
  finOverviewWithDates: (orgId: string, from: string, to: string) =>
    `fin:overview:${orgId}:${from}:${to}`,
  finVendorStatement: (
    orgId: string,
    vendorId: number,
    from: string,
    to: string,
  ) => `fin:vendor-stmt:${orgId}:${vendorId}:${from}:${to}`,
  finCustomerStatement: (
    orgId: string,
    clientId: number,
    from: string,
    to: string,
  ) => `fin:customer-stmt:${orgId}:${clientId}:${from}:${to}`,
  finSalesByCustomer: (orgId: string, from: string, to: string) =>
    `fin:sales-by-customer:${orgId}:${from}:${to}`,
  finSalesByItem: (orgId: string, from: string, to: string) =>
    `fin:sales-by-item:${orgId}:${from}:${to}`,
  finExpenseByCategory: (orgId: string, from: string, to: string) =>
    `fin:expense-by-cat:${orgId}:${from}:${to}`,
  finTaxSummary: (orgId: string, from: string, to: string) =>
    `fin:tax-summary:${orgId}:${from}:${to}`,
  finProjectProfitability: (orgId: string, from: string, to: string) =>
    `fin:proj-profit:${orgId}:${from}:${to}`,
  finDeptProfitability: (orgId: string, from: string, to: string) =>
    `fin:dept-profit:${orgId}:${from}:${to}`,
  finBudgetVsActual: (
    orgId: string,
    budgetId: number,
    from: string,
    to: string,
  ) => `fin:bva:${orgId}:${budgetId}:${from}:${to}`,
  finWorkingCapital: (orgId: string, asOf: string) =>
    `fin:working-capital:${orgId}:${asOf}`,
  finBurnRate: (orgId: string) => `fin:burn-rate:${orgId}`,
  finCashRunway: (orgId: string, months: number) =>
    `fin:cash-runway:${orgId}:${months}`,
  finInsightsAnomalies: (orgId: string, from: string, to: string) =>
    `fin:insights:anomalies:${orgId}:${from}:${to}`,
  finInsightsDigest: (orgId: string) => `fin:insights:digest:${orgId}`,
  finCategorizeSuggest: (orgId: string, merchant: string) =>
    `fin:cat-suggest:${orgId}:${merchant}`,

  orgSettings: (orgId: string) => `org:settings:${orgId}`,
  orgProfile: (orgId: string, userId: string) => `org:profile:${orgId}:${userId}`,
  orgProfilePattern: (orgId: string) => `org:profile:${orgId}:*`,
  orgMembersList: (orgId: string, hash: string) => `org:members:list:${orgId}:${hash}`,
  orgMembersListPattern: (orgId: string) => `org:members:list:${orgId}:*`,
  orgMembersSimple: (orgId: string, hash: string) => `org:members-simple:${orgId}:${hash}`,
  orgMembersSimplePattern: (orgId: string) => `org:members-simple:${orgId}:*`,

  permissionsMatrix: (orgId: string, version: number) => `rbac:matrix:${orgId}:v${version}`,
  rolePerms: (orgId: string, roleId: number, version: number) =>
    `rbac:role-perms:${orgId}:${roleId}:v${version}`,
  rbacDiscoveryMembers: (orgId: string) => `rbac:members:${orgId}`,

  moduleRolesList: (orgId: string, moduleKey: string, version: number) =>
    `module-access:roles:${orgId}:${moduleKey}:v${version}`,
  moduleGroupsList: (orgId: string, moduleKey: string, version: number) =>
    `module-access:groups:${orgId}:${moduleKey}:v${version}`,
  moduleGroupMembers: (
    orgId: string,
    moduleKey: string,
    groupId: number,
    version: number,
  ) => `module-access:group-members:${orgId}:${moduleKey}:${groupId}:v${version}`,
  moduleAccessCandidates: (orgId: string) => `module-access:candidates:${orgId}`,
  moduleAccessMembers: (
    orgId: string,
    moduleKey: string,
    page: number,
    pageSize: number,
    version: number,
  ) => `module-access:members:${orgId}:${moduleKey}:v${version}:${page}:${pageSize}`,
  moduleAccessOwnership: (orgId: string, moduleKey: string) =>
    `module-access:ownership:${orgId}:${moduleKey}`,

  moduleOwnershipsList: (orgId: string) => `ownership:modules:${orgId}`,
  moduleOwnershipDetail: (orgId: string, moduleKey: string) =>
    `ownership:module:${orgId}:${moduleKey}`,
  ownershipTransfersList: (orgId: string, hash: string) =>
    `ownership:transfers:${orgId}:${hash}`,
  ownershipTransfersPattern: (orgId: string) => `ownership:transfers:${orgId}:*`,
  incomingTransfers: (orgId: string, userId: string) =>
    `ownership:incoming:${orgId}:${userId}`,
  incomingTransfersPattern: (orgId: string) => `ownership:incoming:${orgId}:*`,
} as const;

export const CACHE_TTL = {
  SHORT: 30,
  MEDIUM: 300,
  LONG: 600,
  HOUR: 3600,
  VERY_LONG: 1800,
} as const;
