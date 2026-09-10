import { sql } from "drizzle-orm";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ScopedRead, type ScopeShape } from "../../access/scoped-read";
import { AccessService } from "../../access/access.service";
import { supportTickets } from "../../../db/schema";
import { isScopable } from "../../rbac/permissions";

export const SUPPORT_TICKETS_VIEW_PERMISSION = "support:tickets:view";

export async function resolveSupportTicketsViewScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  if (u.isOrgOwner) return ScopedRead.of(u.orgId, u.userId, "all");
  if (!isScopable(SUPPORT_TICKETS_VIEW_PERMISSION)) return ScopedRead.of(u.orgId, u.userId, "all");
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return ScopedRead.of(u.orgId, u.userId, resolved.get(SUPPORT_TICKETS_VIEW_PERMISSION) ?? "none");
}

// Ownership here is the assignee membership, not a user column, so it is a domain predicate rather than a ScopeColumns pair.
export function supportTicketScope(orgId: string, userId: string): ScopeShape {
  return {
    own: sql`${supportTickets.assigneeMembershipId} IN (SELECT id FROM organization_members WHERE org_id = ${orgId} AND user_id = ${userId} AND status = 'ACTIVE')`,
  };
}
