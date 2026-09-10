import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ScopedRead } from "../access/scoped-read";
import { AccessService } from "../access/access.service";

export const GOALS_PERMISSION = "build:goals:manage";

/**
 * `build:goals:manage` carries no `scopable: true` entry, so the old
 * `if (!isScopable(...)) return "all"` fallback was permanently live and every
 * caller resolved `all` — a gate that read as present and admitted everyone.
 */
export async function resolveGoalsScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  if (u.isOrgOwner) return ScopedRead.of(u.orgId, u.userId, "all");
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return ScopedRead.of(u.orgId, u.userId, resolved.get(GOALS_PERMISSION) ?? "none");
}
