import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { calendarEvents, calendarEventExceptions, eventAttendees, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db, TenantTx } from "../../db/drizzle.types";
import {
  expandToOccurrences,
  type CalendarEventException,
  type CalendarOccurrence,
} from "./calendar-occurrence.service";

const CONFLICT_SCAN_LIMIT = 100;

@Injectable()
export class CalendarConflictService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  checkConflicts(
    orgId: string,
    userId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<CalendarOccurrence[]> {
    return this.db.transaction((tx) =>
      this.checkConflictsInTx(tx, orgId, userId, startDate, endDate),
    );
  }

  async checkConflictsInTx(
    tx: TenantTx,
    orgId: string,
    userId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<CalendarOccurrence[]> {
    const callerMember = await tx.query.organizationMembers.findFirst({
      columns: { id: true },
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
    });
    const callerMembershipId = callerMember?.id ?? 0;

    const rows = await tx
      .select({
        id: calendarEvents.id,
        title: calendarEvents.title,
        startDate: calendarEvents.startDate,
        endDate: calendarEvents.endDate,
        allDay: calendarEvents.allDay,
        timezone: calendarEvents.timezone,
        orgId: calendarEvents.orgId,
        createdByMembershipId: calendarEvents.createdByMembershipId,
        rrule: calendarEvents.rrule,
        recurrenceEnd: calendarEvents.recurrenceEnd,
      })
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.orgId, orgId),
          or(
            and(
              isNull(calendarEvents.rrule),
              lt(calendarEvents.startDate, endDate),
              gt(calendarEvents.endDate, startDate),
            ),
            and(
              isNotNull(calendarEvents.rrule),
              lt(calendarEvents.startDate, endDate),
              or(
                isNull(calendarEvents.recurrenceEnd),
                gt(calendarEvents.recurrenceEnd, startDate),
              ),
            ),
          ),
        ),
      )
      .limit(CONFLICT_SCAN_LIMIT);

    if (rows.length === 0) return [];

    const recurringIds = rows.filter((r) => r.rrule !== null).map((r) => r.id);

    const exceptionsByEvent = new Map<number, CalendarEventException[]>();
    if (recurringIds.length > 0) {
      const excRows = await tx
        .select({
          eventId: calendarEventExceptions.eventId,
          occurrenceStart: calendarEventExceptions.occurrenceStart,
          isCancelled: calendarEventExceptions.isCancelled,
          modifiedTitle: calendarEventExceptions.modifiedTitle,
          modifiedStart: calendarEventExceptions.modifiedStart,
          modifiedEnd: calendarEventExceptions.modifiedEnd,
        })
        .from(calendarEventExceptions)
        .where(
          and(
            eq(calendarEventExceptions.orgId, orgId),
            inArray(calendarEventExceptions.eventId, recurringIds),
          ),
        );
      for (const ex of excRows) {
        const list = exceptionsByEvent.get(ex.eventId) ?? [];
        list.push({
          occurrenceStart: ex.occurrenceStart,
          isCancelled: ex.isCancelled,
          modifiedTitle: ex.modifiedTitle,
          modifiedStart: ex.modifiedStart,
          modifiedEnd: ex.modifiedEnd,
        });
        exceptionsByEvent.set(ex.eventId, list);
      }
    }

    const eventIds = rows.map((r) => r.id);
    const attendeeRows = await tx
      .select({ eventId: eventAttendees.eventId, status: eventAttendees.status })
      .from(eventAttendees)
      .where(
        and(
          eq(eventAttendees.orgId, orgId),
          eq(eventAttendees.membershipId, callerMembershipId),
          inArray(eventAttendees.eventId, eventIds),
        ),
      );
    const rsvpMap = new Map<number, string>(
      attendeeRows.map((r) => [r.eventId, r.status]),
    );

    const occurrences: CalendarOccurrence[] = [];
    for (const row of rows) {
      const rsvpStatus = rsvpMap.get(row.id) ?? null;
      if (row.createdByMembershipId !== callerMembershipId && rsvpStatus === null) continue;
      if (rsvpStatus === "declined") continue;
      const exceptions = exceptionsByEvent.get(row.id) ?? [];
      occurrences.push(
        ...expandToOccurrences(
          {
            id: row.id,
            title: row.title,
            startDate: row.startDate,
            endDate: row.endDate,
            allDay: row.allDay ?? false,
            timezone: row.timezone,
            orgId: row.orgId,
            rrule: row.rrule,
            recurrenceEnd: row.recurrenceEnd,
          },
          startDate,
          endDate,
          exceptions,
        ),
      );
    }
    return occurrences;
  }
}
