import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ScopedRead } from "../access/scoped-read";
import { AccessService } from "../access/access.service";
import { isScopable } from "../rbac/permissions";

export const LEADS_VIEW_PERMISSION = "crm:leads:view";

export async function resolveLeadsViewScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  if (u.isOrgOwner) return ScopedRead.of(u.orgId, u.userId, "all");
  if (!isScopable(LEADS_VIEW_PERMISSION)) return ScopedRead.of(u.orgId, u.userId, "all");
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return ScopedRead.of(u.orgId, u.userId, resolved.get(LEADS_VIEW_PERMISSION) ?? "none");
}
