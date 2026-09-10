import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { AccessService } from "../../access/access.service";
import { isScopable } from "../../rbac/permissions";
import { ScopedRead, type ScopeActor } from "../../access/scoped-read";

export const EMPLOYEES_VIEW_PERMISSION = "hr:employees:view";
export const EMPLOYEES_MANAGE_PERMISSION = "hr:employees:manage";

async function resolveEmployeePermissionScope(
  access: AccessService,
  currentUser: CurrentUserContext,
  permission: string,
): Promise<DataScope> {
  if (currentUser.isOrgOwner) return "all";
  if (!isScopable(permission)) return "all";
  const resolved = await access.resolveUserPermissions(
    currentUser.orgId,
    currentUser.userId,
  );
  return resolved.get(permission) ?? "none";
}

export async function resolveEmployeesScope(
  access: AccessService,
  currentUser: CurrentUserContext,
): Promise<ScopedRead> {
  const scope = await resolveEmployeePermissionScope(
    access,
    currentUser,
    EMPLOYEES_VIEW_PERMISSION,
  );
  return ScopedRead.of(currentUser.orgId, currentUser.userId, scope);
}

export async function resolveEmployeesManageScope(
  access: AccessService,
  currentUser: CurrentUserContext,
): Promise<ScopedRead> {
  const scope = await resolveEmployeePermissionScope(
    access,
    currentUser,
    EMPLOYEES_MANAGE_PERMISSION,
  );
  return ScopedRead.of(currentUser.orgId, currentUser.userId, scope);
}

/** A member updating their own record keeps an own-scoped read even when they hold no manage grant. */
export function selfEmployeeRead(actor: ScopeActor): ScopedRead {
  return ScopedRead.of(actor.orgId, actor.userId, "own");
}
