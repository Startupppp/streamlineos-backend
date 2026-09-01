import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or } from "drizzle-orm";
import { calendarEvents, calendarEventExceptions, eventAttendees, leaveRequests, organizationMembers, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db, TenantTx } from "../../db/drizzle.types";
import { dateOnly, type OooConflict } from "./calendar.types";
import {
  expandToOccurrences,
  type CalendarEventException,
  type CalendarOccurrence,
} from "./calendar-occurrence.service";

const CONFLICT_SCAN_BATCH_SIZE = 100;

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

    const rows: Array<{
      id: number;
      title: string;
      startDate: Date;
      endDate: Date;
      allDay: boolean | null;
      timezone: string | null;
      orgId: string;
      createdByMembershipId: number;
      rrule: string | null;
      recurrenceEnd: Date | null;
    }> = [];
    let after: { startDate: Date; id: number } | null = null;
    for (;;) {
      // .limit(CONFLICT_SCAN_BATCH_SIZE) below is intentional: the keyset loop consumes every batch.
      const batch = await tx
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
          after === null
            ? undefined
            : or(
                gt(calendarEvents.startDate, after.startDate),
                and(eq(calendarEvents.startDate, after.startDate), gt(calendarEvents.id, after.id)),
              ),
        ),
      )
        .orderBy(asc(calendarEvents.startDate), asc(calendarEvents.id))
        .limit(CONFLICT_SCAN_BATCH_SIZE);
      rows.push(...batch);
      if (batch.length < CONFLICT_SCAN_BATCH_SIZE) break;
      const last = batch[batch.length - 1];
      if (!last) break;
      after = { startDate: last.startDate, id: last.id };
    }

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

  async getOooConflicts(
    orgId: string,
    attendeeIds: string[],
    start: Date,
    end: Date,
  ): Promise<OooConflict[]> {
    if (attendeeIds.length === 0) return [];

    return this.db
      .select({
        userId: leaveRequests.userId,
        userName: users.name,
        leaveStart: leaveRequests.startDate,
        leaveEnd: leaveRequests.endDate,
      })
      .from(leaveRequests)
      .innerJoin(users, eq(leaveRequests.userId, users.id))
      .where(
        and(
          eq(leaveRequests.orgId, orgId),
          eq(leaveRequests.status, "APPROVED"),
          inArray(leaveRequests.userId, attendeeIds),
          lte(leaveRequests.startDate, dateOnly(end)),
          gte(leaveRequests.endDate, dateOnly(start)),
        ),
      );
  }
}
