import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { calendarEvents, calendarEventExceptions, notificationOutbox, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { UpsertOccurrenceExceptionInput } from "./dto/occurrence-exception.schemas";

@Injectable()
export class CalendarRecurrenceService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async getRecurringEventForOwner(orgId: string, userId: string, eventId: number) {
    const memberRow = await this.db.query.organizationMembers.findFirst({
      columns: { id: true },
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
    });
    if (!memberRow) return null;
    const rows = await this.db
      .select({ createdByMembershipId: calendarEvents.createdByMembershipId, rrule: calendarEvents.rrule })
      .from(calendarEvents)
      .where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.orgId, orgId)))
      .limit(1);
    const ev = rows[0];
    if (!ev || ev.createdByMembershipId !== memberRow.id || !ev.rrule) return null;
    return ev;
  }

  async upsertOccurrenceException(
    orgId: string,
    userId: string,
    eventId: number,
    occurrenceStartIso: string,
    input: UpsertOccurrenceExceptionInput,
  ) {
    if (!(await this.getRecurringEventForOwner(orgId, userId, eventId))) return null;
    const occurrenceStart = new Date(occurrenceStartIso);
    const [row] = await this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(calendarEventExceptions)
        .values({
          orgId,
          eventId,
          occurrenceStart,
          isCancelled: false,
          modifiedTitle: input.modifiedTitle ?? null,
          modifiedStart: input.modifiedStart ? new Date(input.modifiedStart) : null,
          modifiedEnd: input.modifiedEnd ? new Date(input.modifiedEnd) : null,
        })
        .onConflictDoUpdate({
          target: [calendarEventExceptions.orgId, calendarEventExceptions.eventId, calendarEventExceptions.occurrenceStart],
          set: {
            isCancelled: false,
            modifiedTitle: input.modifiedTitle ?? null,
            modifiedStart: input.modifiedStart ? new Date(input.modifiedStart) : null,
            modifiedEnd: input.modifiedEnd ? new Date(input.modifiedEnd) : null,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (input.modifiedStart)
        await tx
          .update(notificationOutbox)
          .set({ state: "DEAD" })
          .where(
            and(
              eq(notificationOutbox.orgId, orgId),
              eq(notificationOutbox.state, "PENDING"),
              eq(notificationOutbox.dedupeKey, `calendar:reminder:${eventId}:${occurrenceStart.toISOString()}`),
            ),
          );
      return rows;
    });
    return row;
  }

  async cancelOccurrence(orgId: string, userId: string, eventId: number, occurrenceStartIso: string) {
    if (!(await this.getRecurringEventForOwner(orgId, userId, eventId))) return null;
    const occurrenceStart = new Date(occurrenceStartIso);
    const [row] = await this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(calendarEventExceptions)
        .values({ orgId, eventId, occurrenceStart, isCancelled: true })
        .onConflictDoUpdate({
          target: [calendarEventExceptions.orgId, calendarEventExceptions.eventId, calendarEventExceptions.occurrenceStart],
          set: { isCancelled: true, updatedAt: new Date() },
        })
        .returning();
      await tx
        .update(notificationOutbox)
        .set({ state: "DEAD" })
        .where(
          and(
            eq(notificationOutbox.orgId, orgId),
            eq(notificationOutbox.state, "PENDING"),
            eq(notificationOutbox.dedupeKey, `calendar:reminder:${eventId}:${occurrenceStart.toISOString()}`),
          ),
        );
      return rows;
    });
    return row;
  }
}
