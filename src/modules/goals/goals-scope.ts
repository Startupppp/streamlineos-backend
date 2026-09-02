import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";

export const GOALS_PERMISSION = "build:goals:manage";

/**
 * `build:goals:manage` carries no `scopable: true` entry, so the old
 * `if (!isScopable(...)) return "all"` fallback was permanently live and every
 * caller resolved `all` — a gate that read as present and admitted everyone.
 * Fail closed instead: the caller gets the scope their grant actually carries,
 * and someone who does not hold the key at all gets `none`.
 */
export async function resolveGoalsScope(access: AccessService, u: CurrentUserContext): Promise<DataScope> {
  if (u.isOrgOwner) return "all";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(GOALS_PERMISSION) ?? "none";
}
