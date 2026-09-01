export interface UniversalSection {
  readonly key: string;
  readonly kind: "universal";
  readonly cacheNs: string;
  readonly routePath?: string;
}

export interface ModuleSection {
  readonly key: string;
  readonly kind: "module";
  readonly module: string;
  readonly cacheNs: string;
  readonly routePath?: string;
}

export interface PermissionSection {
  readonly key: string;
  readonly kind: "permission";
  readonly permission: string;
  readonly cacheScope: "org" | "scoped";
  readonly cacheNs: string;
  readonly routePath?: string;
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
  { key: "announcements",         kind: "universal",   cacheNs: "announcements",         routePath: "announcements" },
  { key: "upcoming-events",       kind: "universal",   cacheNs: "upcoming-events" },
  { key: "unread-notifications",  kind: "universal",   cacheNs: "unread-notifications" },

  { key: "birthdays",             kind: "module",  module: "hr",         cacheNs: "birthdays",         routePath: "birthdays" },
  { key: "my-issues",             kind: "module",  module: "build",      cacheNs: "my-issues",         routePath: "my-issues" },
  { key: "upcoming-holidays",     kind: "module",  module: "hr",         cacheNs: "holidays",          routePath: "upcoming-holidays" },
  { key: "active-sprint",         kind: "module",  module: "build",      cacheNs: "active-sprint",     routePath: "active-sprint" },
  { key: "my-tasks",              kind: "module",  module: "build",      cacheNs: "my-tasks" },
  { key: "timesheet-status",      kind: "module",  module: "timesheets", cacheNs: "timesheet-status" },
  { key: "leave-balance",         kind: "module",  module: "hr",         cacheNs: "leave-balance",     routePath: "my-leave-balance" },

  { key: "stats-employees",   kind: "permission",  permission: "hr:employees:view",    cacheScope: "org",    cacheNs: "stats-employees" },
  { key: "stats-attendance",  kind: "permission",  permission: "hr:attendance:manage", cacheScope: "org",    cacheNs: "stats-attendance" },
  { key: "stats-projects",    kind: "permission",  permission: "build:tickets:view",   cacheScope: "org",    cacheNs: "stats-projects" },
  { key: "team-availability", kind: "permission",  permission: "hr:attendance:view",   cacheScope: "scoped", cacheNs: "availability",      routePath: "team-availability" },
  { key: "team-attendance",   kind: "permission",  permission: "hr:attendance:view",   cacheScope: "scoped", cacheNs: "attendance",        routePath: "team-attendance" },
  { key: "leaves-today",      kind: "permission",  permission: "hr:leaves:view",       cacheScope: "scoped", cacheNs: "leaves-today",      routePath: "leaves-today" },
  { key: "pending-approvals", kind: "permission",  permission: "hr:leaves:approve",    cacheScope: "scoped", cacheNs: "pending-approvals", routePath: "pending-approvals" },
  { key: "crm-executive",     kind: "permission",  permission: "hr:analytics:read",    cacheScope: "org",    cacheNs: "crm-executive",     routePath: "executive" },
  { key: "recent-projects",   kind: "permission",  permission: "build:tickets:view",   cacheScope: "scoped", cacheNs: "recent-projects",   routePath: "recent-projects" },
];
