import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import { isScopable } from "../rbac/permissions.constants";

export const SUPPORT_TICKETS_VIEW_PERMISSION = "support:tickets:view";

export async function resolveSupportTicketsViewScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (u.isPlatformAdmin || u.isOrgOwner) return "all";
  if (!isScopable(SUPPORT_TICKETS_VIEW_PERMISSION)) return "all";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(SUPPORT_TICKETS_VIEW_PERMISSION) ?? "none";
}
