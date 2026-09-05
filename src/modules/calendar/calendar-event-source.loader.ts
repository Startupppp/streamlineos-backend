import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { calendarEvents, eventAttendees, organizationMembers, projects, tickets, users } from "../../db/schema";
import { CALENDAR_EVENTS_CAP } from "./dto/calendar.schemas";
import { loadExceptionsByEvent } from "./calendar-exception-loader";
import type { CalendarEventException } from "./calendar-occurrence.service";
import type { LinkedTicket } from "./calendar.types";

export interface VisibleEventRow {
  id: number;
  title: string;
  description: string | null;
  location: string | null;
  meetingUrl: string | null;
  startDate: Date;
  endDate: Date;
  allDay: boolean;
  timezone: string;
  color: string | null;
  category: string;
  entityType: string | null;
  entityId: string | null;
  visibility: string;
  rrule: string | null;
  recurrenceEnd: Date | null;
  createdByMembershipId: number;
  creatorName: string | null;
  rsvpStatus: string | null;
}

/**
 * The caller's attendance, asked as a scalar subquery rather than as `EXISTS`.
 *
 * An `EXISTS` here is de-correlated into a hashed SubPlan that materialises every
 * attendee row the caller owns before the OR can short-circuit on `visibility = 'org'`
 * — 39,114 rows for 1,128 blocks on the 89.93% tenant, and unbounded in the caller's
 * own attendance rather than in the page size. A scalar sublink is not hashable, so it
 * stays a correlated probe through `event_attendees_event_membership_unique` and is
 * evaluated only for the rows the two cheap arms did not already admit: 47 probes for
 * 172 blocks on the same fixture.
 */
function attendedByCaller(callerMembershipId: number): SQL {
  return sql`(SELECT ${eventAttendees.id} FROM ${eventAttendees}
     WHERE ${eventAttendees.orgId} = ${calendarEvents.orgId}
       AND ${eventAttendees.eventId} = ${calendarEvents.id}
       AND ${eventAttendees.membershipId} = ${callerMembershipId}
     LIMIT 1) IS NOT NULL`;
}

export class CalendarEventSourceLoader {
  constructor(private readonly database: Db) {}

  async load(
    orgId: string,
    userId: string,
    start: Date,
    end: Date,
  ): Promise<{
    eventsData: VisibleEventRow[];
    linkedTicketMap: Map<number, LinkedTicket>;
    exceptionsByEvent: Map<number, CalendarEventException[]>;
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

    const candidates = await this.candidatePage(orgId, callerMembershipId, start, end);
    if (candidates.length === 0)
      return { eventsData: [], linkedTicketMap: new Map(), exceptionsByEvent: new Map() };

    const ids = candidates.map((c) => c.id);
    const rsvpByEvent = await this.callerRsvp(orgId, callerMembershipId, ids);
    const rows = await this.fetchEvents(orgId, callerMembershipId, ids, [...rsvpByEvent.keys()]);

    const creatorMembershipIds = [...new Set(rows.map((r) => r.createdByMembershipId))];
    const recurringIds = rows.filter((e) => e.rrule !== null).map((e) => e.id);
    const ticketEntityIds: number[] = [];
    for (const e of rows) {
      if (e.entityType === "ticket" && e.entityId != null) {
        const id = parseInt(e.entityId, 10);
        if (!Number.isNaN(id)) ticketEntityIds.push(id);
      }
    }

    const [creatorNames, rawTicketRows, exceptionsByEvent] = await Promise.all([
      this.creatorNames(orgId, creatorMembershipIds),
      this.fetchLinkedTickets(orgId, ticketEntityIds),
      loadExceptionsByEvent(this.database, orgId, recurringIds, start, end),
    ]);

    const linkedTicketMap = new Map<number, LinkedTicket>();
    for (const row of rawTicketRows)
      linkedTicketMap.set(row.id, {
        id: row.id,
        key: `${row.projectKey}-${row.ticketNumber}`,
        title: row.title,
        projectId: row.projectId,
        status: row.status,
      });

    const eventsData: VisibleEventRow[] = rows.map((row) => ({
      ...row,
      rsvpStatus: rsvpByEvent.get(row.id) ?? null,
      creatorName: creatorNames.get(row.createdByMembershipId) ?? null,
    }));

    return { eventsData, linkedTicketMap, exceptionsByEvent };
  }

  /**
   * The creator's display name is a property of a membership, not of an event, and one
   * membership authors many events across many pages. Joined into the page it is two
   * nested loops per page — 582 of the 0.90% tenant's 603 blocks for 97 rows. Resolved
   * once per request over the distinct membership identifiers, it is one indexed read.
   */
  private async creatorNames(orgId: string, membershipIds: number[]): Promise<Map<number, string | null>> {
    const names = new Map<number, string | null>();
    if (membershipIds.length === 0) return names;

    const rows = await this.database
      .select({ membershipId: organizationMembers.id, name: users.name })
      .from(organizationMembers)
      .leftJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.id, membershipIds)));
    for (const row of rows) names.set(row.membershipId, row.name);
    return names;
  }

  private async fetchLinkedTickets(
    orgId: string,
    ticketEntityIds: number[],
  ): Promise<Array<{ id: number; ticketNumber: number; title: string; projectId: number; status: string; projectKey: string }>> {
    if (ticketEntityIds.length === 0) return [];
    return this.database
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
  }

  /**
   * Step one: identifiers only, two range branches run in parallel.
   *
   * As one `OR` the recurring arm has no lower bound on `start_date`, so the planner
   * walks `idx_calendar_events_org_date` from the tenant's first event forward and
   * fetches the heap tuple for every candidate before the window filter can reject it
   * — 3,610 rows scanned to keep 517, four times a sequential scan of the table. Split,
   * each branch reaches an index that already bounds it: `idx_calendar_events_org_end_date`
   * for the non-recurring one and the partial `idx_calendar_events_org_recurring_start`
   * for the recurring one.
   *
   * Both branches are limited to CALENDAR_EVENTS_CAP so a single call replaces the
   * former cursor-paginated loop. Merging in memory is correct: each branch is ordered
   * by (start_date, id) and limited by the same value, so a row in the global first
   * CALENDAR_EVENTS_CAP is necessarily in the first CALENDAR_EVENTS_CAP of its own
   * branch and the merge can never skip one.
   */
  private async candidatePage(
    orgId: string,
    callerMembershipId: number,
    start: Date,
    end: Date,
  ): Promise<Array<{ id: number; startDate: Date }>> {
    const visible = or(
      eq(calendarEvents.visibility, "org"),
      eq(calendarEvents.createdByMembershipId, callerMembershipId),
      attendedByCaller(callerMembershipId),
    );

    const branch = (range: SQL | undefined) =>
      this.database
        .select({ id: calendarEvents.id, startDate: calendarEvents.startDate })
        .from(calendarEvents)
        .where(and(eq(calendarEvents.orgId, orgId), range, visible))
        .orderBy(asc(calendarEvents.startDate), asc(calendarEvents.id))
        .limit(CALENDAR_EVENTS_CAP);

    const [nonRecurring, recurring] = await Promise.all([
      branch(
        and(
          isNull(calendarEvents.rrule),
          lt(calendarEvents.startDate, end),
          gt(calendarEvents.endDate, start),
        ),
      ),
      branch(
        and(
          isNotNull(calendarEvents.rrule),
          lt(calendarEvents.startDate, end),
          or(isNull(calendarEvents.recurrenceEnd), gt(calendarEvents.recurrenceEnd, start)),
        ),
      ),
    ]);

    return [...nonRecurring, ...recurring]
      .sort((a, b) => a.startDate.getTime() - b.startDate.getTime() || a.id - b.id)
      .slice(0, CALENDAR_EVENTS_CAP);
  }

  /**
   * Step two: the caller's own RSVP for exactly this page.
   *
   * As a `LEFT JOIN` in step three the planner hashes the caller's whole attendee set
   * (1,128 blocks); as a `LEFT JOIN LATERAL` it probes once per row and pays 1,834. As
   * its own statement over the page's identifiers it is one index scan of
   * `event_attendees_event_membership_unique` for 501.
   */
  private async callerRsvp(
    orgId: string,
    callerMembershipId: number,
    ids: number[],
  ): Promise<Map<number, string>> {
    const byEvent = new Map<number, string>();
    if (callerMembershipId === 0 || ids.length === 0) return byEvent;

    const rows = await this.database
      .select({ eventId: eventAttendees.eventId, status: eventAttendees.status })
      .from(eventAttendees)
      .where(
        and(
          eq(eventAttendees.orgId, orgId),
          eq(eventAttendees.membershipId, callerMembershipId),
          inArray(eventAttendees.eventId, ids),
        ),
      );
    for (const row of rows) byEvent.set(row.eventId, row.status);
    return byEvent;
  }

  /**
   * Step three: the wide projection, for identifiers already known to be visible.
   *
   * The visibility rule is re-asserted rather than trusted from step one, so the rows
   * this method returns are never wider than the rule — but it is asserted against the
   * attendance already read in step two, so it costs no join.
   */
  private async fetchEvents(
    orgId: string,
    callerMembershipId: number,
    ids: number[],
    attendedIds: number[],
  ): Promise<Array<Omit<VisibleEventRow, "rsvpStatus" | "creatorName">>> {
    if (ids.length === 0) return [];

    const visible = or(
      eq(calendarEvents.visibility, "org"),
      eq(calendarEvents.createdByMembershipId, callerMembershipId),
      attendedIds.length === 0 ? sql`false` : inArray(calendarEvents.id, attendedIds),
    );

    return this.database
      .select({
        id: calendarEvents.id,
        title: calendarEvents.title,
        description: calendarEvents.description,
        location: calendarEvents.location,
        meetingUrl: calendarEvents.meetingUrl,
        startDate: calendarEvents.startDate,
        endDate: calendarEvents.endDate,
        allDay: calendarEvents.allDay,
        timezone: calendarEvents.timezone,
        color: calendarEvents.color,
        category: calendarEvents.category,
        entityType: calendarEvents.entityType,
        entityId: calendarEvents.entityId,
        visibility: calendarEvents.visibility,
        rrule: calendarEvents.rrule,
        recurrenceEnd: calendarEvents.recurrenceEnd,
        createdByMembershipId: calendarEvents.createdByMembershipId,
      })
      .from(calendarEvents)
      .where(and(eq(calendarEvents.orgId, orgId), inArray(calendarEvents.id, ids), visible))
      .orderBy(asc(calendarEvents.startDate), asc(calendarEvents.id));
  }
}
