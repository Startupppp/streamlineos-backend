import { eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { supportTickets } from "../../../db/schema";
import type { ScopedRead } from "../../access/scoped-read";
import type { ListTicketsInput } from "./dto/support.schemas";

export type ListTicketsQuery = ListTicketsInput & { read: ScopedRead };

export function ticketListCacheKey(query: ListTicketsQuery): string {
  const { status, priority, assigneeId, queueId, channel, snoozed, page, limit, read } = query;
  return `${status ?? ""}:${priority ?? ""}:${assigneeId ?? ""}:${queueId ?? ""}:${channel ?? ""}:${snoozed ?? ""}:${read.discriminator}:${page}:${limit}`;
}

export function ticketListFilters(orgId: string, query: ListTicketsQuery): (SQL | undefined)[] {
  const { status, priority, assigneeId, queueId, channel, snoozed } = query;
  const conditions: (SQL | undefined)[] = [
    status ? eq(supportTickets.status, status) : undefined,
    priority ? eq(supportTickets.priority, priority) : undefined,
    assigneeId
      ? sql`${supportTickets.assigneeMembershipId} IN (SELECT id FROM organization_members WHERE org_id = ${orgId} AND user_id = ${assigneeId})`
      : undefined,
    queueId ? eq(supportTickets.queueId, queueId) : undefined,
    channel ? eq(supportTickets.sourceChannel, channel) : undefined,
  ];
  if (snoozed === true) conditions.push(sql`${supportTickets.snoozedUntil} > now()`);
  else conditions.push(or(isNull(supportTickets.snoozedUntil), sql`${supportTickets.snoozedUntil} <= now()`));
  return conditions;
}
