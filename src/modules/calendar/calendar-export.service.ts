import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { aliasedTable, and, asc, eq, isNotNull, isNull, gt, lt, or, sql } from "drizzle-orm";
import { calendarEvents, eventAttendees, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { collectRescheduledOccurrences, loadExceptionsByEvent } from "./calendar-exception-loader";
import { expandToOccurrences } from "./calendar-occurrence.service";
import type { DataScope } from "../access/access.types";

const EXPORT_ROW_CAP = 500;
const EXPORT_RANGE_CAP_MS = 366 * 24 * 60 * 60 * 1000;

interface ExportedEvent {
  title: string;
  startDate: Date;
  endDate: Date;
  allDay: boolean;
  category: string;
  location: string | null;
  description: string | null;
  color: string | null;
}

@Injectable()
export class CalendarExportService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async exportEvents(orgId: string, userId: string, from: Date, to: Date, scope: DataScope = "all"): Promise<ExportedEvent[]> {
    if (scope === "none") return [];
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) throw new BadRequestException("Invalid calendar export range");
    if (to.getTime() - from.getTime() > EXPORT_RANGE_CAP_MS) throw new BadRequestException("Calendar export range cannot exceed 366 days");

    const membership = await this.db.query.organizationMembers.findFirst({
      columns: { id: true },
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
    });
    const callerMembershipId = membership?.id ?? 0;

    const callerAtt = aliasedTable(eventAttendees, "exp_caller_att");

    const visibilityClause = or(
      eq(calendarEvents.visibility, "org"),
      eq(calendarEvents.createdByMembershipId, callerMembershipId),
      isNotNull(callerAtt.id),
    );

    const scopeClause =
      scope === "own"
        ? eq(calendarEvents.createdByMembershipId, callerMembershipId)
        : sql`true`;

    const rows = await this.db
      .select({
        id: calendarEvents.id,
        title: calendarEvents.title,
        startDate: calendarEvents.startDate,
        endDate: calendarEvents.endDate,
        allDay: calendarEvents.allDay,
        timezone: calendarEvents.timezone,
        category: calendarEvents.category,
        location: calendarEvents.location,
        description: calendarEvents.description,
        color: calendarEvents.color,
        rrule: calendarEvents.rrule,
        recurrenceEnd: calendarEvents.recurrenceEnd,
      })
      .from(calendarEvents)
      .leftJoin(
        callerAtt,
        and(
          eq(callerAtt.orgId, calendarEvents.orgId),
          eq(callerAtt.eventId, calendarEvents.id),
          eq(callerAtt.membershipId, callerMembershipId),
        ),
      )
      .where(
        and(
          eq(calendarEvents.orgId, orgId),
          or(
            and(
              isNull(calendarEvents.rrule),
              lt(calendarEvents.startDate, to),
              gt(calendarEvents.endDate, from),
            ),
            and(
              isNotNull(calendarEvents.rrule),
              lt(calendarEvents.startDate, to),
              or(
                isNull(calendarEvents.recurrenceEnd),
                gt(calendarEvents.recurrenceEnd, from),
              ),
            ),
          ),
          visibilityClause,
          scopeClause,
        ),
      )
      .orderBy(asc(calendarEvents.startDate))
      .limit(EXPORT_ROW_CAP);

    if (rows.length === 0) return [];

    const recurringIds = rows.filter((r) => r.rrule != null).map((r) => r.id);
    const exceptionsByEvent = await loadExceptionsByEvent(this.db, orgId, recurringIds, from, to);

    const expanded: ExportedEvent[] = [];
    for (const row of rows) {
      if (expanded.length >= EXPORT_ROW_CAP) break;
      const exceptions = exceptionsByEvent.get(row.id) ?? [];
      const occurrences = expandToOccurrences(
        {
          id: row.id,
          title: row.title,
          startDate: row.startDate,
          endDate: row.endDate,
          allDay: row.allDay,
          timezone: row.timezone,
          orgId,
          rrule: row.rrule,
          recurrenceEnd: row.recurrenceEnd,
        },
        from,
        to,
        exceptions,
      );
      for (const occ of occurrences) {
        if (expanded.length >= EXPORT_ROW_CAP) break;
        expanded.push({
          title: occ.title,
          startDate: occ.startDate,
          endDate: occ.endDate,
          allDay: row.allDay,
          category: row.category,
          location: row.location,
          description: row.description,
          color: row.color,
        });
      }
      if (row.rrule != null) {
        const rescheduled = collectRescheduledOccurrences(row, exceptions, from, to);
        for (const rs of rescheduled) {
          if (expanded.length >= EXPORT_ROW_CAP) break;
          expanded.push({
            title: rs.title,
            startDate: rs.startDate,
            endDate: rs.endDate,
            allDay: row.allDay,
            category: row.category,
            location: row.location,
            description: row.description,
            color: row.color,
          });
        }
      }
    }
    return expanded;
  }
}
