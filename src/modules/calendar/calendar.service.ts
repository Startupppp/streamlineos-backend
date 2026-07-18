import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, gte, lte, isNotNull, inArray } from "drizzle-orm";
import {
  calendarEvents,
  eventAttendees,
  leaveRequests,
  interviews,
  tasks,
  holidays,
  users,
  tickets,
  projects,
  projectMembers,
  userIntegrationConnections,
} from "../../db/schema";
import { ExternalCalendarSyncService } from "./external-calendar-sync.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CreateEventInput, RsvpInput, UpdateEventInput } from "./dto/calendar.schemas";
import { EmailService } from "../email/email.service";
import { getCalendarInviteEmail } from "../email/templates/calendar";

export interface LinkedTicket {
  id: number;
  key: string;
  title: string;
  projectId: number;
  status: string;
}

export interface CalendarEventItem {
  id: string;
  title: string;
  start: Date;
  end: Date;
  allDay?: boolean;
  color?: string | null;
  category: string;
  source: "event" | "leave" | "interview" | "task" | "holiday";
  location?: string | null;
  meetingUrl?: string | null;
  description?: string | null;
  creatorName?: string | null;
  entityId?: string | null;
  entityType?: string | null;
  myRsvpStatus?: string | null;
  projectId?: number | null;
  linkedTicket?: LinkedTicket | null;
}

export interface OooConflict {
  userId: string;
  userName: string | null;
  leaveStart: string;
  leaveEnd: string;
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

@Injectable()
export class CalendarService {
  private readonly logger = new Logger(CalendarService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly sync: ExternalCalendarSyncService,
    private readonly email: EmailService,
  ) {}

  async getEvents(
    orgId: string,
    userId: string,
    start: Date,
    end: Date,
  ): Promise<CalendarEventItem[]> {
    const [eventsData, leavesData, interviewsData, tasksData, holidaysData, projectTicketsData] =
      await Promise.all([
        this.db.query.calendarEvents.findMany({
          where: and(
            eq(calendarEvents.orgId, orgId),
            gte(calendarEvents.startDate, start),
            lte(calendarEvents.startDate, end),
          ),
          with: { creator: { columns: { name: true } } },
          orderBy: (t, { asc }) => [asc(t.startDate)],
        }),

        this.db
          .select({
            id: leaveRequests.id,
            userId: leaveRequests.userId,
            startDate: leaveRequests.startDate,
            endDate: leaveRequests.endDate,
            reason: leaveRequests.reason,
            userName: users.name,
          })
          .from(leaveRequests)
          .innerJoin(users, eq(leaveRequests.userId, users.id))
          .where(
            and(
              eq(leaveRequests.orgId, orgId),
              eq(leaveRequests.status, "APPROVED"),
              lte(leaveRequests.startDate, dateOnly(end)),
              gte(leaveRequests.endDate, dateOnly(start)),
            ),
          ),

        this.db
          .select({
            id: interviews.id,
            scheduledAt: interviews.scheduledAt,
            duration: interviews.duration,
            type: interviews.type,
            interviewerId: interviews.interviewerId,
            location: interviews.location,
            meetingLink: interviews.meetingLink,
          })
          .from(interviews)
          .where(
            and(
              eq(interviews.orgId, orgId),
              gte(interviews.scheduledAt, start),
              lte(interviews.scheduledAt, end),
            ),
          ),

        this.db
          .select({
            id: tasks.id,
            title: tasks.title,
            dueDate: tasks.dueDate,
            status: tasks.status,
            assigneeId: tasks.assigneeId,
          })
          .from(tasks)
          .where(
            and(
              eq(tasks.orgId, orgId),
              isNotNull(tasks.dueDate),
              gte(tasks.dueDate, start),
              lte(tasks.dueDate, end),
            ),
          ),

        this.db
          .select({
            id: holidays.id,
            name: holidays.name,
            date: holidays.date,
            message: holidays.message,
          })
          .from(holidays)
          .where(
            and(
              eq(holidays.orgId, orgId),
              gte(holidays.date, dateOnly(start)),
              lte(holidays.date, dateOnly(end)),
            ),
          ),

        this.db
          .select({
            id: tickets.id,
            title: tickets.title,
            dueDate: tickets.dueDate,
            status: tickets.status,
            ticketNumber: tickets.ticketNumber,
            projectId: projects.id,
            projectKey: projects.key,
          })
          .from(tickets)
          .innerJoin(projects, eq(tickets.projectId, projects.id))
          .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
          .where(
            and(
              eq(tickets.orgId, orgId),
              eq(projectMembers.userId, userId),
              isNotNull(tickets.dueDate),
              gte(tickets.dueDate, dateOnly(start)),
              lte(tickets.dueDate, dateOnly(end)),
            ),
          ),
      ]);

    const eventIds = eventsData.map((e) => e.id);
    const ticketEntityIds: number[] = [];
    for (const ev of eventsData) {
      if (ev.entityType === "ticket" && ev.entityId != null) {
        const parsed = parseInt(ev.entityId, 10);
        if (!Number.isNaN(parsed)) ticketEntityIds.push(parsed);
      }
    }

    const rsvpMap = new Map<number, string>();
    const linkedTicketMap = new Map<number, LinkedTicket>();

    await Promise.all([
      (async () => {
        if (eventIds.length === 0) return;
        const rows = await this.db
          .select({ eventId: eventAttendees.eventId, status: eventAttendees.status })
          .from(eventAttendees)
          .where(
            and(eq(eventAttendees.userId, userId), inArray(eventAttendees.eventId, eventIds)),
          );
        for (const row of rows) {
          rsvpMap.set(row.eventId, row.status ?? "pending");
        }
      })(),
      (async () => {
        if (ticketEntityIds.length === 0) return;
        const rows = await this.db
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
        for (const row of rows) {
          linkedTicketMap.set(row.id, {
            id: row.id,
            key: `${row.projectKey}-${row.ticketNumber}`,
            title: row.title,
            projectId: row.projectId,
            status: row.status,
          });
        }
      })(),
    ]);

    const result: CalendarEventItem[] = [];

    for (const ev of eventsData) {
      let linkedTicket: LinkedTicket | null | undefined;
      if (ev.entityType === "ticket" && ev.entityId != null) {
        const parsed = parseInt(ev.entityId, 10);
        linkedTicket = Number.isNaN(parsed) ? null : (linkedTicketMap.get(parsed) ?? null);
      }
      result.push({
        id: `event-${ev.id}`,
        title: ev.title,
        start: ev.startDate,
        end: ev.endDate,
        allDay: ev.allDay ?? false,
        color: ev.color,
        category: ev.category,
        source: "event",
        location: ev.location,
        meetingUrl: ev.meetingUrl,
        description: ev.description,
        creatorName: ev.creator?.name ?? null,
        entityId: ev.entityId,
        entityType: ev.entityType,
        myRsvpStatus: rsvpMap.get(ev.id) ?? null,
        linkedTicket,
      });
    }

    for (const lv of leavesData) {
      result.push({
        id: `leave-${lv.id}`,
        title: `${lv.userName ?? "Employee"} — OOO`,
        start: new Date(lv.startDate),
        end: new Date(lv.endDate),
        allDay: true,
        color: "green",
        category: "leave",
        source: "leave",
        description: lv.reason ?? null,
        creatorName: lv.userName ?? null,
      });
    }

    for (const iv of interviewsData) {
      const ivEnd = new Date(iv.scheduledAt);
      ivEnd.setMinutes(ivEnd.getMinutes() + (iv.duration ?? 60));
      result.push({
        id: `interview-${iv.id}`,
        title: `Interview (${iv.type ?? "Video"})`,
        start: iv.scheduledAt,
        end: ivEnd,
        allDay: false,
        color: "orange",
        category: "interview",
        source: "interview",
        location: iv.location ?? iv.meetingLink ?? null,
      });
    }

    for (const tk of tasksData) {
      if (!tk.dueDate) continue;
      result.push({
        id: `task-${tk.id}`,
        title: tk.title,
        start: tk.dueDate,
        end: tk.dueDate,
        allDay: true,
        color: tk.status === "completed" ? "gray" : "red",
        category: "task",
        source: "task",
      });
    }

    for (const pt of projectTicketsData) {
      if (!pt.dueDate) continue;
      const ptDate = new Date(pt.dueDate);
      result.push({
        id: `ticket-${pt.id}`,
        title: `${pt.projectKey}-${pt.ticketNumber}: ${pt.title}`,
        start: ptDate,
        end: ptDate,
        allDay: true,
        color: "blue",
        category: "task",
        source: "task",
        entityType: "ticket",
        entityId: String(pt.id),
        projectId: pt.projectId,
      });
    }

    for (const hd of holidaysData) {
      const hdDate = new Date(hd.date);
      result.push({
        id: `holiday-${hd.id}`,
        title: hd.name,
        start: hdDate,
        end: hdDate,
        allDay: true,
        color: "purple",
        category: "holiday",
        source: "holiday",
        description: hd.message ?? null,
      });
    }

    result.sort((a, b) => a.start.getTime() - b.start.getTime());
    return result;
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
        const attendeeEmailList = await this.attendeeEmails(attendeeIds);
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
        .where(inArray(users.id, recipientIds)),
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
    if (input.attendeeIds !== undefined) updateData.attendeeIds = input.attendeeIds;
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
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error("Calendar account connection not found");
    return row;
  }

  private async attendeeEmails(attendeeIds: string[]): Promise<string[]> {
    if (attendeeIds.length === 0) return [];
    const rows = await this.db.select({ email: users.email }).from(users).where(inArray(users.id, attendeeIds));
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
