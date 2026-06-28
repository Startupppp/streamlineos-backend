import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import { isScopable } from "../rbac/permissions.constants";

export const REPORTS_ATTENDANCE_PERMISSION = "hr:attendance:view";
export const REPORTS_PAYROLL_PERMISSION = "hr:payroll:view";

export async function resolveAttendanceReportScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (u.isPlatformAdmin || u.isOrgOwner) return "all";
  if (!isScopable(REPORTS_ATTENDANCE_PERMISSION)) return "all";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(REPORTS_ATTENDANCE_PERMISSION) ?? "none";
}

export async function resolvePayrollReportScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (u.isPlatformAdmin || u.isOrgOwner) return "all";
  if (!isScopable(REPORTS_PAYROLL_PERMISSION)) return "all";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(REPORTS_PAYROLL_PERMISSION) ?? "none";
}
