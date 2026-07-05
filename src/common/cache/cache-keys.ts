export const CACHE_KEYS = {

  dashboardStats: (orgId: string) => `dashboard:stats:${orgId}`,
  userSession: (userId: string) => `user:session:${userId}`,

  rolesList: (orgId: string) => `org:roles:${orgId}`,

  accessVersion: (orgId: string) => `access:version:${orgId}`,
  accessPerms: (orgId: string, userId: string, version: number) =>
    `access:perms:${orgId}:${userId}:v${version}`,

  leadsList: (orgId: string, hash: string) => `leads:list:${orgId}:${hash}`,
  leadDetail: (orgId: string, id: number) => `leads:detail:${orgId}:${id}`,

  contactsList: (orgId: string, hash: string) => `crm:contacts:list:${orgId}:${hash}`,

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

  searchResults: (orgId: string, userId: string, hash: string) => `search:${orgId}:${userId}:${hash}`,

  leadBoard: (orgId: string, hash: string) => `leads:board:${orgId}:${hash}`,
  leadStats: (orgId: string, hash: string) => `leads:stats:${orgId}:${hash}`,

  executiveDashboard: (orgId: string) => `dashboard:executive:${orgId}`,
  announcementsList: (orgId: string) => `dashboard:announcements:${orgId}`,

  invoicesList: (orgId: string, hash: string) => `invoices:list:${orgId}:${hash}`,
  invoiceDetail: (orgId: string, id: number) => `invoices:detail:${orgId}:${id}`,
  invoiceStats: (orgId: string) => `invoices:stats:${orgId}`,

  tasksList: (orgId: string, hash: string) => `tasks:list:${orgId}:${hash}`,
  taskDetail: (orgId: string, id: number) => `tasks:detail:${orgId}:${id}`,

  quotesList: (orgId: string, hash: string) => `quotes:list:${orgId}:${hash}`,
  quoteDetail: (orgId: string, id: number) => `quotes:detail:${orgId}:${id}`,

  supportTicketsList: (orgId: string, hash: string) => `support:list:${orgId}:${hash}`,
  supportTicketDetail: (orgId: string, id: number) => `support:detail:${orgId}:${id}`,

  calendarEvents: (orgId: string, hash: string) => `calendar:events:${orgId}:${hash}`,
  externalCalendarEvents: (connectionId: number, startIso: string, endIso: string) =>
    `integrations:extevents:${connectionId}:${startIso}:${endIso}`,

  targetsList: (orgId: string, hash: string) => `targets:list:${orgId}:${hash}`,
  targetLeaderboard: (orgId: string, metricType: string) => `targets:leaderboard:${orgId}:${metricType}`,

  branchesList: (orgId: string) => `branches:list:${orgId}`,

  invProductsList: (orgId: string, hash: string) => `inv:products:list:${orgId}:${hash}`,
  invProductDetail: (orgId: string, id: number) => `inv:products:detail:${orgId}:${id}`,
  invStockLevels: (orgId: string, hash: string) => `inv:stock:levels:${orgId}:${hash}`,
  invStockSummary: (orgId: string) => `inv:stock:summary:${orgId}`,
  invLowStock: (orgId: string) => `inv:low-stock:${orgId}`,
  invWarehousesList: (orgId: string) => `inv:warehouses:${orgId}`,
  invWarehouseDetail: (orgId: string, id: number) => `inv:warehouses:detail:${orgId}:${id}`,
  invVendorsList: (orgId: string, hash: string) => `inv:vendors:list:${orgId}:${hash}`,
  invPoList: (orgId: string, hash: string) => `inv:po:list:${orgId}:${hash}`,
  invPoDetail: (orgId: string, id: number) => `inv:po:detail:${orgId}:${id}`,
  invSoList: (orgId: string, hash: string) => `inv:so:list:${orgId}:${hash}`,
  invSoDetail: (orgId: string, id: number) => `inv:so:detail:${orgId}:${id}`,
  invDashboard: (orgId: string) => `inv:dashboard:${orgId}`,
  invReorderReport: (orgId: string) => `inv:reorder:${orgId}`,

  invReservationsList: (orgId: string, hash: string) => `inv:reservations:list:${orgId}:${hash}`,
  invLotDetail: (orgId: string, id: number) => `inv:lots:detail:${orgId}:${id}`,
  invValuationReport: (orgId: string, hash: string) => `inv:valuation:report:${orgId}:${hash}`,
  invSlowMovingReport: (orgId: string, hash: string) => `inv:slow-moving:${orgId}:${hash}`,
  invExpiryReport: (orgId: string, hash: string) => `inv:expiry:report:${orgId}:${hash}`,
  invReorderRulesList: (orgId: string, hash: string) => `inv:reorder-rules:list:${orgId}:${hash}`,
  invCycleCountsList: (orgId: string, hash: string) => `inv:cycle-counts:list:${orgId}:${hash}`,
  invCycleCountDetail: (orgId: string, id: number) => `inv:cycle-counts:detail:${orgId}:${id}`,
  invQualityInspectionsList: (orgId: string, hash: string) => `inv:quality:inspections:${orgId}:${hash}`,
  invQualityHoldsList: (orgId: string, hash: string) => `inv:quality:holds:${orgId}:${hash}`,
  invQualityRecallsList: (orgId: string, hash: string) => `inv:quality:recalls:${orgId}:${hash}`,
  invPackagesList: (orgId: string, hash: string) => `inv:packages:list:${orgId}:${hash}`,
  invPackageDetail: (orgId: string, id: number) => `inv:packages:detail:${orgId}:${id}`,
  invShipmentsList: (orgId: string, hash: string) => `inv:shipments:list:${orgId}:${hash}`,
  invShipmentDetail: (orgId: string, id: number) => `inv:shipments:detail:${orgId}:${id}`,
  invLoadsList: (orgId: string, hash: string) => `inv:loads:list:${orgId}:${hash}`,
  invLoadDetail: (orgId: string, id: number) => `inv:loads:detail:${orgId}:${id}`,
  invCarriersList: (orgId: string) => `inv:carriers:${orgId}`,
  invChannelsList: (orgId: string) => `inv:channels:list:${orgId}`,
  invChannelDetail: (orgId: string, id: number) => `inv:channels:detail:${orgId}:${id}`,
  inv3plList: (orgId: string) => `inv:3pl:list:${orgId}`,
  invImportJobsList: (orgId: string, hash: string) => `inv:import-jobs:list:${orgId}:${hash}`,
  invExportJobsList: (orgId: string, hash: string) => `inv:export-jobs:list:${orgId}:${hash}`,
  invSettings: (orgId: string) => `inv:settings:${orgId}`,
  invNumberSequences: (orgId: string) => `inv:numseq:${orgId}`,
  invAiInsightsList: (orgId: string) => `inv:ai-insights:${orgId}`,
  invTraceabilityLot: (orgId: string, lotId: number) => `inv:trace:lot:${orgId}:${lotId}`,
  invTraceabilitySerial: (orgId: string, serialId: number) => `inv:trace:serial:${orgId}:${serialId}`,
  invStockLevelPattern: (orgId: string) => `inv:stock:levels:${orgId}:*`,
  invDashboardPattern: (orgId: string) => `inv:dashboard:${orgId}`,

  featureFlags: () => "feature-flags:all",

  orgBusinessUnits: (orgId: string) => `org:bu:${orgId}`,
  orgBranches: (orgId: string) => `org:branches:${orgId}`,
  orgDepartments: (orgId: string) => `org:depts:${orgId}`,
  orgTeams: (orgId: string) => `org:teams:${orgId}`,
  orgLocations: (orgId: string) => `org:locations:${orgId}`,
  orgCostCenters: (orgId: string) => `org:cost-centers:${orgId}`,

  payrollSummary: (orgId: string, hash: string) => `timesheets:payroll:summary:${orgId}:${hash}`,
  payrollExportsList: (orgId: string, page: number | "*", pageSize: number | "*") =>
    `timesheets:payroll:exports:${orgId}:${page}:${pageSize}`,
  payrollSettings: (orgId: string) => `timesheets:payroll:settings:${orgId}`,
} as const;

export const CACHE_TTL = {
  SHORT: 30,
  MEDIUM: 300,
  LONG: 600,
  HOUR: 3600,
} as const;
