import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AccessService } from "../access/access.service";
import { isScopable } from "../rbac/permissions";
import { ScopedRead } from "../access/scoped-read";

export const REVIEW_PERMISSION = "crm:autonomy:view";

/**
 * The same narrowing the deals list applies, resolved from the review key.
 *
 * A rep restricted to their own deals must not see, in the feed, the actions
 * the system took on everybody else's.
 */
export async function resolveAutonomyReviewScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  if (u.isOrgOwner) return ScopedRead.of(u.orgId, u.userId, "all");
  if (!isScopable(REVIEW_PERMISSION)) return ScopedRead.of(u.orgId, u.userId, "all");
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return ScopedRead.of(u.orgId, u.userId, resolved.get(REVIEW_PERMISSION) ?? "none");
}
