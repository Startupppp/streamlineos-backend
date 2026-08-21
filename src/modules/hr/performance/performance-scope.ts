import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { AccessService } from "../../access/access.service";
import { isScopable } from "../../rbac/permissions";

export const PERFORMANCE_PERMISSION = "hr:performance:manage";
export const DOCUMENTS_PERMISSION = "hr:documents:view";
export const DOCUMENTS_MANAGE_PERMISSION = "hr:documents:manage";

export async function resolvePerformanceScope(access: AccessService, currentUser: CurrentUserContext): Promise<DataScope> {
  if (currentUser.isOrgOwner) return "all";
  if (!isScopable(PERFORMANCE_PERMISSION)) return "none";
  const resolved = await access.resolveUserPermissions(currentUser.orgId, currentUser.userId);
  return resolved.get(PERFORMANCE_PERMISSION) ?? "none";
}

export async function resolveDocumentsScope(
  access: AccessService,
  currentUser: CurrentUserContext,
  resolvedPermissions?: ReadonlyMap<string, DataScope>,
): Promise<DataScope> {
  if (currentUser.isOrgOwner) return "all";
  if (!isScopable(DOCUMENTS_PERMISSION)) return "none";
  const resolved =
    resolvedPermissions ??
    (await access.resolveUserPermissions(currentUser.orgId, currentUser.userId));
  return resolved.get(DOCUMENTS_PERMISSION) ?? "none";
}

export async function resolveDocumentsManageScope(
  access: AccessService,
  currentUser: CurrentUserContext,
): Promise<DataScope> {
  if (currentUser.isOrgOwner) return "all";
  if (!isScopable(DOCUMENTS_MANAGE_PERMISSION)) return "none";
  const resolved = await access.resolveUserPermissions(currentUser.orgId, currentUser.userId);
  return resolved.get(DOCUMENTS_MANAGE_PERMISSION) ?? "none";
}
