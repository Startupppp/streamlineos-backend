import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import { isScopable } from "../rbac/permissions";

export const CLIENTS_READ_PERMISSION = "crm:clients:read";

export async function resolveClientsReadScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (u.isOrgOwner) return "all";
  if (!isScopable(CLIENTS_READ_PERMISSION)) return "all";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(CLIENTS_READ_PERMISSION) ?? "none";
}
