export const CACHE_KEYS = {

  dashboardStats: (orgId: string) => `dashboard:stats:${orgId}`,
  userProfile: (userId: string) => `user:profile:${userId}`,
  userSession: (userId: string) => `user:session:${userId}`,
  userPermissions: (userId: string) => `user:permissions:${userId}`,
  unreadNotifications: (userId: string) => `notifications:unread:${userId}`,

  orgSettings: (orgId: string) => `org:settings:${orgId}`,
  rolePermissions: (orgId: string, role: string) => `org:roles:${orgId}:${role}`,
  rolesList: (orgId: string) => `org:roles:${orgId}`,

  leadsCount: (orgId: string) => `leads:count:${orgId}`,
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

  targetsList: (orgId: string, hash: string) => `targets:list:${orgId}:${hash}`,
  targetLeaderboard: (orgId: string, metricType: string) => `targets:leaderboard:${orgId}:${metricType}`,

  branchesList: (orgId: string) => `branches:list:${orgId}`,
  rolesList2: (orgId: string) => `roles:list:${orgId}`,

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

  featureFlags: () => "feature-flags:all",
  featureFlagsOrg: (orgId: string) => `feature-flags:org:${orgId}`,

  orgBusinessUnits: (orgId: string) => `org:bu:${orgId}`,
  orgBranches: (orgId: string) => `org:branches:${orgId}`,
  orgDepartments: (orgId: string) => `org:depts:${orgId}`,
  orgTeams: (orgId: string) => `org:teams:${orgId}`,
  orgLocations: (orgId: string) => `org:locations:${orgId}`,
  orgCostCenters: (orgId: string) => `org:cost-centers:${orgId}`,
} as const;

export const CACHE_TTL = {
  SHORT: 30,
  MEDIUM: 300,
  LONG: 600,
  HOUR: 3600,
} as const;
