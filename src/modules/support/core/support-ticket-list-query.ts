import { eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { supportTickets } from "../../../db/schema";
import type { DataScope } from "../../access/access.types";
import type { ListTicketsInput } from "./dto/support.schemas";

export type ListTicketsQuery = ListTicketsInput & { scope?: DataScope; userId?: string };

export type TicketListPredicate =
  | { kind: "deny" }
  | { kind: "filter"; conditions: SQL[] };

export function ticketListCacheKey(query: ListTicketsQuery): string {
  const { status, priority, assigneeId, queueId, channel, snoozed, page, limit, scope, userId } = query;
  return `${status ?? ""}:${priority ?? ""}:${assigneeId ?? ""}:${queueId ?? ""}:${channel ?? ""}:${snoozed ?? ""}:${scope ?? ""}:${userId ?? ""}:${page}:${limit}`;
}

export function buildTicketListPredicate(orgId: string, query: ListTicketsQuery): TicketListPredicate {
  const { status, priority, assigneeId, queueId, channel, snoozed, scope, userId } = query;
  const conditions: SQL[] = [eq(supportTickets.orgId, orgId)];
  if (status) conditions.push(eq(supportTickets.status, status));
  if (priority) conditions.push(eq(supportTickets.priority, priority));
  if (assigneeId) {
    conditions.push(sql`${supportTickets.assigneeMembershipId} IN (SELECT id FROM organization_members WHERE org_id = ${orgId} AND user_id = ${assigneeId})`);
  }
  if (queueId) conditions.push(eq(supportTickets.queueId, queueId));
  if (channel) conditions.push(eq(supportTickets.sourceChannel, channel));
  if (snoozed === true) {
    conditions.push(sql`${supportTickets.snoozedUntil} > now()`);
  } else if (snoozed === false || snoozed === undefined) {
    const notSnoozed = or(isNull(supportTickets.snoozedUntil), sql`${supportTickets.snoozedUntil} <= now()`);
    if (notSnoozed) conditions.push(notSnoozed);
  }
  if (scope && scope !== "none" && userId) {
    conditions.push(sql`${supportTickets.assigneeMembershipId} IN (SELECT id FROM organization_members WHERE org_id = ${orgId} AND user_id = ${userId} AND status = 'ACTIVE')`);
  } else if (scope === "none") {
    return { kind: "deny" };
  }

  return { kind: "filter", conditions };
}
