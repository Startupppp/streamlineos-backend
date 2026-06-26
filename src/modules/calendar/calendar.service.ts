import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, lte, isNotNull, inArray } from "drizzle-orm";
import {
  calendarEvents,
  eventAttendees,
  leaveRequests,
  interviews,
  tasks,
  holidays,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CreateEventInput, RsvpInput, UpdateEventInput } from "./dto/calendar.schemas";

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
  description?: string | null;
  creatorName?: string | null;
  entityId?: string | null;
  entityType?: string | null;
  myRsvpStatus?: string | null;
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
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getEvents(
    orgId: string,
    userId: string,
    start: Date,
    end: Date,
  ): Promise<CalendarEventItem[]> {
    const [eventsData, leavesData, interviewsData, tasksData, holidaysData] = await Promise.all([
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
    ]);

    const eventIds = eventsData.map((e) => e.id);
    const rsvpMap = new Map<number, string>();
    if (eventIds.length > 0) {
      const attendeeRows = await this.db
        .select({ eventId: eventAttendees.eventId, status: eventAttendees.status })
        .from(eventAttendees)
        .where(and(eq(eventAttendees.userId, userId), inArray(eventAttendees.eventId, eventIds)));
      for (const row of attendeeRows) {
        rsvpMap.set(row.eventId, row.status ?? "pending");
      }
    }

    const result: CalendarEventItem[] = [];

    for (const ev of eventsData) {
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
        description: ev.description,
        creatorName: ev.creator?.name ?? null,
        entityId: ev.entityId,
        entityType: ev.entityType,
        myRsvpStatus: rsvpMap.get(ev.id) ?? null,
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

    return { event, oooConflicts };
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

    return event ?? null;
  }

  async deleteEvent(orgId: string, userId: string, id: number) {
    await this.db
      .delete(calendarEvents)
      .where(
        and(
          eq(calendarEvents.id, id),
          eq(calendarEvents.orgId, orgId),
          eq(calendarEvents.createdBy, userId),
        ),
      );
    return { deleted: true };
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
    });
  }
}
