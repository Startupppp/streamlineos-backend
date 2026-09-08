import { NotFoundException } from "@nestjs/common";
import { aliasedTable, and, desc, eq, isNotNull, or, sql } from "drizzle-orm";
import {
  calendarEvents,
  calendarProviderSyncQueue,
  eventAttendees,
  organizationMembers,
} from "../../db/schema";
import type { Db } from "../../db/drizzle.module";

const attendeeVisibility = aliasedTable(eventAttendees, "att_sync_visibility");

export async function resolveCallerMembershipId(
  db: Db,
  orgId: string,
  userId: string,
): Promise<number> {
  const row = await db.query.organizationMembers.findFirst({
    columns: { id: true },
    where: and(
      eq(organizationMembers.orgId, orgId),
      eq(organizationMembers.userId, userId),
      eq(organizationMembers.status, "ACTIVE"),
    ),
  });
  return row?.id ?? 0;
}

async function findVisibleEvent(
  db: Db,
  orgId: string,
  eventId: number,
  callerMembershipId: number,
): Promise<{ id: number; createdByMembershipId: number } | null> {
  const rows = await db
    .select({
      id: calendarEvents.id,
      createdByMembershipId: calendarEvents.createdByMembershipId,
    })
    .from(calendarEvents)
    .leftJoin(
      attendeeVisibility,
      and(
        eq(attendeeVisibility.orgId, calendarEvents.orgId),
        eq(attendeeVisibility.eventId, calendarEvents.id),
        eq(attendeeVisibility.membershipId, callerMembershipId),
      ),
    )
    .where(
      and(
        eq(calendarEvents.id, eventId),
        eq(calendarEvents.orgId, orgId),
        or(
          eq(calendarEvents.visibility, "org"),
          eq(calendarEvents.createdByMembershipId, callerMembershipId),
          isNotNull(attendeeVisibility.id),
        ),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * A delete leaves a tombstone: the local row is gone but the queue row that must
 * remove the provider copy survives. Visibility can no longer be resolved from the
 * event, so it is resolved from the tombstone's own author — the person `deleteEvent`
 * already verified as the creator. Without this, a delete that exhausts its attempts
 * is invisible and unretryable, and the provider copy lives forever.
 */
async function findDeleteTombstone(
  db: Db,
  orgId: string,
  eventId: number,
  userId: string,
): Promise<{ id: number } | null> {
  const rows = await db
    .select({ id: calendarProviderSyncQueue.id })
    .from(calendarProviderSyncQueue)
    .where(
      and(
        eq(calendarProviderSyncQueue.orgId, orgId),
        eq(calendarProviderSyncQueue.eventId, eventId),
        eq(calendarProviderSyncQueue.operation, "delete"),
        sql`${calendarProviderSyncQueue.payload} ->> 'userId' = ${userId}`,
      ),
    )
    .orderBy(desc(calendarProviderSyncQueue.id))
    .limit(1);
  return rows[0] ?? null;
}

export async function assertReadable(
  db: Db,
  orgId: string,
  eventId: number,
  userId: string,
  callerMembershipId: number,
): Promise<{ createdByMembershipId: number | null }> {
  const visible = await findVisibleEvent(db, orgId, eventId, callerMembershipId);
  if (visible) return { createdByMembershipId: visible.createdByMembershipId };

  const tombstone = await findDeleteTombstone(db, orgId, eventId, userId);
  if (!tombstone) throw new NotFoundException("Event not found");
  return { createdByMembershipId: null };
}
