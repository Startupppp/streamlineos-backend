import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import { isScopable } from "../rbac/permissions";

export const PERFORMANCE_PERMISSION = "hr:performance:manage";
export const DOCUMENTS_PERMISSION = "hr:documents:manage";

export async function resolvePerformanceScope(access: AccessService, u: CurrentUserContext): Promise<DataScope> {
  if (u.isOrgOwner) return "all";
  if (!isScopable(PERFORMANCE_PERMISSION)) return "all";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(PERFORMANCE_PERMISSION) ?? "none";
}

export async function resolveDocumentsScope(access: AccessService, u: CurrentUserContext): Promise<DataScope> {
  if (u.isOrgOwner) return "all";
  if (!isScopable(DOCUMENTS_PERMISSION)) return "all";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(DOCUMENTS_PERMISSION) ?? "none";
}
