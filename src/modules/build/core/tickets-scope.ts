import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { ScopedRead, type OwnershipScope } from "../../access/scoped-read";
import { eq, or, sql } from "drizzle-orm";
import { tickets, ticketAssignees } from "../../../db/schema";

export const TICKETS_PERMISSION = "build:tickets:view";

export function ticketScope(orgId: string, userId: string): OwnershipScope {
  return {
    own: sql`${or(
      sql`${tickets.assigneeMembershipId} IN (SELECT id FROM organization_members WHERE org_id = ${orgId} AND user_id = ${userId} AND status = 'ACTIVE')`,
      eq(tickets.reporterId, userId),
      sql`EXISTS (SELECT 1 FROM ${ticketAssignees} ta JOIN organization_members om ON om.org_id = ta.org_id AND om.id = ta.membership_id WHERE ta.org_id = ${orgId} AND om.user_id = ${userId} AND ta.ticket_id = ${tickets.id})`,
    )}`,
  };
}

export async function resolveTicketsScope(
  access: Pick<AccessService, "scopeFor">,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  return ScopedRead.for(access, u, TICKETS_PERMISSION);
}

export async function ticketsScopeIsUnrestricted(
  access: Pick<AccessService, "scopeFor">,
  u: CurrentUserContext,
): Promise<boolean> {
  return (await access.scopeFor(u, TICKETS_PERMISSION)) === "all";
}
