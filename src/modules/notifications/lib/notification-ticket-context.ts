import { and, eq, inArray, isNull } from "drizzle-orm";
import { tickets, projects, users } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import type { NotificationTicketContext } from "../notifications.types";
import type { NotificationListRow } from "./notification-queries";

/**
 * The ticket a notification is about, for the rows that are about one.
 *
 * Split from the inbox queries because it is the only part that leaves the
 * `notifications` table — it joins tickets, their projects and their assignees
 * so the inbox can render a row without a second round trip per item.
 *
 * `extractTicketId` lives here with it, and its two branches are the reason:
 * a ticket notification may name the ticket in `entity_id` OR only in
 * `metadata.ticketId`, and the metadata form may be a number or a string.
 * A reader checking one of the three finds nothing for the other two.
 */

function extractTicketId(row: {
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
}): number | null {
  if (row.entityType === "ticket" && row.entityId) {
    const fromEntity = Number.parseInt(row.entityId, 10);
    if (Number.isFinite(fromEntity)) return fromEntity;
  }
  const metaId = row.metadata?.ticketId;
  if (typeof metaId === "number" && Number.isFinite(metaId)) return metaId;
  if (typeof metaId === "string") {
    const fromMeta = Number.parseInt(metaId, 10);
    if (Number.isFinite(fromMeta)) return fromMeta;
  }
  return null;
}

export async function attachTicketContext(
  db: Db,
  orgId: string,
  rows: NotificationListRow[],
) {
  const ticketIds = Array.from(
    new Set(
      rows
        .map((row) => extractTicketId(row))
        .filter((id): id is number => id != null),
    ),
  );
  if (ticketIds.length === 0)
    return rows.map((row) => ({
      ...row,
      ticketContext: null as NotificationTicketContext | null,
    }));

  const ticketRows = await db
    .select({
      id: tickets.id,
      ticketNumber: tickets.ticketNumber,
      priority: tickets.priority,
      status: tickets.status,
      type: tickets.type,
      projectKey: projects.key,
      assigneeId: users.id,
      assigneeName: users.name,
      assigneeFirstName: users.firstName,
      assigneeLastName: users.lastName,
      assigneeImage: users.image,
    })
    .from(tickets)
    .leftJoin(projects, eq(projects.id, tickets.projectId))
    .leftJoin(users, eq(users.id, tickets.assigneeId))
    .where(and(eq(tickets.orgId, orgId), isNull(tickets.deletedAt), inArray(tickets.id, ticketIds)));

  const byId = new Map<number, NotificationTicketContext>();
  for (const ticket of ticketRows) {
    const ticketKey = ticket.projectKey
      ? `${ticket.projectKey}-${ticket.ticketNumber}`
      : String(ticket.ticketNumber);
    byId.set(ticket.id, {
      ticketId: ticket.id,
      ticketKey,
      priority: ticket.priority ?? null,
      status: ticket.status,
      type: ticket.type,
      assignee: ticket.assigneeId
        ? {
            id: ticket.assigneeId,
            name: ticket.assigneeName ?? null,
            firstName: ticket.assigneeFirstName ?? null,
            lastName: ticket.assigneeLastName ?? null,
            image: ticket.assigneeImage ?? null,
          }
        : null,
    });
  }

  return rows.map((row) => {
    const ticketId = extractTicketId(row);
    return {
      ...row,
      ticketContext: ticketId != null ? (byId.get(ticketId) ?? null) : null,
    };
  });
}
