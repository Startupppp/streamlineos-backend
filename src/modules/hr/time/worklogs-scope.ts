import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { isScopable } from "../../rbac/permissions";
import { ScopedRead } from "../../access/scoped-read";

export const WORKLOGS_PERMISSION = "hr:attendance:manage";

export async function resolveWorkLogsScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  if (u.isOrgOwner) return ScopedRead.of(u.orgId, u.userId, "all");
  if (!isScopable(WORKLOGS_PERMISSION)) return ScopedRead.of(u.orgId, u.userId, "all");
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return ScopedRead.of(u.orgId, u.userId, resolved.get(WORKLOGS_PERMISSION) ?? "none");
}
