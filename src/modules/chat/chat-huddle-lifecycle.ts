/**
 * Every state transition a huddle can make: a participant arriving or leaving, the host moving on,
 * and the call itself ending.
 *
 * The call itself happens at Google Meet, which tells us nothing about who is in it, so "is this
 * huddle still running" is answered entirely by these rows. A tab closed without a leave leaves a
 * participant row open forever, which is why the heartbeat exists, why the read path reaps stale
 * participants before it trusts the count, and why a huddle whose last participant is gone is
 * ended here rather than left `active` for the next reader to trip over.
 */
import { and, eq, isNull, lt } from "drizzle-orm";
import { chatHuddleParticipants, chatHuddles } from "../../db/schema";
import type { Db, TenantTx } from "../../db/drizzle.types";
import type { AblyService } from "../realtime/ably.service";
import { closeHuddleCalendarEvent } from "./chat-huddle-calendar";

/** A participant that has neither heartbeat nor join inside this window is treated as gone. */
const STALE_PARTICIPANT_MS = 90_000;

/** No huddle stays open past this, however many tabs are still claiming to be in it. */
export const HUDDLE_MAX_DURATION_MS = 12 * 60 * 60 * 1000;

export interface EndingHuddle {
  id: number;
  channelId: number;
  calendarEventId: number | null;
}

/** Both `db` and a transaction handle can write a participant row; only the writer half is used. */
type ParticipantWriter = Db | TenantTx;

/** Join, or re-join after a drop: the same row is revived rather than duplicated. */
export async function upsertHuddleParticipant(
  writer: ParticipantWriter,
  orgId: string,
  huddleId: number,
  membershipId: number,
): Promise<void> {
  const now = new Date();
  await writer
    .insert(chatHuddleParticipants)
    .values({ orgId, huddleId, membershipId })
    .onConflictDoUpdate({
      target: [chatHuddleParticipants.huddleId, chatHuddleParticipants.membershipId],
      set: { leftAt: null, joinedAt: now, lastSeenAt: now },
    });
}

/**
 * `onlyIfStillActive` is what separates a removal from a departure: a kick must not overwrite the
 * `leftAt` of someone who had already left, while a leave stamps unconditionally.
 */
export async function markParticipantLeft(
  db: Db,
  orgId: string,
  huddleId: number,
  membershipId: number,
  options: { onlyIfStillActive?: boolean } = {},
): Promise<void> {
  await db
    .update(chatHuddleParticipants)
    .set({ leftAt: new Date() })
    .where(
      and(
        eq(chatHuddleParticipants.orgId, orgId),
        eq(chatHuddleParticipants.huddleId, huddleId),
        eq(chatHuddleParticipants.membershipId, membershipId),
        options.onlyIfStillActive ? isNull(chatHuddleParticipants.leftAt) : undefined,
      ),
    );
}

export async function reapStaleHuddleParticipants(db: Db, orgId: string, huddleId: number): Promise<void> {
  const staleThreshold = new Date(Date.now() - STALE_PARTICIPANT_MS);
  await db
    .update(chatHuddleParticipants)
    .set({ leftAt: new Date() })
    .where(
      and(
        eq(chatHuddleParticipants.orgId, orgId),
        eq(chatHuddleParticipants.huddleId, huddleId),
        isNull(chatHuddleParticipants.leftAt),
        lt(chatHuddleParticipants.lastSeenAt, staleThreshold),
        lt(chatHuddleParticipants.joinedAt, staleThreshold),
      ),
    );
}

/** One still-present participant, or null when the call has emptied out. */
export async function findRemainingParticipant(
  db: Db,
  orgId: string,
  huddleId: number,
): Promise<{ membershipId: number } | null> {
  const rows = await db.query.chatHuddleParticipants.findMany({
    where: and(
      eq(chatHuddleParticipants.orgId, orgId),
      eq(chatHuddleParticipants.huddleId, huddleId),
      isNull(chatHuddleParticipants.leftAt),
    ),
    columns: { membershipId: true },
    limit: 1,
  });
  return rows[0] ?? null;
}

/** A huddle already carrying an `endedAt` is reconciled to `ended` without re-announcing it. */
export async function markHuddleEnded(db: Db, orgId: string, huddleId: number): Promise<void> {
  await db
    .update(chatHuddles)
    .set({ status: "ended" })
    .where(and(eq(chatHuddles.orgId, orgId), eq(chatHuddles.id, huddleId)));
}

export async function transferHuddleHost(
  db: Db,
  ably: AblyService,
  orgId: string,
  huddle: { id: number; channelId: number },
  newHostMembershipId: number,
): Promise<void> {
  await db
    .update(chatHuddles)
    .set({ startedByMembershipId: newHostMembershipId })
    .where(and(eq(chatHuddles.orgId, orgId), eq(chatHuddles.id, huddle.id)));
  await ably.publishHuddleEvent(orgId, huddle.channelId, "huddle:state_updated", {
    huddleId: huddle.id,
    hostTransferred: true,
    newHostMembershipId,
  });
}

export async function endHuddle(
  db: Db,
  ably: AblyService,
  orgId: string,
  huddle: EndingHuddle,
): Promise<void> {
  const endedAt = new Date();
  await db
    .update(chatHuddles)
    .set({ status: "ended", endedAt })
    .where(and(eq(chatHuddles.orgId, orgId), eq(chatHuddles.id, huddle.id)));
  if (huddle.calendarEventId) await closeHuddleCalendarEvent(db, orgId, huddle.calendarEventId, endedAt);
  await ably.publishHuddleEvent(orgId, huddle.channelId, "huddle:ended", {
    huddleId: huddle.id,
    channelId: huddle.channelId,
  });
}
