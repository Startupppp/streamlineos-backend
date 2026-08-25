import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, gte, lte, inArray } from "drizzle-orm";
import {
  calendarEvents,
  eventAttendees,
  leaveRequests,
  users,
  userIntegrationConnections,
  organizationMembers,
} from "../../db/schema";
import { ExternalCalendarSyncService } from "./external-calendar-sync.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CreateEventInput, RsvpInput, UpdateEventInput } from "./dto/calendar.schemas";
import { EmailService } from "../email/email.service";
import { getCalendarInviteEmail } from "../email/templates/calendar";
import { CalendarEventsAggregateService } from "./calendar-events-aggregate.service";
import type { CalendarEventItem, CalendarEventsResult, OooConflict } from "./calendar.types";
import { dateOnly } from "./calendar.types";
import { assertUsersInOrg } from "../../common/tenant/org-membership";

@Injectable()
export class CalendarService {
  private readonly logger = new Logger(CalendarService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly sync: ExternalCalendarSyncService,
    private readonly email: EmailService,
    private readonly eventsAggregate: CalendarEventsAggregateService,
  ) {}

  getEvents(
    orgId: string,
    userId: string,
    start: Date,
    end: Date,
  ): Promise<CalendarEventsResult> {
    return this.eventsAggregate.getEvents(orgId, userId, start, end);
  }

  private async getOooConflicts(
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

  async createEvent(orgId: string, userId: string, input: CreateEventInput) {
    const startDate = new Date(input.startDate);
    const endDate = new Date(input.endDate);
    const attendeeIds = input.attendeeIds ?? [];

    await assertUsersInOrg(this.db, orgId, attendeeIds);

    const [event, oooConflicts] = await Promise.all([
      this.db
        .insert(calendarEvents)
        .values({
          orgId,
          createdBy: userId,
          title: input.title,
          description: input.description ?? null,
          location: input.location ?? null,
          startDate,
          endDate,
          allDay: input.allDay ?? false,
          color: input.color ?? "blue",
          category: input.category,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          attendeeIds,
          isRecurring: input.isRecurring ?? false,
          recurringRule: input.recurringRule ?? null,
          agenda: input.agenda ?? null,
          linkedDealId: input.linkedDealId ?? null,
          linkedLeadId: input.linkedLeadId ?? null,
        })
        .returning()
        .then((rows) => rows[0]),
      this.getOooConflicts(orgId, attendeeIds, startDate, endDate),
    ]);

    let meetingUrl: string | null = null;
    let syncError: string | null = null;
    let syncedEvent = event;
    if (event && input.syncConnectionId) {
      try {
        const conn = await this.ownedActiveConnection(orgId, userId, input.syncConnectionId);
        const attendeeEmailList = await this.attendeeEmails(orgId, attendeeIds);
        const pushed = await this.sync.pushCreate(userId, conn, {
          title: input.title,
          description: input.description ?? null,
          startIso: startDate.toISOString(),
          endIso: endDate.toISOString(),
          allDay: input.allDay ?? false,
          attendeeEmails: attendeeEmailList,
          addConference: input.addConference ?? false,
        });
        meetingUrl = pushed.meetingUrl ?? null;
        const rows = await this.db
          .update(calendarEvents)
          .set({
            integrationConnectionId: conn.id,
            externalEventId: pushed.externalEventId,
            meetingUrl,
          })
          .where(eq(calendarEvents.id, event.id))
          .returning();
        syncedEvent = rows[0] ?? event;
      } catch (error) {
        syncError = error instanceof Error ? error.message : "Failed to sync to external calendar";
      }
    }
    if (event) {
      void this.dispatchInviteEmails({
        orgId,
        organizerId: userId,
        attendeeIds,
        title: input.title,
        start: startDate,
        end: endDate,
        allDay: input.allDay ?? false,
        location: input.location ?? null,
        meetingUrl,
        description: input.description ?? null,
      }).catch((err) =>
        this.logger.warn(
          `Failed to dispatch calendar invite emails for event ${event.id}: ${String(err)}`,
        ),
      );
    }
    return { event: syncedEvent, oooConflicts, meetingUrl, syncError };
  }

  private async dispatchInviteEmails(params: {
    orgId: string;
    organizerId: string;
    attendeeIds: string[];
    title: string;
    start: Date;
    end: Date;
    allDay: boolean;
    location: string | null;
    meetingUrl: string | null;
    description: string | null;
  }): Promise<void> {
    const recipientIds = params.attendeeIds.filter(
      (id) => id !== params.organizerId,
    );
    if (recipientIds.length === 0) return;

    const [recipients, organizerRows] = await Promise.all([
      this.db
        .select({
          email: users.email,
          name: users.name,
          firstName: users.firstName,
          lastName: users.lastName,
        })
        .from(users)
        .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
        .where(
          and(
            inArray(users.id, recipientIds),
            eq(organizationMembers.orgId, params.orgId),
            eq(organizationMembers.status, "ACTIVE"),
          ),
        ),
      this.db
        .select({
          name: users.name,
          firstName: users.firstName,
          lastName: users.lastName,
        })
        .from(users)
        .where(eq(users.id, params.organizerId))
        .limit(1),
    ]);

    const org = organizerRows[0];
    const organizerName = org
      ? org.firstName
        ? `${org.firstName} ${org.lastName ?? ""}`.trim()
        : (org.name ?? "A colleague")
      : "A colleague";

    await Promise.allSettled(
      recipients
        .filter((r) => r.email)
        .map((r) => {
          const recipientName = r.firstName
            ? `${r.firstName} ${r.lastName ?? ""}`.trim()
            : (r.name ?? r.email);
          const { subject, html } = getCalendarInviteEmail({
            recipientName,
            organizerName,
            title: params.title,
            start: params.start,
            end: params.end,
            allDay: params.allDay,
            location: params.location,
            meetingUrl: params.meetingUrl,
            description: params.description,
          });
          return this.email.sendEmail({ to: r.email, subject, html });
        }),
    );
  }

  async updateEvent(orgId: string, userId: string, id: number, input: UpdateEventInput) {
    const updateData: Record<string, unknown> = {};
    if (input.title !== undefined) updateData.title = input.title;
    if (input.description !== undefined) updateData.description = input.description ?? null;
    if (input.location !== undefined) updateData.location = input.location ?? null;
    if (input.startDate !== undefined) updateData.startDate = new Date(input.startDate);
    if (input.endDate !== undefined) updateData.endDate = new Date(input.endDate);
    if (input.allDay !== undefined) updateData.allDay = input.allDay;
    if (input.color !== undefined) updateData.color = input.color ?? null;
    if (input.category !== undefined) updateData.category = input.category;
    if (input.entityType !== undefined) updateData.entityType = input.entityType ?? null;
    if (input.entityId !== undefined) updateData.entityId = input.entityId ?? null;
    if (input.attendeeIds !== undefined) {
      await assertUsersInOrg(this.db, orgId, input.attendeeIds);
      updateData.attendeeIds = input.attendeeIds;
    }
    if (input.isRecurring !== undefined) updateData.isRecurring = input.isRecurring;
    if (input.recurringRule !== undefined) updateData.recurringRule = input.recurringRule ?? null;
    if (input.agenda !== undefined) updateData.agenda = input.agenda ?? null;
    if (input.postMeetingNotes !== undefined)
      updateData.postMeetingNotes = input.postMeetingNotes ?? null;
    if (input.linkedDealId !== undefined) updateData.linkedDealId = input.linkedDealId ?? null;
    if (input.linkedLeadId !== undefined) updateData.linkedLeadId = input.linkedLeadId ?? null;

    const [event] = await this.db
      .update(calendarEvents)
      .set({ ...updateData, updatedAt: new Date() })
      .where(
        and(
          eq(calendarEvents.id, id),
          eq(calendarEvents.orgId, orgId),
          eq(calendarEvents.createdBy, userId),
        ),
      )
      .returning();

    if (event?.integrationConnectionId && event.externalEventId) {
      try {
        const conn = await this.ownedActiveConnection(orgId, userId, event.integrationConnectionId);
        await this.sync.pushUpdate(userId, conn, event.externalEventId, {
          title: event.title,
          description: event.description ?? null,
          startIso: event.startDate.toISOString(),
          endIso: event.endDate.toISOString(),
        });
      } catch (error) {
        this.logger.warn(
          `External sync update failed for event ${event.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return event ?? null;
  }

  async deleteEvent(orgId: string, userId: string, id: number) {
    const rows = await this.db
      .select({
        integrationConnectionId: calendarEvents.integrationConnectionId,
        externalEventId: calendarEvents.externalEventId,
      })
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.id, id),
          eq(calendarEvents.orgId, orgId),
          eq(calendarEvents.createdBy, userId),
        ),
      )
      .limit(1);
    const mapping = rows[0];

    await this.db
      .delete(calendarEvents)
      .where(
        and(
          eq(calendarEvents.id, id),
          eq(calendarEvents.orgId, orgId),
          eq(calendarEvents.createdBy, userId),
        ),
      );

    if (mapping?.integrationConnectionId && mapping.externalEventId) {
      try {
        const conn = await this.ownedActiveConnection(orgId, userId, mapping.integrationConnectionId);
        await this.sync.pushDelete(userId, conn, mapping.externalEventId);
      } catch (error) {
        this.logger.warn(
          `External sync delete failed for event ${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { deleted: true };
  }

  private async ownedActiveConnection(orgId: string, userId: string, connectionId: number) {
    const rows = await this.db
      .select({
        id: userIntegrationConnections.id,
        toolkit: userIntegrationConnections.toolkit,
        composioConnectedAccountId: userIntegrationConnections.composioConnectedAccountId,
      })
      .from(userIntegrationConnections)
      .where(
        and(
          eq(userIntegrationConnections.id, connectionId),
          eq(userIntegrationConnections.orgId, orgId),
          eq(userIntegrationConnections.userId, userId),
          eq(userIntegrationConnections.status, "active"),
          inArray(userIntegrationConnections.toolkit, ["googlecalendar", "outlook"]),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row || (row.toolkit !== "googlecalendar" && row.toolkit !== "outlook")) {
      throw new Error("Calendar account connection not found");
    }
    return { id: row.id, toolkit: row.toolkit, composioConnectedAccountId: row.composioConnectedAccountId };
  }

  private async attendeeEmails(orgId: string, attendeeIds: string[]): Promise<string[]> {
    if (attendeeIds.length === 0) return [];
    const rows = await this.db
      .select({ email: users.email })
      .from(users)
      .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
      .where(
        and(
          inArray(users.id, attendeeIds),
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
      );
    return rows.map((r) => r.email);
  }

  private getEventForOrg(orgId: string, id: number) {
    return this.db.query.calendarEvents.findFirst({
      where: and(eq(calendarEvents.id, id), eq(calendarEvents.orgId, orgId)),
    });
  }

  async rsvp(orgId: string, userId: string, id: number, input: RsvpInput) {
    const event = await this.getEventForOrg(orgId, id);
    if (!event) return null;

    const [attendee] = await this.db
      .insert(eventAttendees)
      .values({
        eventId: id,
        userId,
        status: input.status,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [eventAttendees.eventId, eventAttendees.userId],
        set: { status: input.status, updatedAt: new Date() },
      })
      .returning();

    return attendee;
  }

  async listAttendees(orgId: string, id: number) {
    const event = await this.getEventForOrg(orgId, id);
    if (!event) return null;

    return this.db.query.eventAttendees.findMany({
      where: eq(eventAttendees.eventId, id),
      limit: 100,
      with: {
        user: { columns: { id: true, name: true, email: true, image: true } },
      },
    });
  }

  exportEvents(orgId: string, from: Date, to: Date) {
    return this.db.query.calendarEvents.findMany({
      where: and(
        eq(calendarEvents.orgId, orgId),
        gte(calendarEvents.startDate, from),
        lte(calendarEvents.startDate, to),
      ),
      orderBy: (t, { asc }) => [asc(t.startDate)],
      limit: 100,
    });
  }
}
