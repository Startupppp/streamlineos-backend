import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { AccessService } from "../../access/access.service";
import { isScopable } from "../../rbac/permissions";

export const EMPLOYEES_VIEW_PERMISSION = "hr:employees:view";
export const EMPLOYEES_MANAGE_PERMISSION = "hr:employees:manage";

async function resolveEmployeePermissionScope(
  access: AccessService,
  currentUser: CurrentUserContext,
  permission: string,
): Promise<DataScope> {
  if (currentUser.isOrgOwner) return "all";
  if (!isScopable(permission)) return "all";
  const resolved = await access.resolveUserPermissions(currentUser.orgId, currentUser.userId);
  return resolved.get(permission) ?? "none";
}

export function resolveEmployeesScope(
  access: AccessService,
  currentUser: CurrentUserContext,
): Promise<DataScope> {
  return resolveEmployeePermissionScope(access, currentUser, EMPLOYEES_VIEW_PERMISSION);
}

export function resolveEmployeesManageScope(
  access: AccessService,
  currentUser: CurrentUserContext,
): Promise<DataScope> {
  return resolveEmployeePermissionScope(access, currentUser, EMPLOYEES_MANAGE_PERMISSION);
}
