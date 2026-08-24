import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { calendarEvents, eventAttendees, projects, tickets } from "../../db/schema";
import type { LinkedTicket } from "./calendar.types";

// tickets and projects are imported solely for linked-ticket enrichment:
// a native calendar event may carry entityType="ticket" pointing at a Build
// ticket; the response populates linkedTicket with its title and status.

export class CalendarEventSourceLoader {
  constructor(private readonly database: Db) {}

  async load(
    orgId: string,
    userId: string,
    start: Date,
    end: Date,
  ): Promise<{
    eventsData: Awaited<ReturnType<CalendarEventSourceLoader["queryEvents"]>>;
    rsvpMap: Map<number, string>;
    linkedTicketMap: Map<number, LinkedTicket>;
  }> {
    const eventsData = await this.queryEvents(orgId, start, end);

    const eventIds = eventsData.map((e) => e.id);
    const ticketEntityIds: number[] = [];
    for (const e of eventsData) {
      if (e.entityType === "ticket" && e.entityId != null) {
        const id = parseInt(e.entityId, 10);
        if (!Number.isNaN(id)) ticketEntityIds.push(id);
      }
    }

    const rsvpMap = new Map<number, string>();
    const linkedTicketMap = new Map<number, LinkedTicket>();

    await Promise.all([
      (async () => {
        if (eventIds.length === 0) return;
        const rows = await this.database
          .select({ eventId: eventAttendees.eventId, status: eventAttendees.status })
          .from(eventAttendees)
          .where(
            and(eq(eventAttendees.userId, userId), inArray(eventAttendees.eventId, eventIds)),
          );
        for (const row of rows) rsvpMap.set(row.eventId, row.status ?? "pending");
      })(),
      (async () => {
        if (ticketEntityIds.length === 0) return;
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
      })(),
    ]);

    return { eventsData, rsvpMap, linkedTicketMap };
  }

  private queryEvents(orgId: string, start: Date, end: Date) {
    return this.database.query.calendarEvents.findMany({
      where: and(
        eq(calendarEvents.orgId, orgId),
        gte(calendarEvents.startDate, start),
        lte(calendarEvents.startDate, end),
      ),
      with: { creator: { columns: { name: true } } },
      orderBy: (t, { asc }) => [asc(t.startDate)],
    });
  }
}
