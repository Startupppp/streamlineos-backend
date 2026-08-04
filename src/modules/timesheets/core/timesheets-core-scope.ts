import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { AccessService } from "../../access/access.service";
import { isScopable } from "../../rbac/permissions";

export const TS_TEAM_VIEW_PERMISSION = "timesheets:team:view";
export const TS_APPROVALS_VIEW_PERMISSION = "timesheets:approvals:view";
export const TS_REPORTS_VIEW_PERMISSION = "timesheets:reports:view";
export const TS_PAYROLL_VIEW_PERMISSION = "timesheets:payroll:view";

export async function resolveEntriesScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (u.isOrgOwner) return "all";
  if (!isScopable(TS_TEAM_VIEW_PERMISSION)) return "none";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  const teamScope = resolved.get(TS_TEAM_VIEW_PERMISSION);
  if (teamScope && teamScope !== "none") return teamScope;
  return "none";
}

export async function resolveApprovalScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (u.isOrgOwner) return "all";
  if (!isScopable(TS_APPROVALS_VIEW_PERMISSION)) return "none";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(TS_APPROVALS_VIEW_PERMISSION) ?? "none";
}

export async function resolveReportsScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (u.isOrgOwner) return "all";
  if (!isScopable(TS_REPORTS_VIEW_PERMISSION)) return "none";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(TS_REPORTS_VIEW_PERMISSION) ?? "none";
}

export async function resolvePayrollScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (u.isOrgOwner) return "all";
  if (!isScopable(TS_PAYROLL_VIEW_PERMISSION)) return "none";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(TS_PAYROLL_VIEW_PERMISSION) ?? "none";
}
