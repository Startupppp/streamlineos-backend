import { Inject, Injectable } from "@nestjs/common";
import { aliasedTable, and, asc, eq, gte, isNotNull, lte, or, sql } from "drizzle-orm";
import { calendarEvents, eventAttendees, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { DataScope } from "../access/access.types";

const EXPORT_ROW_CAP = 500;

@Injectable()
export class CalendarExportService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async exportEvents(orgId: string, userId: string, from: Date, to: Date, scope: DataScope = "all") {
    if (scope === "none") return [];

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

    return this.db
      .select({
        id: calendarEvents.id,
        title: calendarEvents.title,
        startDate: calendarEvents.startDate,
        endDate: calendarEvents.endDate,
        allDay: calendarEvents.allDay,
        category: calendarEvents.category,
        location: calendarEvents.location,
        description: calendarEvents.description,
        color: calendarEvents.color,
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
          gte(calendarEvents.startDate, from),
          lte(calendarEvents.startDate, to),
          visibilityClause,
          scopeClause,
        ),
      )
      .orderBy(asc(calendarEvents.startDate))
      .limit(EXPORT_ROW_CAP);
  }
}
