import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ScopedRead } from "../access/scoped-read";
import { AccessService } from "../access/access.service";
import { isScopable } from "../rbac/permissions";

export const DEALS_READ_PERMISSION = "crm:deals:read";

export async function resolveDealsReadScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  if (u.isOrgOwner) return ScopedRead.of(u.orgId, u.userId, "all");
  if (!isScopable(DEALS_READ_PERMISSION)) return ScopedRead.of(u.orgId, u.userId, "all");
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return ScopedRead.of(u.orgId, u.userId, resolved.get(DEALS_READ_PERMISSION) ?? "none");
}

/**
 * A read whose answer is the organisation's by definition.
 *
 * Used by the forecast SNAPSHOT paths. A snapshot is an organisation-level
 * artifact — it is captured for a period, compared against later, and overridden
 * by a manager — so it must be the same quantity no matter who pressed the
 * button, or two snapshots of one period would disagree because two different
 * people took them. Those routes are gated on `crm:deals:forecast` and
 * `crm:deals:manage`, neither of which the catalog declares scopable, which is
 * the same statement in the permission catalog.
 *
 * Here rather than in `deals-forecast.service.ts`, because a constant answer is
 * still a resolved one and the resolver layer is where a `DataScope` becomes a
 * read — ADR 0005. A `ScopedRead` at `all` compiles to `true` and never reads
 * its actor, so the empty actor is unreachable rather than a placeholder that
 * might leak.
 */
export function orgWideDealsRead(orgId: string): ScopedRead {
  return ScopedRead.of(orgId, "", "all");
}
