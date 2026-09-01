import { aliasedTable, and, asc, eq, gt, inArray, isNotNull, lt, or } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { calendarEvents, eventAttendees, organizationMembers, projects, tickets, users } from "../../db/schema";
import type { LinkedTicket } from "./calendar.types";

const creatorMember = aliasedTable(organizationMembers, "creator_member");

const callerAtt = aliasedTable(eventAttendees, "cal_src_caller_att");

export class CalendarEventSourceLoader {
  constructor(private readonly database: Db) {}

  async load(
    orgId: string,
    userId: string,
    start: Date,
    end: Date,
  ): Promise<{
    eventsData: Awaited<ReturnType<CalendarEventSourceLoader["queryVisibleEvents"]>>;
    linkedTicketMap: Map<number, LinkedTicket>;
  }> {
    const membership = await this.database.query.organizationMembers.findFirst({
      columns: { id: true },
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
    });

    const callerMembershipId = membership?.id ?? 0;

    const eventsData = await this.queryVisibleEvents(orgId, userId, callerMembershipId, start, end);

    const ticketEntityIds: number[] = [];
    for (const e of eventsData) {
      if (e.entityType === "ticket" && e.entityId != null) {
        const id = parseInt(e.entityId, 10);
        if (!Number.isNaN(id)) ticketEntityIds.push(id);
      }
    }

    const linkedTicketMap = new Map<number, LinkedTicket>();
    if (ticketEntityIds.length > 0) {
      const rows = await this.database
        .select({
          id: tickets.id,
          ticketNumber: tickets.ticketNumber,
          title: tickets.title,
          projectId: projects.id,
          status: tickets.status,
          projectKey: projects.key,
        })
        .from(tickets)
        .innerJoin(projects, eq(tickets.projectId, projects.id))
        .where(and(eq(tickets.orgId, orgId), inArray(tickets.id, ticketEntityIds)));
      for (const row of rows)
        linkedTicketMap.set(row.id, {
          id: row.id,
          key: `${row.projectKey}-${row.ticketNumber}`,
          title: row.title,
          projectId: row.projectId,
          status: row.status,
        });
    }

    return { eventsData, linkedTicketMap };
  }

  private async queryVisibleEvents(
    orgId: string,
    userId: string,
    callerMembershipId: number,
    start: Date,
    end: Date,
  ) {
    const events: Array<{
      id: number;
      title: string;
      description: string | null;
      location: string | null;
      meetingUrl: string | null;
      startDate: Date;
      endDate: Date;
      allDay: boolean | null;
      color: string | null;
      category: string | null;
      entityType: string | null;
      entityId: string | null;
      visibility: string;
      creatorName: string | null;
      rsvpStatus: string | null;
    }> = [];
    let after: { startDate: Date; id: number } | null = null;
    const batchSize = 500;
    for (;;) {
      // .limit(batchSize) below is intentional: the keyset loop consumes every batch.
      const batch: typeof events = await this.database
        .select({
          id: calendarEvents.id,
          title: calendarEvents.title,
          description: calendarEvents.description,
          location: calendarEvents.location,
          meetingUrl: calendarEvents.meetingUrl,
          startDate: calendarEvents.startDate,
          endDate: calendarEvents.endDate,
          allDay: calendarEvents.allDay,
          color: calendarEvents.color,
          category: calendarEvents.category,
          entityType: calendarEvents.entityType,
          entityId: calendarEvents.entityId,
          visibility: calendarEvents.visibility,
          creatorName: users.name,
          rsvpStatus: callerAtt.status,
        })
        .from(calendarEvents)
        .leftJoin(
          creatorMember,
          and(eq(creatorMember.orgId, calendarEvents.orgId), eq(creatorMember.id, calendarEvents.createdByMembershipId)),
        )
        .leftJoin(users, eq(users.id, creatorMember.userId))
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
          lt(calendarEvents.startDate, end),
          gt(calendarEvents.endDate, start),
          or(
            eq(calendarEvents.visibility, "org"),
            eq(calendarEvents.createdByMembershipId, callerMembershipId),
            isNotNull(callerAtt.id),
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
        .limit(batchSize);
      events.push(...batch);
      if (batch.length < batchSize) break;
      const last = batch[batch.length - 1];
      if (!last) break;
      after = { startDate: last.startDate, id: last.id };
    }
    return events;
  }
}
