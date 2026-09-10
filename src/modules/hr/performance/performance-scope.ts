import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { AccessService } from "../../access/access.service";
import { isScopable } from "../../rbac/permissions";
import { ScopedRead } from "../../access/scoped-read";

export const PERFORMANCE_PERMISSION = "hr:performance:manage";
export const DOCUMENTS_PERMISSION = "hr:documents:view";
export const DOCUMENTS_MANAGE_PERMISSION = "hr:documents:manage";

export async function resolvePerformanceScope(access: AccessService, currentUser: CurrentUserContext): Promise<ScopedRead> {
  if (currentUser.isOrgOwner) return ScopedRead.of(currentUser.orgId, currentUser.userId, "all");
  if (!isScopable(PERFORMANCE_PERMISSION)) return ScopedRead.of(currentUser.orgId, currentUser.userId, "none");
  const resolved = await access.resolveUserPermissions(currentUser.orgId, currentUser.userId);
  return ScopedRead.of(currentUser.orgId, currentUser.userId, resolved.get(PERFORMANCE_PERMISSION) ?? "none");
}

export async function resolveDocumentsScope(
  access: AccessService,
  currentUser: CurrentUserContext,
  resolvedPermissions?: ReadonlyMap<string, DataScope>,
): Promise<ScopedRead> {
  if (currentUser.isOrgOwner) return ScopedRead.of(currentUser.orgId, currentUser.userId, "all");
  if (!isScopable(DOCUMENTS_PERMISSION)) return ScopedRead.of(currentUser.orgId, currentUser.userId, "none");
  const resolved =
    resolvedPermissions ??
    (await access.resolveUserPermissions(currentUser.orgId, currentUser.userId));
  return ScopedRead.of(currentUser.orgId, currentUser.userId, resolved.get(DOCUMENTS_PERMISSION) ?? "none");
}

export async function resolveDocumentsManageScope(
  access: AccessService,
  currentUser: CurrentUserContext,
): Promise<ScopedRead> {
  if (currentUser.isOrgOwner) return ScopedRead.of(currentUser.orgId, currentUser.userId, "all");
  if (!isScopable(DOCUMENTS_MANAGE_PERMISSION)) return ScopedRead.of(currentUser.orgId, currentUser.userId, "none");
  const resolved = await access.resolveUserPermissions(currentUser.orgId, currentUser.userId);
  return ScopedRead.of(currentUser.orgId, currentUser.userId, resolved.get(DOCUMENTS_MANAGE_PERMISSION) ?? "none");
}
