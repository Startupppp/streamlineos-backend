import { NotFoundException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { userIntegrationConnections } from "../../db/schema";
import type { TenantTx } from "../../db/drizzle.types";
import { connectionOwnerPredicate } from "../integrations/core/connection-owner.predicate";

/** The toolkits this module can actually push an event to; see PROVIDER_CAPABILITIES. */
const CALENDAR_SYNC_TOOLKITS = ["googlecalendar", "outlook"] as const;

/**
 * Authorizes a caller-supplied `syncConnectionId` before an event is written against it.
 *
 * `createEventSchema` validates the field as `z.number().int().positive()` and nothing
 * more, and it used to travel straight into `calendar_provider_sync_queue.connectionId`.
 * That is an object reference, so root CLAUDE.md §4 says the caller's access to THAT
 * object has to be re-asserted — and nothing did. `ExternalCalendarSyncService` hands
 * `conn.composioConnectedAccountId` to `ComposioGateway.executeTool`, which passes it to
 * Composio as `connectedAccountId`: the CONNECTION selects the Google or Outlook account
 * the write lands in, never the `userId` argument travelling beside it. So any member
 * could have their event title, description and attendee emails written into another
 * member's personal calendar by guessing a small serial, with their later updates and
 * deletes following.
 *
 * Ownership is the integrations module's own `connectionOwnerPredicate` — membership
 * first, `user_id` only as the fallback for rows written before `membership_id` existed —
 * rather than a second ownership rule maintained here.
 *
 * Call it inside the create transaction and BEFORE the event insert: a refused sync must
 * leave nothing behind. A miss is 404, never 403; a 403 on a connection id the caller does
 * not own would confirm that it exists.
 */
export async function assertOwnedCalendarConnection(
  tx: TenantTx,
  orgId: string,
  userId: string,
  membershipId: number,
  connectionId: number,
): Promise<void> {
  const owned = await tx
    .select({ id: userIntegrationConnections.id })
    .from(userIntegrationConnections)
    .where(
      and(
        eq(userIntegrationConnections.id, connectionId),
        eq(userIntegrationConnections.orgId, orgId),
        connectionOwnerPredicate(userId, membershipId),
        eq(userIntegrationConnections.status, "active"),
        inArray(userIntegrationConnections.toolkit, [...CALENDAR_SYNC_TOOLKITS]),
      ),
    )
    .limit(1);
  if (owned.length === 0) throw new NotFoundException("Calendar connection not found");
}
