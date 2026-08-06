import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, exists, gte, lte, isNotNull, inArray, or } from "drizzle-orm";
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
  attendance,
  wfhRequests,
  interviewPanelMembers,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CalendarEventItem, LinkedTicket } from "./calendar.types";
import { dateOnly } from "./calendar.types";

@Injectable()
export class CalendarEventsAggregateService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getEvents(
    orgId: string,
    userId: string,
    start: Date,
    end: Date,
  ): Promise<CalendarEventItem[]> {
    const [
      eventsData,
      leavesData,
      interviewsData,
      tasksData,
      holidaysData,
      projectTicketsData,
      attendanceData,
      wfhData,
    ] =
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
              or(
                eq(interviews.interviewerId, userId),
                exists(
                  this.db
                    .select({ id: interviewPanelMembers.id })
                    .from(interviewPanelMembers)
                    .where(
                      and(
                        eq(interviewPanelMembers.orgId, orgId),
                        eq(interviewPanelMembers.interviewId, interviews.id),
                        eq(interviewPanelMembers.userId, userId),
                      ),
                    ),
                ),
              ),
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
              eq(tasks.assigneeId, userId),
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

        this.db
          .select({
            id: attendance.id,
            date: attendance.date,
            checkIn: attendance.checkIn,
            checkOut: attendance.checkOut,
            status: attendance.status,
            workHours: attendance.workHours,
          })
          .from(attendance)
          .where(
            and(
              eq(attendance.orgId, orgId),
              eq(attendance.userId, userId),
              gte(attendance.date, dateOnly(start)),
              lte(attendance.date, dateOnly(end)),
            ),
          )
          .orderBy(desc(attendance.createdAt)),

        this.db
          .select({ id: wfhRequests.id, date: wfhRequests.date })
          .from(wfhRequests)
          .where(
            and(
              eq(wfhRequests.orgId, orgId),
              eq(wfhRequests.userId, userId),
              eq(wfhRequests.status, "APPROVED"),
              gte(wfhRequests.date, dateOnly(start)),
              lte(wfhRequests.date, dateOnly(end)),
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

    const approvedWfhDates = new Set(wfhData.map((request) => request.date));
    const recordedAttendanceDates = new Set<string>();
    for (const log of attendanceData) {
      if (recordedAttendanceDates.has(log.date)) continue;
      recordedAttendanceDates.add(log.date);

      const isWfh = approvedWfhDates.has(log.date);
      const hours = log.workHours ? Number.parseFloat(log.workHours) : 0;
      const statusLabel = log.status === "ON_BREAK" ? "On break" : null;
      const details = [
        isWfh ? "Work from home" : null,
        statusLabel,
        hours > 0 ? `${hours.toFixed(1)} hours recorded` : null,
        log.checkIn ? `Check-in ${log.checkIn.toISOString()}` : null,
        log.checkOut ? `Check-out ${log.checkOut.toISOString()}` : null,
      ].filter((value): value is string => Boolean(value));

      const day = new Date(`${log.date}T12:00:00.000Z`);
      result.push({
        id: `attendance-${log.id}`,
        title: `Attendance${isWfh ? " - WFH" : ""}${hours > 0 ? ` - ${hours.toFixed(1)}h` : ""}`,
        start: day,
        end: day,
        allDay: true,
        color: "green",
        category: "attendance",
        source: "attendance",
        description: details.join(" - ") || null,
      });
    }

    for (const request of wfhData) {
      if (recordedAttendanceDates.has(request.date)) continue;
      const day = new Date(`${request.date}T12:00:00.000Z`);
      result.push({
        id: `attendance-wfh-${request.id}`,
        title: "Attendance - WFH",
        start: day,
        end: day,
        allDay: true,
        color: "green",
        category: "attendance",
        source: "attendance",
        description: "Approved work-from-home day",
      });
    }

    result.sort((a, b) => a.start.getTime() - b.start.getTime());
    return result;
  }
}
