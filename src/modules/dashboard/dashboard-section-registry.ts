/**
 * `cacheScope` names the dashboard-home key family a section's read uses, so a
 * declaration cannot drift from the implementation: "org" and "scoped" select
 * the two typed builders in `dashboard-cache-key.ts`, and "none" says this
 * section does not read through that family at all — it is either uncached or
 * cached under a key its owning module defines.
 */
export type DashboardCacheScope = "org" | "scoped" | "none";

export interface UniversalSection {
  readonly key: string;
  readonly kind: "universal";
  readonly cacheNs: string;
  readonly cacheScope: DashboardCacheScope;
  readonly routePath?: string;
}

export interface ModuleSection {
  readonly key: string;
  readonly kind: "module";
  readonly module: string;
  readonly cacheNs: string;
  readonly cacheScope: DashboardCacheScope;
  readonly routePath?: string;
}

/**
 * `module` is separate from `kind`. Seven Home routes carry BOTH `@RequireModule`
 * and `@RequirePermission`, and a registry that could only say "permission"
 * described the permission and silently dropped the module gate — so the registry
 * disagreed with the generated Home manifest, which reads both off the controller.
 */
export interface PermissionSection {
  readonly key: string;
  readonly kind: "permission";
  readonly permission: string;
  readonly module?: string;
  readonly cacheScope: DashboardCacheScope;
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

const SECTIONS = [
  { key: "announcements",         kind: "universal",   cacheScope: "none",   cacheNs: "announcements",         routePath: "announcements" },
  { key: "upcoming-events",       kind: "universal",   cacheScope: "none",   cacheNs: "upcoming-events" },
  { key: "unread-notifications",  kind: "universal",   cacheScope: "none",   cacheNs: "unread-notifications" },

  { key: "birthdays",             kind: "module",  module: "hr",         cacheScope: "org",    cacheNs: "birthdays",         routePath: "birthdays" },
  { key: "my-issues",             kind: "module",  module: "build",      cacheScope: "none",   cacheNs: "my-issues",         routePath: "my-issues" },
  { key: "upcoming-holidays",     kind: "module",  module: "hr",         cacheScope: "org",    cacheNs: "holidays",          routePath: "upcoming-holidays" },
  { key: "active-sprint",         kind: "module",  module: "build",      cacheScope: "none",   cacheNs: "active-sprint",     routePath: "active-sprint" },
  { key: "my-tasks",              kind: "module",  module: "build",      cacheScope: "none",   cacheNs: "my-tasks" },
  { key: "timesheet-status",      kind: "module",  module: "timesheets", cacheScope: "none",   cacheNs: "timesheet-status" },
  { key: "leave-balance",         kind: "module",  module: "hr",         cacheScope: "scoped", cacheNs: "leave-balance",     routePath: "my-leave-balance" },

  { key: "stats-employees",   kind: "permission",  permission: "hr:employees:view",    cacheScope: "org",    cacheNs: "stats-employees" },
  { key: "stats-attendance",  kind: "permission",  permission: "hr:attendance:manage", cacheScope: "org",    cacheNs: "stats-attendance" },
  { key: "stats-projects",    kind: "permission",  permission: "build:tickets:view",   cacheScope: "org",    cacheNs: "stats-projects" },
  { key: "team-availability", kind: "permission",  permission: "hr:attendance:view",   module: "hr",    cacheScope: "scoped", cacheNs: "availability",      routePath: "team-availability" },
  { key: "team-attendance",   kind: "permission",  permission: "hr:attendance:view",   module: "hr",    cacheScope: "scoped", cacheNs: "attendance",        routePath: "team-attendance" },
  { key: "leaves-today",      kind: "permission",  permission: "hr:leaves:view",       module: "hr",    cacheScope: "none",   cacheNs: "leaves-today",      routePath: "leaves-today" },
  { key: "pending-approvals", kind: "permission",  permission: "hr:leaves:approve",    module: "hr",    cacheScope: "scoped", cacheNs: "pending-approvals", routePath: "pending-approvals" },
  { key: "crm-executive",     kind: "permission",  permission: "hr:analytics:read",                     cacheScope: "org",    cacheNs: "crm-executive",     routePath: "executive" },
  { key: "crm-pulse",        kind: "permission",  permission: "crm:leads:view",       module: "crm",   cacheScope: "org",    cacheNs: "crm-pulse",         routePath: "crm-pulse" },
  { key: "recent-projects",   kind: "permission",  permission: "build:tickets:view",   module: "build", cacheScope: "none",   cacheNs: "recent-projects",   routePath: "recent-projects" },
  { key: "recent-activity",   kind: "permission",  permission: "build:tickets:view",   module: "build", cacheScope: "none",   cacheNs: "recent-activity",   routePath: "recent-activity" },
  { key: "today-activities",  kind: "permission",  permission: "crm:leads:view",       module: "crm",   cacheScope: "none",   cacheNs: "today-activities",  routePath: "today-activities" },
  { key: "personal",          kind: "universal",   cacheScope: "none",  cacheNs: "personal",  routePath: "personal" },
  { key: "stats",             kind: "universal",   cacheScope: "org",   cacheNs: "stats",     routePath: "stats" },
] as const satisfies readonly DashboardSection[];

export const DASHBOARD_HOME_SECTIONS: readonly DashboardSection[] = SECTIONS;

type SectionLiteral = (typeof SECTIONS)[number];

export type DashboardSectionKey = SectionLiteral["key"];
export type OrgCachedSectionKey = Extract<SectionLiteral, { cacheScope: "org" }>["key"];
export type ScopedCachedSectionKey = Extract<SectionLiteral, { cacheScope: "scoped" }>["key"];

/**
 * The one place a Home cache namespace comes from. A section's `cacheNs` is
 * therefore read by production code, not just asserted non-empty by a test.
 */
export function cacheNamespaceOf(key: DashboardSectionKey): string {
  const section = SECTIONS.find((s) => s.key === key);
  if (!section) throw new Error(`Dashboard registry: unknown section '${key}'`);
  return section.cacheNs;
}

export function cacheScopeOf(key: DashboardSectionKey): DashboardCacheScope {
  const section = SECTIONS.find((s) => s.key === key);
  if (!section) throw new Error(`Dashboard registry: unknown section '${key}'`);
  return section.cacheScope;
}
