import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, like } from "drizzle-orm";
import {
  calendarEvents,
  calendarProviderSyncQueue,
  eventAttendees,
  users,
  organizationMembers,
  notificationOutbox,
} from "../../db/schema";
import type { TenantTx } from "../../db/drizzle.types";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CreateEventInput, UpdateEventInput } from "./dto/calendar.schemas";
import type { UpsertOccurrenceExceptionInput } from "./dto/occurrence-exception.schemas";
import { CalendarEventsAggregateService } from "./calendar-events-aggregate.service";
import { CalendarConflictService } from "./calendar-conflict.service";
import type { CalendarEventItem, CalendarEventsResult } from "./calendar.types";
import { assertUsersInOrg } from "../../common/tenant/org-membership";
import { CalendarAttendeesService } from "./calendar-attendees.service";
import { CalendarRecurrenceService } from "./calendar-recurrence.service";
import { CalendarExportService } from "./calendar-export.service";
import type { RsvpInput } from "./dto/calendar.schemas";
import type { DataScope } from "../access/access.types";

@Injectable()
export class CalendarService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly eventsAggregate: CalendarEventsAggregateService,
    private readonly conflict: CalendarConflictService,
    private readonly attendees: CalendarAttendeesService,
    private readonly recurrence: CalendarRecurrenceService,
    private readonly calendarExport: CalendarExportService,
  ) {}

  getEvents(
    orgId: string,
    userId: string,
    start: Date,
    end: Date,
  ): Promise<CalendarEventsResult> {
    return this.eventsAggregate.getEvents(orgId, userId, start, end);
  }

  async createEvent(orgId: string, userId: string, input: CreateEventInput) {
    const startDate = new Date(input.startDate);
    const endDate = new Date(input.endDate);
    const attendeeIds = input.attendeeIds ?? [];

    await assertUsersInOrg(this.db, orgId, attendeeIds);

    const [{ event, eventConflicts, attendeeMemberships }, oooConflicts] = await Promise.all([
      this.db.transaction(async (tx) => {
        const creatorMembership = await tx.query.organizationMembers.findFirst({
          columns: { id: true },
          where: and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.userId, userId),
            eq(organizationMembers.status, "ACTIVE"),
          ),
        });
        if (!creatorMembership) throw new Error("Active organization membership required");
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
            createdByMembershipId: creatorMembership.id,
            title: input.title,
            description: input.description ?? null,
            location: input.location ?? null,
            startDate,
            endDate,
            timezone: input.timezone,
            allDay: input.allDay ?? false,
            color: input.color ?? "blue",
            category: input.category,
            visibility: input.visibility ?? "org",
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

        if (event && input.syncConnectionId) {
          const attendeeEmailList = await this.attendeeEmails(orgId, attendeeIds);
          await tx.insert(calendarProviderSyncQueue).values({
            orgId,
            eventId: event.id,
            connectionId: input.syncConnectionId,
            operation: "create",
            payload: {
              userId,
              title: input.title,
              description: input.description ?? null,
              startIso: startDate.toISOString(),
              endIso: endDate.toISOString(),
              allDay: input.allDay ?? false,
              attendeeEmails: attendeeEmailList,
              addConference: input.addConference ?? false,
            },
          });
        }

        return { event, eventConflicts: conflicts, attendeeMemberships: memberships };
      }),
      this.conflict.getOooConflicts(orgId, attendeeIds, startDate, endDate),
    ] as const);

    return { event, oooConflicts, eventConflicts, meetingUrl: null, syncQueued: !!input.syncConnectionId };
  }

  async updateEvent(orgId: string, userId: string, id: number, input: UpdateEventInput) {
    if (input.attendeeIds !== undefined)
      await assertUsersInOrg(this.db, orgId, input.attendeeIds);

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
    if (input.timezone !== undefined) updateData.timezone = input.timezone;
    if (input.agenda !== undefined) updateData.agenda = input.agenda ?? null;
    if (input.postMeetingNotes !== undefined)
      updateData.postMeetingNotes = input.postMeetingNotes ?? null;
    if (input.linkedDealId !== undefined) updateData.linkedDealId = input.linkedDealId ?? null;
    if (input.linkedLeadId !== undefined) updateData.linkedLeadId = input.linkedLeadId ?? null;
    if (input.rrule !== undefined) updateData.rrule = input.rrule ?? null;
    if (input.recurrenceEnd !== undefined)
      updateData.recurrenceEnd = input.recurrenceEnd ? new Date(input.recurrenceEnd) : null;
    if (input.visibility !== undefined) updateData.visibility = input.visibility;

    const timeChanged =
      input.startDate !== undefined ||
      input.endDate !== undefined ||
      input.timezone !== undefined ||
      input.rrule !== undefined ||
      input.recurrenceEnd !== undefined;
    if (timeChanged) updateData.reminder15MinSent = false;

    const event = await this.db.transaction(async (tx) => {
      const memberRow = await tx.query.organizationMembers.findFirst({
        columns: { id: true },
        where: and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, userId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
      });
      if (!memberRow) return null;
      const rows = await tx
        .update(calendarEvents)
        .set({ ...updateData, updatedAt: new Date() })
        .where(
          and(
            eq(calendarEvents.id, id),
            eq(calendarEvents.orgId, orgId),
            eq(calendarEvents.createdByMembershipId, memberRow.id),
          ),
        )
        .returning();
      const updated = rows[0] ?? null;
      if (!updated) return null;

      if (timeChanged)
        await tx
          .update(notificationOutbox)
          .set({ state: "DEAD" })
          .where(
            and(
              eq(notificationOutbox.orgId, orgId),
              eq(notificationOutbox.state, "PENDING"),
              like(notificationOutbox.dedupeKey, `calendar:reminder:${id}:%`),
            ),
          );

      const newAttendeeIds =
        input.attendeeIds !== undefined
          ? await this.updateAttendeesInTx(tx, orgId, id, input.attendeeIds, userId)
          : [];

      if (newAttendeeIds.length > 0)
        await tx
          .insert(notificationOutbox)
          .values({
            orgId,
            eventKey: "calendar.event.invited",
            dedupeKey: `calendar:event:${id}:update:${updated.updatedAt.toISOString()}:invited`,
            actorUserId: userId,
            targetUserIds: newAttendeeIds,
            entityType: "calendar_event",
            entityId: String(id),
            title: `Calendar invite: ${updated.title}`,
            message: `You have been invited to "${updated.title}"`,
            link: "/calendar",
            variables: { eventTitle: updated.title },
          })
          .onConflictDoNothing({ target: [notificationOutbox.orgId, notificationOutbox.dedupeKey] });

      if (updated.integrationConnectionId && updated.externalEventId)
        await tx.insert(calendarProviderSyncQueue).values({
          orgId,
          eventId: updated.id,
          connectionId: updated.integrationConnectionId,
          operation: "update",
          externalEventId: updated.externalEventId,
          payload: {
            userId,
            title: updated.title,
            description: updated.description ?? null,
            startIso: updated.startDate.toISOString(),
            endIso: updated.endDate.toISOString(),
          },
        });

      return updated;
    });

    return event;
  }

  private async updateAttendeesInTx(
    tx: TenantTx,
    orgId: string,
    eventId: number,
    attendeeIds: string[],
    actorUserId: string,
  ): Promise<string[]> {
    const current = await tx
      .select({ userId: organizationMembers.userId })
      .from(eventAttendees)
      .innerJoin(
        organizationMembers,
        and(eq(eventAttendees.orgId, organizationMembers.orgId), eq(eventAttendees.membershipId, organizationMembers.id)),
      )
      .where(and(eq(eventAttendees.orgId, orgId), eq(eventAttendees.eventId, eventId)));

    const currentUserIds = new Set(current.map((a) => a.userId));

    const memberships =
      attendeeIds.length === 0
        ? []
        : await tx
            .select({ id: organizationMembers.id, userId: organizationMembers.userId })
            .from(organizationMembers)
            .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, attendeeIds)));

    const newUserIdSet = new Set(memberships.map((m) => m.userId));
    const anyRemoved = [...currentUserIds].some((uid) => !newUserIdSet.has(uid));

    await tx
      .delete(eventAttendees)
      .where(and(eq(eventAttendees.orgId, orgId), eq(eventAttendees.eventId, eventId)));

    if (memberships.length > 0)
      await tx
        .insert(eventAttendees)
        .values(memberships.map((m) => ({ orgId, eventId, membershipId: m.id })))
        .onConflictDoNothing();

    if (anyRemoved) {
      await tx
        .delete(notificationOutbox)
        .where(
          and(
            eq(notificationOutbox.orgId, orgId),
            eq(notificationOutbox.state, "PENDING"),
            like(notificationOutbox.dedupeKey, `calendar:reminder:${eventId}:%`),
          ),
        );
      await tx
        .update(calendarEvents)
        .set({ reminder15MinSent: false })
        .where(
          and(
            eq(calendarEvents.orgId, orgId),
            eq(calendarEvents.id, eventId),
            eq(calendarEvents.reminder15MinSent, true),
          ),
        );
    }

    return memberships
      .filter((m) => !currentUserIds.has(m.userId) && m.userId !== actorUserId)
      .map((m) => m.userId);
  }

  async deleteEvent(orgId: string, userId: string, id: number) {
    let removed = 0;
    const [mapping] = await this.db.transaction(async (tx) => {
      const memberRow = await tx.query.organizationMembers.findFirst({
        columns: { id: true },
        where: and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, userId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
      });
      if (!memberRow) return [];
      const deleted = await tx
        .delete(calendarEvents)
        .where(
          and(
            eq(calendarEvents.id, id),
            eq(calendarEvents.orgId, orgId),
            eq(calendarEvents.createdByMembershipId, memberRow.id),
          ),
        )
        .returning({
          integrationConnectionId: calendarEvents.integrationConnectionId,
          externalEventId: calendarEvents.externalEventId,
        });
      removed = deleted.length;
      if (deleted.length > 0) {
        await tx
          .update(notificationOutbox)
          .set({ state: "DEAD" })
          .where(
            and(
              eq(notificationOutbox.orgId, orgId),
              eq(notificationOutbox.state, "PENDING"),
              like(notificationOutbox.dedupeKey, `calendar:reminder:${id}:%`),
            ),
          );
        const d = deleted[0];
        if (d?.integrationConnectionId && d.externalEventId)
          await tx.insert(calendarProviderSyncQueue).values({
            orgId,
            eventId: null,
            connectionId: d.integrationConnectionId,
            operation: "delete",
            externalEventId: d.externalEventId,
            payload: { userId },
          });
      }
      return deleted;
    });

    if (removed === 0) return null;
    return { deleted: true };
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

  rsvp(orgId: string, userId: string, id: number, input: RsvpInput) {
    return this.attendees.rsvp(orgId, userId, id, input);
  }

  listAttendees(orgId: string, userId: string, id: number) {
    return this.attendees.listAttendees(orgId, userId, id);
  }

  upsertOccurrenceException(
    orgId: string,
    userId: string,
    eventId: number,
    occurrenceStartIso: string,
    input: UpsertOccurrenceExceptionInput,
  ) {
    return this.recurrence.upsertOccurrenceException(orgId, userId, eventId, occurrenceStartIso, input);
  }

  cancelOccurrence(orgId: string, userId: string, eventId: number, occurrenceStartIso: string) {
    return this.recurrence.cancelOccurrence(orgId, userId, eventId, occurrenceStartIso);
  }

  exportEvents(orgId: string, userId: string, from: Date, to: Date, scope: DataScope = "all") {
    return this.calendarExport.exportEvents(orgId, userId, from, to, scope);
  }
}
