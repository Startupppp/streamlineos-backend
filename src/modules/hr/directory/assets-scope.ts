import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";

export const ASSETS_PERMISSION = "hr:assets:manage";

interface PermissionResolver {
  resolveUserPermissions(orgId: string, userId: string): Promise<Map<string, DataScope>>;
}

/**
 * `hr:assets:manage` carries no `scopable: true` entry, so the old
 * `if (!isScopable(...)) return "all"` fallback was permanently live and every
 * holder of the *view* key this route gates on resolved `all`. Fail closed: the
 * grant's own scope decides, and a non-holder gets `none`.
 */
export async function resolveAssetsScope(
  access: PermissionResolver,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (u.isOrgOwner) return "all";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(ASSETS_PERMISSION) ?? "none";
}
