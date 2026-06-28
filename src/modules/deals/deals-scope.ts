import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import { isScopable } from "../rbac/permissions.constants";

export const DEALS_READ_PERMISSION = "crm:deals:read";

export async function resolveDealsReadScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (u.isPlatformAdmin || u.isOrgOwner) return "all";
  if (!isScopable(DEALS_READ_PERMISSION)) return "all";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(DEALS_READ_PERMISSION) ?? "none";
}
