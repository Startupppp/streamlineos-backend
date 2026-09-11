import type { Principal } from "../../../common/auth/principal";
import type { NotificationVisibilityRegistry } from "../notification-visibility.registry";
import type {
  NotificationListRow,
  NotificationTicketContext,
} from "../notifications.types";

/**
 * The ticket a notification is about, for the rows that are about one.
 *
 * Split from the inbox queries because it is the only part that leaves the
 * `notifications` table. What it may show is decided by the visibility
 * registry for the reading principal: a notification can outlive its reader's
 * access to the ticket it names, and the context must not tell them what they
 * can no longer open. With no principal there is no context at all.
 *
 * `extractTicketId` lives here with it, and its two branches are the reason:
 * a ticket notification may name the ticket in `entity_id` OR only in
 * `metadata.ticketId`, and the metadata form may be a number or a string.
 * A reader checking one of the three finds nothing for the other two. Only a
 * positive safe integer counts, so "12abc" or "1e400" names no ticket.
 */

function extractTicketId(row: {
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
}): number | null {
  if (row.entityType === "ticket" && row.entityId) {
    const fromEntity = Number(row.entityId);
    if (Number.isSafeInteger(fromEntity) && fromEntity > 0) return fromEntity;
  }
  const metaId = row.metadata?.ticketId;
  if (typeof metaId === "number" && Number.isSafeInteger(metaId) && metaId > 0) return metaId;
  if (typeof metaId === "string") {
    const fromMeta = Number(metaId);
    if (Number.isSafeInteger(fromMeta) && fromMeta > 0) return fromMeta;
  }
  return null;
}

export async function attachTicketContext(
  visibility: NotificationVisibilityRegistry,
  orgId: string,
  userId: string,
  rows: NotificationListRow[],
  principal?: Principal,
) {
  const ticketIds = Array.from(
    new Set(
      rows
        .map((row) => extractTicketId(row))
        .filter((id): id is number => id != null),
    ),
  );
  const byId: ReadonlyMap<number, NotificationTicketContext> = principal
    ? await visibility.ticketContexts(orgId, userId, ticketIds, principal)
    : new Map<number, NotificationTicketContext>();

  return rows.map((row) => {
    const ticketId = extractTicketId(row);
    return {
      ...row,
      ticketContext: ticketId != null ? (byId.get(ticketId) ?? null) : null,
    };
  });
}
