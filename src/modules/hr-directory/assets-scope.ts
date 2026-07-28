import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { isScopable } from "../rbac/permissions";

export const ASSETS_PERMISSION = "hr:assets:manage";

interface PermissionResolver {
  resolveUserPermissions(orgId: string, userId: string): Promise<Map<string, DataScope>>;
}

export async function resolveAssetsScope(
  access: PermissionResolver,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (u.isPlatformAdmin || u.isOrgOwner) return "all";
  if (!isScopable(ASSETS_PERMISSION)) return "all";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(ASSETS_PERMISSION) ?? "none";
}
