import { and, eq, inArray, like } from "drizzle-orm";
import {
  calendarEvents,
  eventAttendees,
  notificationOutbox,
  organizationMembers,
  users,
} from "../../db/schema";
import type { TenantTx } from "../../db/drizzle.types";
import { type Db } from "../../db/drizzle.module";

/**
 * Reconciling an event's attendee set, and resolving those attendees' addresses.
 *
 * The reconciliation is not a plain replace: removing somebody has to withdraw
 * the pending reminder addressed to them and re-arm the event's reminder flag,
 * or a cancelled attendee still gets the 15-minute ping. That coupling between
 * `event_attendees` and `notification_outbox` is why this is one unit, and why it
 * sits apart from `CalendarService`, which owns the event row's own lifecycle.
 */

export async function updateAttendeesInTx(
  tx: TenantTx,
  orgId: string,
  eventId: number,
  attendeeIds: string[],
  actorUserId: string,
): Promise<string[]> {
  const current = await tx
    .select({ userId: organizationMembers.userId })
    .from(eventAttendees)
    .innerJoin(
      organizationMembers,
      and(eq(eventAttendees.orgId, organizationMembers.orgId), eq(eventAttendees.membershipId, organizationMembers.id)),
    )
    .where(and(eq(eventAttendees.orgId, orgId), eq(eventAttendees.eventId, eventId)));

  const currentUserIds = new Set(current.map((a) => a.userId));

  const memberships =
    attendeeIds.length === 0
      ? []
      : await tx
          .select({ id: organizationMembers.id, userId: organizationMembers.userId })
          .from(organizationMembers)
          .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, attendeeIds)));

  const newUserIdSet = new Set(memberships.map((m) => m.userId));
  const anyRemoved = [...currentUserIds].some((uid) => !newUserIdSet.has(uid));

  await tx
    .delete(eventAttendees)
    .where(and(eq(eventAttendees.orgId, orgId), eq(eventAttendees.eventId, eventId)));

  if (memberships.length > 0)
    await tx
      .insert(eventAttendees)
      .values(memberships.map((m) => ({ orgId, eventId, membershipId: m.id })))
      .onConflictDoNothing();

  if (anyRemoved) {
    await tx
      .delete(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.orgId, orgId),
          eq(notificationOutbox.state, "PENDING"),
          like(notificationOutbox.dedupeKey, `calendar:reminder:${eventId}:%`),
        ),
      );
    await tx
      .update(calendarEvents)
      .set({ reminder15MinSent: false })
      .where(
        and(
          eq(calendarEvents.orgId, orgId),
          eq(calendarEvents.id, eventId),
          eq(calendarEvents.reminder15MinSent, true),
        ),
      );
  }

  return memberships
    .filter((m) => !currentUserIds.has(m.userId) && m.userId !== actorUserId)
    .map((m) => m.userId);
}

export async function attendeeEmails(db: Db, orgId: string, attendeeIds: string[]): Promise<string[]> {
  if (attendeeIds.length === 0) return [];
  const rows = await db
    .select({ email: users.email })
    .from(users)
    .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
    .where(
      and(
        inArray(users.id, attendeeIds),
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
    );
  return rows.map((r) => r.email);
}
