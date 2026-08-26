import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, inArray, lt } from "drizzle-orm";
import { calendarEvents, eventAttendees } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db, TenantTx } from "../../db/drizzle.types";
import { expandToOccurrences, type CalendarOccurrence } from "./calendar-occurrence.service";

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
    const rows = await tx
      .select({
        id: calendarEvents.id,
        title: calendarEvents.title,
        startDate: calendarEvents.startDate,
        endDate: calendarEvents.endDate,
        allDay: calendarEvents.allDay,
        timezone: calendarEvents.timezone,
        orgId: calendarEvents.orgId,
        createdBy: calendarEvents.createdBy,
      })
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.orgId, orgId),
          lt(calendarEvents.startDate, endDate),
          gt(calendarEvents.endDate, startDate),
        ),
      )
      .limit(CONFLICT_SCAN_LIMIT);

    if (rows.length === 0) return [];

    const eventIds = rows.map((r) => r.id);
    const attendeeRows = await tx
      .select({ eventId: eventAttendees.eventId, status: eventAttendees.status })
      .from(eventAttendees)
      .where(
        and(
          eq(eventAttendees.userId, userId),
          inArray(eventAttendees.eventId, eventIds),
        ),
      );
    const rsvpMap = new Map<number, string>(
      attendeeRows.map((r) => [r.eventId, r.status]),
    );

    const occurrences: CalendarOccurrence[] = [];
    for (const row of rows) {
      const rsvpStatus = rsvpMap.get(row.id) ?? null;
      if (row.createdBy !== userId && rsvpStatus === null) continue;
      if (rsvpStatus === "declined") continue;
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
          },
          startDate,
          endDate,
        ),
      );
    }
    return occurrences;
  }
}
