import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import { isScopable } from "../rbac/permissions.constants";

export const TS_TEAM_VIEW_PERMISSION = "timesheets:team:view";
export const TS_APPROVALS_VIEW_PERMISSION = "timesheets:approvals:view";
export const TS_REPORTS_VIEW_PERMISSION = "timesheets:reports:view";

export async function resolveEntriesScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (u.isPlatformAdmin || u.isOrgOwner) return "all";
  if (!isScopable(TS_TEAM_VIEW_PERMISSION)) return "own";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  const teamScope = resolved.get(TS_TEAM_VIEW_PERMISSION);
  if (teamScope && teamScope !== "none") return teamScope;
  return "own";
}

export async function resolveApprovalScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (u.isPlatformAdmin || u.isOrgOwner) return "all";
  if (!isScopable(TS_APPROVALS_VIEW_PERMISSION)) return "all";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(TS_APPROVALS_VIEW_PERMISSION) ?? "none";
}

export async function resolveReportsScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (u.isPlatformAdmin || u.isOrgOwner) return "all";
  if (!isScopable(TS_REPORTS_VIEW_PERMISSION)) return "all";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(TS_REPORTS_VIEW_PERMISSION) ?? "own";
}
