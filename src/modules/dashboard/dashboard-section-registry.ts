export interface UniversalSection {
  readonly key: string;
  readonly kind: "universal";
  readonly cacheNs: string;
}

export interface ModuleSection {
  readonly key: string;
  readonly kind: "module";
  readonly module: string;
  readonly cacheNs: string;
}

export interface PermissionSection {
  readonly key: string;
  readonly kind: "permission";
  readonly permission: string;
  readonly cacheScope: "org" | "scoped";
  readonly cacheNs: string;
}

export type DashboardSection = UniversalSection | ModuleSection | PermissionSection;

export function isPermissionSection(s: DashboardSection): s is PermissionSection {
  return s.kind === "permission";
}

export function isModuleSection(s: DashboardSection): s is ModuleSection {
  return s.kind === "module";
}

export function permissionOf(key: string): string {
  const section = DASHBOARD_HOME_SECTIONS.find((s) => s.key === key);
  if (!section || !isPermissionSection(section)) {
    throw new Error(`Dashboard registry: '${key}' is not a permission section`);
  }
  return section.permission;
}

export const DASHBOARD_HOME_SECTIONS: readonly DashboardSection[] = [
  { key: "announcements",         kind: "universal",   cacheNs: "announcements" },
  { key: "upcoming-events",       kind: "universal",   cacheNs: "upcoming-events" },
  { key: "unread-notifications",  kind: "universal",   cacheNs: "unread-notifications" },
  { key: "birthdays",             kind: "universal",   cacheNs: "birthdays" },
  { key: "my-issues",             kind: "universal",   cacheNs: "my-issues" },
  { key: "upcoming-holidays",     kind: "universal",   cacheNs: "holidays" },

  { key: "my-tasks",              kind: "module",      module: "build",       cacheNs: "my-tasks" },
  { key: "timesheet-status",      kind: "module",      module: "timesheets",  cacheNs: "timesheet-status" },
  { key: "leave-balance",         kind: "module",      module: "hr",          cacheNs: "leave-balance" },

  { key: "stats-employees",       kind: "permission",  permission: "hr:employees:view",    cacheScope: "org",    cacheNs: "stats-employees" },
  { key: "stats-attendance",      kind: "permission",  permission: "hr:attendance:manage", cacheScope: "org",    cacheNs: "stats-attendance" },
  { key: "stats-projects",        kind: "permission",  permission: "build:tickets:view",   cacheScope: "org",    cacheNs: "stats-projects" },
  { key: "team-availability",     kind: "permission",  permission: "hr:attendance:manage", cacheScope: "scoped", cacheNs: "availability" },
  { key: "team-attendance",       kind: "permission",  permission: "hr:attendance:manage", cacheScope: "scoped", cacheNs: "attendance" },
  { key: "leaves-today",          kind: "permission",  permission: "hr:leaves:approve",    cacheScope: "scoped", cacheNs: "leaves-today" },
  { key: "pending-approvals",     kind: "permission",  permission: "hr:leaves:approve",    cacheScope: "scoped", cacheNs: "pending-approvals" },
  { key: "crm-executive",         kind: "permission",  permission: "crm:leads:view",       cacheScope: "org",    cacheNs: "crm-executive" },
  { key: "recent-projects",       kind: "permission",  permission: "build:manage",         cacheScope: "scoped", cacheNs: "recent-projects" },
  { key: "active-sprint",         kind: "permission",  permission: "build:manage",         cacheScope: "scoped", cacheNs: "active-sprint" },
];
