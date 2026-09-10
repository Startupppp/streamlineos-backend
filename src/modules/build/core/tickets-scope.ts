import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope, ScopePredicate } from "../../access/access.types";
import { AccessService } from "../../access/access.service";
import { eq, or, sql } from "drizzle-orm";
import { tickets, ticketAssignees } from "../../../db/schema";

export const TICKETS_PERMISSION = "build:manage";

export function ticketScopePredicate(
  scope: DataScope,
  orgId: string,
  userId: string,
): ScopePredicate | undefined {
  if (scope === "none") return sql`false`;
  if (scope === "all") return undefined;
  return or(
    sql`${tickets.assigneeMembershipId} IN (SELECT id FROM organization_members WHERE org_id = ${orgId} AND user_id = ${userId} AND status = 'ACTIVE')`,
    eq(tickets.reporterId, userId),
    sql`EXISTS (SELECT 1 FROM ${ticketAssignees} ta JOIN organization_members om ON om.org_id = ta.org_id AND om.id = ta.membership_id WHERE ta.org_id = ${orgId} AND om.user_id = ${userId} AND ta.ticket_id = ${tickets.id})`,
  );
}

export async function resolveTicketsScope(
  access: Pick<AccessService, "scopeFor">,
  u: CurrentUserContext,
): Promise<DataScope> {
  return access.scopeFor(u, TICKETS_PERMISSION);
}
