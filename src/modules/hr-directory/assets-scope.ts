import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import { isScopable } from "../rbac/permissions.constants";

export const ASSETS_PERMISSION = "hr:assets:manage";

export async function resolveAssetsScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (u.isPlatformAdmin || u.isOrgOwner) return "all";
  if (!isScopable(ASSETS_PERMISSION)) return "all";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(ASSETS_PERMISSION) ?? "none";
}
