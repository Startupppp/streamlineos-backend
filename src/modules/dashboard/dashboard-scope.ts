import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import { resolveAttendanceReadScope } from "../hr/time/attendance-scope";
import {
  DASHBOARD_HOME_SECTIONS,
  isModuleSection,
  permissionOf,
  type ModuleSection,
} from "./dashboard-section-registry";

export const DASHBOARD_LEAVES_PERMISSION = permissionOf("leaves-today");
export const DASHBOARD_BUILD_PERMISSION = permissionOf("recent-projects");

/**
 * Neither `build:tickets:view` nor `hr:leaves:view` carries `scopable: true`, so
 * the old `if (!isScopable(...)) return "all"` fallback was permanently live and
 * both dashboard sections resolved `all` for every caller. `scopeFor` already
 * answers `all` for an org owner and `none` for a non-holder, so the fallback
 * was pure fail-open.
 */
export async function resolveBuildDashboardScope(access: AccessService, u: CurrentUserContext): Promise<DataScope> {
  return access.scopeFor(u, DASHBOARD_BUILD_PERMISSION);
}

export async function resolveLeavesDashboardScope(access: AccessService, u: CurrentUserContext): Promise<DataScope> {
  return access.scopeFor(u, DASHBOARD_LEAVES_PERMISSION);
}

export interface PersonalDashboardModules {
  build: boolean;
  timesheets: boolean;
  hr: boolean;
}

export async function resolvePersonalDashboardModules(
  access: AccessService,
  u: CurrentUserContext,
): Promise<PersonalDashboardModules> {
  const moduleSections = DASHBOARD_HOME_SECTIONS.filter(isModuleSection) as ModuleSection[];
  const moduleKeys = [...new Set(moduleSections.map((s) => s.module))];
  const results = await Promise.all(
    moduleKeys.map((key) => access.moduleAvailability(u, key)),
  );
  const available = new Map(moduleKeys.map((key, i) => [key, results[i]?.available ?? false]));
  return {
    build: available.get("build") ?? false,
    timesheets: available.get("timesheets") ?? false,
    hr: available.get("hr") ?? false,
  };
}

export interface DashboardStatsFlags {
  employees: boolean;
  attendance: boolean;
  projects: boolean;
}

export async function resolveDashboardStatsFlags(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DashboardStatsFlags> {
  const granted = (key: string) => access.scopeFor(u, key).then((scope) => scope !== "none");
  const [employees, attendanceScope, projects] = await Promise.all([
    granted(permissionOf("stats-employees")),
    resolveAttendanceReadScope(access, u),
    granted(permissionOf("stats-projects")),
  ]);
  return {
    employees,
    attendance: attendanceScope === "all",
    projects,
  };
}
