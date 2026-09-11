import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, or } from "drizzle-orm";
import {
  calendarEvents,
  eventAttendees,
  organizationMembers,
  projects,
  tickets,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { z } from "zod";
import { calendarEventDetailSchema } from "./dto/calendar-response.schemas";

@Injectable()
export class CalendarEventDetailService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getEvent(
    orgId: string,
    userId: string,
    eventId: number,
  ): Promise<z.infer<typeof calendarEventDetailSchema> | null> {
    const membership = await this.db.query.organizationMembers.findFirst({
      columns: { id: true },
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
    });
    const callerMembershipId = membership?.id ?? 0;

    const rows = await this.db
      .select({
        id: calendarEvents.id,
        title: calendarEvents.title,
        startDate: calendarEvents.startDate,
        endDate: calendarEvents.endDate,
        allDay: calendarEvents.allDay,
        timezone: calendarEvents.timezone,
        color: calendarEvents.color,
        category: calendarEvents.category,
        entityType: calendarEvents.entityType,
        entityId: calendarEvents.entityId,
        location: calendarEvents.location,
        meetingUrl: calendarEvents.meetingUrl,
        description: calendarEvents.description,
        rrule: calendarEvents.rrule,
        createdByMembershipId: calendarEvents.createdByMembershipId,
      })
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.orgId, orgId),
          eq(calendarEvents.id, eventId),
          or(
            eq(calendarEvents.visibility, "org"),
            eq(calendarEvents.createdByMembershipId, callerMembershipId),
          ),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    const [creatorRows, rsvpRows] = await Promise.all([
      this.db
        .select({ name: users.name })
        .from(organizationMembers)
        .leftJoin(users, and(eq(users.id, organizationMembers.userId), isNull(users.deletedAt)))
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.id, row.createdByMembershipId),
          ),
        )
        .limit(1),
      callerMembershipId > 0
        ? this.db
            .select({ status: eventAttendees.status })
            .from(eventAttendees)
            .where(
              and(
                eq(eventAttendees.orgId, orgId),
                eq(eventAttendees.eventId, eventId),
                eq(eventAttendees.membershipId, callerMembershipId),
              ),
            )
            .limit(1)
        : Promise.resolve([]),
    ]);

    let linkedTicket: z.infer<typeof calendarEventDetailSchema>["linkedTicket"] = null;
    if (row.entityType === "ticket" && row.entityId !== null) {
      const ticketId = parseInt(row.entityId, 10);
      if (!Number.isNaN(ticketId)) {
        const ticketRows = await this.db
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
          .where(
            and(eq(tickets.orgId, orgId), eq(tickets.id, ticketId), isNull(projects.deletedAt)),
          )
          .limit(1);
        const t = ticketRows[0];
        if (t)
          linkedTicket = {
            id: t.id,
            key: `${t.projectKey}-${t.ticketNumber}`,
            title: t.title,
            projectId: t.projectId,
            status: t.status,
          };
      }
    }

    return {
      id: row.id,
      title: row.title,
      startDate: row.startDate,
      endDate: row.endDate,
      allDay: row.allDay,
      timezone: row.timezone,
      color: row.color,
      category: row.category,
      entityType: row.entityType,
      entityId: row.entityId,
      location: row.location,
      meetingUrl: row.meetingUrl,
      description: row.description,
      creatorName: creatorRows[0]?.name ?? null,
      myRsvpStatus: rsvpRows[0]?.status ?? null,
      linkedTicket,
      rrule: row.rrule,
      isRecurring: row.rrule !== null,
    };
  }
}
