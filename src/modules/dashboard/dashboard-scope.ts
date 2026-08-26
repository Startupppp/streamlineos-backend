import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import { isScopable } from "../rbac/permissions";

export const DASHBOARD_EMPLOYEES_PERMISSION = "hr:employees:manage";
export const DASHBOARD_LEAVES_PERMISSION = "hr:leaves:approve";

export async function resolveEmployeesDashboardScope(access: AccessService, u: CurrentUserContext): Promise<DataScope> {
  if (!isScopable(DASHBOARD_EMPLOYEES_PERMISSION)) return "all";
  return access.scopeFor(u, DASHBOARD_EMPLOYEES_PERMISSION);
}

export async function resolveLeavesDashboardScope(access: AccessService, u: CurrentUserContext): Promise<DataScope> {
  if (!isScopable(DASHBOARD_LEAVES_PERMISSION)) return "all";
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
  const [build, timesheets, hr] = await Promise.all([
    access.moduleAvailability(u, "build"),
    access.moduleAvailability(u, "timesheets"),
    access.moduleAvailability(u, "hr"),
  ]);
  return {
    build: build.available,
    timesheets: timesheets.available,
    hr: hr.available,
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
  return {
    employees: await granted("hr:employees:view"),
    attendance: await granted("hr:attendance:view"),
    projects: await granted("build:tickets:view"),
  };
}
