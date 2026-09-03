/**
 * The calendar event a huddle owns, from the moment it starts to the moment it ends.
 *
 * A huddle is also a meeting: it appears on `/calendar` for everyone in the channel, so starting
 * one writes a `calendar_events` row and backfills every channel member as an attendee, and ending
 * one closes that row at the real end time rather than leaving the two-hour estimate standing.
 */
import { and, asc, eq, gt } from "drizzle-orm";
import { calendarEvents, chatChannelMembers, eventAttendees } from "../../db/schema";
import type { Db, TenantTx } from "../../db/drizzle.types";
import { forEachChannelMemberBatch } from "./chat-channel-member-batches";

const ATTENDEE_BATCH = 500;

export interface HuddleCalendarEventInput {
  orgId: string;
  channelId: number;
  channelName: string;
  starterMembershipId: number;
  startsAt: Date;
  estimatedEndsAt: Date;
}

/**
 * Returns the new event id, or `undefined` when the insert produced no row — the huddle is then
 * written with no calendar event rather than with an explicit null, which is what the column's
 * absence has always meant here.
 */
export async function createHuddleCalendarEvent(
  tx: TenantTx,
  input: HuddleCalendarEventInput,
): Promise<number | undefined> {
  const [calEvent] = await tx
    .insert(calendarEvents)
    .values({
      orgId: input.orgId,
      title: `Huddle in #${input.channelName}`,
      category: "huddle",
      entityType: "huddle",
      entityId: input.channelId.toString(),
      startDate: input.startsAt,
      endDate: input.estimatedEndsAt,
      allDay: false,
      createdByMembershipId: input.starterMembershipId,
    })
    .returning({ id: calendarEvents.id });

  if (!calEvent) return undefined;

  await forEachChannelMemberBatch(
    tx,
    ATTENDEE_BATCH,
    (db, afterMembershipId) =>
      db
        .select({ membershipId: chatChannelMembers.membershipId })
        .from(chatChannelMembers)
        .where(
          and(
            eq(chatChannelMembers.orgId, input.orgId),
            eq(chatChannelMembers.channelId, input.channelId),
            afterMembershipId !== null ? gt(chatChannelMembers.membershipId, afterMembershipId) : undefined,
          ),
        )
        .orderBy(asc(chatChannelMembers.membershipId))
        .limit(ATTENDEE_BATCH),
    async (batch) => {
      await tx
        .insert(eventAttendees)
        .values(batch.map((b) => ({ orgId: input.orgId, eventId: calEvent.id, membershipId: b.membershipId })))
        .onConflictDoNothing();
    },
  );

  return calEvent.id;
}

export async function closeHuddleCalendarEvent(
  db: Db,
  orgId: string,
  calendarEventId: number,
  endedAt: Date,
): Promise<void> {
  await db
    .update(calendarEvents)
    .set({ endDate: endedAt })
    .where(and(eq(calendarEvents.orgId, orgId), eq(calendarEvents.id, calendarEventId)));
}
