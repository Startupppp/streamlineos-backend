import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, gte, lte, inArray } from "drizzle-orm";
import {
  calendarEvents,
  calendarEventExceptions,
  eventAttendees,
  leaveRequests,
  users,
  userIntegrationConnections,
  organizationMembers,
  notificationOutbox,
} from "../../db/schema";
import { ExternalCalendarSyncService } from "./external-calendar-sync.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CreateEventInput, RsvpInput, UpdateEventInput } from "./dto/calendar.schemas";
import type { UpsertOccurrenceExceptionInput } from "./dto/occurrence-exception.schemas";
import { CalendarEventsAggregateService } from "./calendar-events-aggregate.service";
import { CalendarConflictService } from "./calendar-conflict.service";
import type { CalendarEventItem, CalendarEventsResult, OooConflict } from "./calendar.types";
import { dateOnly } from "./calendar.types";
import { assertUsersInOrg } from "../../common/tenant/org-membership";

@Injectable()
export class CalendarService {
  private readonly logger = new Logger(CalendarService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly sync: ExternalCalendarSyncService,
    private readonly eventsAggregate: CalendarEventsAggregateService,
    private readonly conflict: CalendarConflictService,
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

    const [{ event, eventConflicts, attendeeMemberships }, oooConflicts] = await Promise.all([
      this.db.transaction(async (tx) => {
        const conflicts = await this.conflict.checkConflictsInTx(
          tx,
          orgId,
          userId,
          startDate,
          endDate,
        );
        const insertedRows = await tx
          .insert(calendarEvents)
          .values({
            orgId,
            createdBy: userId,
            title: input.title,
            description: input.description ?? null,
            location: input.location ?? null,
            startDate,
            endDate,
            timezone: input.timezone,
            allDay: input.allDay ?? false,
            color: input.color ?? "blue",
            category: input.category,
            entityType: input.entityType ?? null,
            entityId: input.entityId ?? null,
            agenda: input.agenda ?? null,
            linkedDealId: input.linkedDealId ?? null,
            linkedLeadId: input.linkedLeadId ?? null,
            rrule: input.rrule ?? null,
            recurrenceEnd: input.recurrenceEnd ? new Date(input.recurrenceEnd) : null,
          })
          .returning();
        const memberships = attendeeIds.length === 0 ? [] : await tx
          .select({ id: organizationMembers.id, userId: organizationMembers.userId })
          .from(organizationMembers)
          .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, attendeeIds)));
        const event = insertedRows[0];
        if (event && memberships.length > 0)
          await tx.insert(eventAttendees).values(memberships.map((membership) => ({
            orgId,
            eventId: event.id,
            membershipId: membership.id,
            userId: membership.userId,
          }))).onConflictDoNothing();
        if (event && memberships.some((membership) => membership.userId !== userId))
          await tx.insert(notificationOutbox).values({
            orgId,
            eventKey: "calendar.event.invited",
            dedupeKey: `calendar:event:${event.id}:invited`,
            actorUserId: userId,
            targetUserIds: memberships.map((membership) => membership.userId).filter((recipientId) => recipientId !== userId),
            entityType: "calendar_event",
            entityId: String(event.id),
            title: `Calendar invite: ${input.title}`,
            message: `You have been invited to "${input.title}" on ${startDate.toDateString()}`,
            link: "/calendar",
            variables: {
              eventTitle: input.title,
              startIso: startDate.toISOString(),
              endIso: endDate.toISOString(),
              allDay: input.allDay ?? false,
              location: input.location ?? null,
              description: input.description ?? null,
            },
          }).onConflictDoNothing({ target: [notificationOutbox.orgId, notificationOutbox.dedupeKey] });
        return { event, eventConflicts: conflicts, attendeeMemberships: memberships };
      }),
      this.getOooConflicts(orgId, attendeeIds, startDate, endDate),
    ] as const);

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
    return { event: syncedEvent, oooConflicts, eventConflicts, meetingUrl, syncError };
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
    }
    if (input.timezone !== undefined) updateData.timezone = input.timezone;
    if (input.agenda !== undefined) updateData.agenda = input.agenda ?? null;
    if (input.postMeetingNotes !== undefined)
      updateData.postMeetingNotes = input.postMeetingNotes ?? null;
    if (input.linkedDealId !== undefined) updateData.linkedDealId = input.linkedDealId ?? null;
    if (input.linkedLeadId !== undefined) updateData.linkedLeadId = input.linkedLeadId ?? null;
    if (input.rrule !== undefined) updateData.rrule = input.rrule ?? null;
    if (input.recurrenceEnd !== undefined)
      updateData.recurrenceEnd = input.recurrenceEnd ? new Date(input.recurrenceEnd) : null;

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

    if (event && input.attendeeIds !== undefined) {
      const memberships = await this.db
        .select({ id: organizationMembers.id, userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, input.attendeeIds)));
      await this.db.delete(eventAttendees).where(and(eq(eventAttendees.orgId, orgId), eq(eventAttendees.eventId, id)));
      if (memberships.length > 0)
        await this.db.insert(eventAttendees).values(memberships.map((membership) => ({
          orgId,
          eventId: id,
          membershipId: membership.id,
          userId: membership.userId,
        }))).onConflictDoNothing();
    }

    if (event?.integrationConnectionId && event.externalEventId) {
      try {
        const conn = await this.ownedActiveConnection(orgId, userId, event.integrationConnectionId);
        const updateResult = await this.sync.pushUpdate(userId, conn, event.externalEventId, {
          title: event.title,
          description: event.description ?? null,
          startIso: event.startDate.toISOString(),
          endIso: event.endDate.toISOString(),
        });
        if (!updateResult.success)
          this.logger.warn(`External sync update skipped for ${conn.toolkit}: ${updateResult.reason}`);
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
        const deleteResult = await this.sync.pushDelete(userId, conn, mapping.externalEventId);
        if (!deleteResult.success)
          this.logger.warn(`External sync delete skipped for ${conn.toolkit}: ${deleteResult.reason}`);
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

    const membership = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { id: true },
    });
    if (!membership) return null;

    const [attendee] = await this.db
      .insert(eventAttendees)
      .values({
        orgId,
        eventId: id,
        membershipId: membership.id,
        userId,
        status: input.status,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [eventAttendees.orgId, eventAttendees.eventId, eventAttendees.membershipId],
        set: { status: input.status, updatedAt: new Date() },
      })
      .returning();

    return attendee;
  }

  async listAttendees(orgId: string, id: number) {
    const event = await this.getEventForOrg(orgId, id);
    if (!event) return null;

    return this.db.query.eventAttendees.findMany({
      where: and(eq(eventAttendees.orgId, orgId), eq(eventAttendees.eventId, id)),
      limit: 100,
      with: {
        user: { columns: { id: true, name: true, email: true, image: true } },
      },
    });
  }

  private async getRecurringEventForOwner(orgId: string, userId: string, eventId: number) {
    const rows = await this.db
      .select({ createdBy: calendarEvents.createdBy, rrule: calendarEvents.rrule })
      .from(calendarEvents)
      .where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.orgId, orgId)))
      .limit(1);
    const ev = rows[0];
    if (!ev || ev.createdBy !== userId || !ev.rrule) return null;
    return ev;
  }

  async upsertOccurrenceException(
    orgId: string,
    userId: string,
    eventId: number,
    occurrenceStartIso: string,
    input: UpsertOccurrenceExceptionInput,
  ) {
    if (!(await this.getRecurringEventForOwner(orgId, userId, eventId))) return null;
    const occurrenceStart = new Date(occurrenceStartIso);
    const [row] = await this.db
      .insert(calendarEventExceptions)
      .values({
        orgId,
        eventId,
        occurrenceStart,
        isCancelled: false,
        modifiedTitle: input.modifiedTitle ?? null,
        modifiedStart: input.modifiedStart ? new Date(input.modifiedStart) : null,
        modifiedEnd: input.modifiedEnd ? new Date(input.modifiedEnd) : null,
      })
      .onConflictDoUpdate({
        target: [calendarEventExceptions.orgId, calendarEventExceptions.eventId, calendarEventExceptions.occurrenceStart],
        set: {
          isCancelled: false,
          modifiedTitle: input.modifiedTitle ?? null,
          modifiedStart: input.modifiedStart ? new Date(input.modifiedStart) : null,
          modifiedEnd: input.modifiedEnd ? new Date(input.modifiedEnd) : null,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  async cancelOccurrence(orgId: string, userId: string, eventId: number, occurrenceStartIso: string) {
    if (!(await this.getRecurringEventForOwner(orgId, userId, eventId))) return null;
    const occurrenceStart = new Date(occurrenceStartIso);
    const [row] = await this.db
      .insert(calendarEventExceptions)
      .values({ orgId, eventId, occurrenceStart, isCancelled: true })
      .onConflictDoUpdate({
        target: [calendarEventExceptions.orgId, calendarEventExceptions.eventId, calendarEventExceptions.occurrenceStart],
        set: { isCancelled: true, updatedAt: new Date() },
      })
      .returning();
    return row;
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
