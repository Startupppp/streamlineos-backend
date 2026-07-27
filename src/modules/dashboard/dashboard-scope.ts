import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import { isScopable } from "../rbac/permissions.constants";

export const DASHBOARD_EMPLOYEES_PERMISSION = "hr:employees:manage";
export const DASHBOARD_LEAVES_PERMISSION = "hr:leaves:approve";

export async function resolveEmployeesDashboardScope(access: AccessService, u: CurrentUserContext): Promise<DataScope> {
  if (u.isPlatformAdmin || u.isOrgOwner) return "all";
  if (!isScopable(DASHBOARD_EMPLOYEES_PERMISSION)) return "all";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(DASHBOARD_EMPLOYEES_PERMISSION) ?? "none";
}

export async function resolveLeavesDashboardScope(access: AccessService, u: CurrentUserContext): Promise<DataScope> {
  if (u.isPlatformAdmin || u.isOrgOwner) return "all";
  if (!isScopable(DASHBOARD_LEAVES_PERMISSION)) return "all";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(DASHBOARD_LEAVES_PERMISSION) ?? "none";
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
  if (u.isPlatformAdmin || u.isOrgOwner) {
    return { employees: true, attendance: true, projects: true };
  }
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  const granted = (key: string) => (resolved.get(key) ?? "none") !== "none";
  return {
    employees: granted("hr:employees:view"),
    attendance: granted("hr:attendance:view"),
    projects: granted("build:tickets:view"),
  };
}
