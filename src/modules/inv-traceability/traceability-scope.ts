import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import { isScopable } from "../rbac/permissions.constants";

async function resolveScope(
  permission: string,
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (u.isPlatformAdmin || u.isOrgOwner) return "all";
  if (!isScopable(permission)) return "all";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(permission) ?? "none";
}

export function resolveTraceabilityScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  return resolveScope("inventory:stock:read", access, u);
}
