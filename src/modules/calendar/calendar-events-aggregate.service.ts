import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  desc,
  eq,
  exists,
  gte,
  isNotNull,
  isNull,
  inArray,
  lte,
  or,
} from "drizzle-orm";
import { formatInTimeZone, toZonedTime } from "date-fns-tz";
import {
  calendarEvents,
  eventAttendees,
  leaveRequests,
  interviews,
  tasks,
  orgHolidays,
  organizations,
  users,
  tickets,
  projects,
  projectMembers,
  attendance,
  wfhRequests,
  interviewPanelMembers,
  rosterEntries,
  rosters,
  organizationMembers,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CalendarEventItem, LinkedTicket } from "./calendar.types";
import { dateOnly } from "./calendar.types";
import { AttendancePolicyService } from "../hr/time/attendance-policy.service";

const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function dateAtNoonUtc(date: string): Date {
  return new Date(`${date}T12:00:00.000Z`);
}

function enumerateDates(start: string, end: string): string[] {
  const dates: string[] = [];
  const current = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${end}T00:00:00.000Z`);
  while (current <= last) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

@Injectable()
export class CalendarEventsAggregateService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly attendancePolicy: AttendancePolicyService,
  ) {}

  async getEvents(
    orgId: string,
    userId: string,
    start: Date,
    end: Date,
  ): Promise<CalendarEventItem[]> {
    const policyDate = dateOnly(end.getTime() < Date.now() ? end : new Date());
    const [
      eventsData,
      leavesData,
      interviewsData,
      tasksData,
      holidaysData,
      projectTicketsData,
      attendanceData,
      wfhData,
      organizationData,
      rosterDatesData,
      attendanceRules,
      shiftRosterRules,
      membershipData,
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
            isHalfDay: leaveRequests.isHalfDay,
            halfDayPeriod: leaveRequests.halfDayPeriod,
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
            id: orgHolidays.id,
            name: orgHolidays.name,
            date: orgHolidays.date,
          })
          .from(orgHolidays)
          .where(
            and(
              eq(orgHolidays.orgId, orgId),
              gte(orgHolidays.date, dateOnly(start)),
              lte(orgHolidays.date, dateOnly(end)),
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
              isNull(tickets.deletedAt),
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
            breakHours: attendance.breakHours,
            createdAt: attendance.createdAt,
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

        this.db
          .select({ timezone: organizations.timezone })
          .from(organizations)
          .where(eq(organizations.id, orgId))
          .limit(1),

        this.db
          .select({ date: rosterEntries.date })
          .from(rosterEntries)
          .innerJoin(
            rosters,
            and(eq(rosters.id, rosterEntries.rosterId), eq(rosters.orgId, orgId)),
          )
          .where(
            and(
              eq(rosterEntries.userId, userId),
              gte(rosterEntries.date, dateOnly(start)),
              lte(rosterEntries.date, dateOnly(end)),
            ),
          ),

        this.attendancePolicy.getAttendanceRules(orgId, userId, policyDate),
        this.attendancePolicy.getShiftRosterRules(orgId, userId, policyDate),
        this.db
          .select({
            joinedAt: organizationMembers.joinedAt,
            activatedAt: organizationMembers.activatedAt,
            joiningDate: users.joiningDate,
          })
          .from(organizationMembers)
          .innerJoin(users, eq(users.id, organizationMembers.userId))
          .where(
            and(
              eq(organizationMembers.orgId, orgId),
              eq(organizationMembers.userId, userId),
            ),
          )
          .limit(1),
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
      const halfDayLabel = lv.isHalfDay
        ? `Half-day leave${lv.halfDayPeriod ? ` (${lv.halfDayPeriod})` : ""}`
        : "OOO";
      result.push({
        id: `leave-${lv.id}`,
        title: `${lv.userName ?? "Employee"} - ${halfDayLabel}`,
        start: dateAtNoonUtc(lv.startDate),
        end: dateAtNoonUtc(lv.endDate),
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
      const hdDate = dateAtNoonUtc(hd.date);
      result.push({
        id: `holiday-${hd.id}`,
        title: hd.name,
        start: hdDate,
        end: hdDate,
        allDay: true,
        color: "purple",
        category: "holiday",
        source: "holiday",
      });
    }

    const orgTimezone = organizationData[0]?.timezone ?? "Asia/Kolkata";
    const today = formatInTimeZone(new Date(), orgTimezone, "yyyy-MM-dd");
    const membership = membershipData[0];
    const employmentStart =
      membership?.joiningDate ??
      (membership?.activatedAt
        ? formatInTimeZone(membership.activatedAt, orgTimezone, "yyyy-MM-dd")
        : membership?.joinedAt
          ? formatInTimeZone(membership.joinedAt, orgTimezone, "yyyy-MM-dd")
          : dateOnly(start));
    const holidayDates = new Set(holidaysData.map((holiday) => holiday.date));
    const rosterDates = new Set(rosterDatesData.map((roster) => roster.date));
    const weeklyOffDays = new Set(
      shiftRosterRules.weeklyOffDays.map((day) => day.toLowerCase()),
    );
    const wfhByDate = new Map(wfhData.map((request) => [request.date, request]));

    const selfLeaveByDate = new Map<
      string,
      { isHalfDay: boolean; halfDayPeriod: string | null }
    >();
    for (const leave of leavesData) {
      if (leave.userId !== userId) continue;
      const leaveStart =
        leave.startDate < dateOnly(start) ? dateOnly(start) : leave.startDate;
      const leaveEnd =
        leave.endDate > dateOnly(end) ? dateOnly(end) : leave.endDate;
      for (const date of enumerateDates(leaveStart, leaveEnd)) {
        selfLeaveByDate.set(date, {
          isHalfDay: leave.isHalfDay,
          halfDayPeriod: leave.halfDayPeriod,
        });
      }
    }

    const attendanceByDate = new Map<string, typeof attendanceData>();
    for (const log of attendanceData) {
      const logs = attendanceByDate.get(log.date) ?? [];
      logs.push(log);
      attendanceByDate.set(log.date, logs);
    }

    for (const [date, logs] of attendanceByDate) {
      const latest = logs.reduce((current, log) =>
        log.createdAt > current.createdAt ? log : current,
      );
      const storedStatuses = new Set(
        logs.map((log) => log.status?.toUpperCase()).filter(Boolean),
      );
      const hasOpenSession = logs.some((log) => !log.checkOut);
      const firstCheckIn = logs
        .map((log) => log.checkIn)
        .filter((value): value is Date => value !== null)
        .reduce<Date | null>(
          (earliest, value) =>
            !earliest || value < earliest ? value : earliest,
          null,
        );
      const lastCheckOut = logs
        .map((log) => log.checkOut)
        .filter((value): value is Date => value !== null)
        .reduce<Date | null>(
          (latestValue, value) =>
            !latestValue || value > latestValue ? value : latestValue,
          null,
        );
      const netHours = logs.reduce(
        (total, log) =>
          total +
          Math.max(
            0,
            Number(log.workHours ?? 0) - Number(log.breakHours ?? 0),
          ),
        0,
      );
      const workedMinutes = Math.round(netHours * 60);
      const isPast = date < today;
      const isWfh = wfhByDate.has(date) || storedStatuses.has("WFH");

      let status:
        | "ABSENT"
        | "HALF_DAY"
        | "LATE"
        | "MISSING_CHECKOUT"
        | "PRESENT" = "PRESENT";
      if (storedStatuses.has("ABSENT")) {
        status = "ABSENT";
      } else if (storedStatuses.has("HALF_DAY")) {
        status = "HALF_DAY";
      } else if (storedStatuses.has("LATE")) {
        status = "LATE";
      } else if (hasOpenSession && isPast) {
        status = "MISSING_CHECKOUT";
      } else if (!hasOpenSession && isPast) {
        if (workedMinutes <= attendanceRules.absentThresholdMinutes) {
          status = "ABSENT";
        } else if (workedMinutes < attendanceRules.halfDayThresholdMinutes) {
          status = "HALF_DAY";
        }
      }

      const statusLabel =
        status === "HALF_DAY"
          ? "Half day"
          : status === "ABSENT"
            ? "Absent"
            : status === "LATE"
              ? "Late"
              : status === "MISSING_CHECKOUT"
                ? "Missing checkout"
                : "Present";
      const onBreak = storedStatuses.has("ON_BREAK");
      const details = [
        isWfh ? "Work from home" : null,
        onBreak ? "Currently on break" : null,
        netHours > 0 ? `${netHours.toFixed(1)} hours recorded` : null,
        firstCheckIn
          ? `Check-in ${formatInTimeZone(firstCheckIn, orgTimezone, "p")}`
          : null,
        lastCheckOut
          ? `Check-out ${formatInTimeZone(lastCheckOut, orgTimezone, "p")}`
          : null,
      ].filter((value): value is string => Boolean(value));
      const color =
        status === "ABSENT"
          ? "red"
          : status === "HALF_DAY" ||
              status === "LATE" ||
              status === "MISSING_CHECKOUT" ||
              onBreak
            ? "yellow"
            : isWfh
              ? "blue"
              : "green";
      const day = dateAtNoonUtc(date);
      result.push({
        id: `attendance-${latest.id}`,
        title: `${isWfh ? "WFH" : "Attendance"} - ${statusLabel}${
          netHours > 0 ? ` - ${netHours.toFixed(1)}h` : ""
        }`,
        start: day,
        end: day,
        allDay: true,
        color,
        category: "attendance",
        source: "attendance",
        description: details.join(" - ") || null,
      });
    }

    for (const date of enumerateDates(dateOnly(start), dateOnly(end))) {
      if (date < employmentStart) continue;
      if (attendanceByDate.has(date) || holidayDates.has(date)) continue;

      const leave = selfLeaveByDate.get(date);
      if (leave && !leave.isHalfDay) continue;

      const dayOfWeek =
        WEEKDAY_NAMES[new Date(`${date}T00:00:00.000Z`).getUTCDay()];
      const isScheduledDay =
        rosterDates.has(date) || !weeklyOffDays.has(dayOfWeek);
      const wfh = wfhByDate.get(date);
      const isPast = date < today;

      if (!isScheduledDay && !wfh) continue;
      if (!isPast && !wfh) continue;

      const day = dateAtNoonUtc(date);
      const title = !isPast
        ? "WFH approved"
        : leave?.isHalfDay
          ? `Half-day leave${leave.halfDayPeriod ? ` (${leave.halfDayPeriod})` : ""} - Attendance missing`
          : wfh
            ? "WFH - No attendance"
            : "Absent";
      result.push({
        id: wfh ? `attendance-wfh-${wfh.id}` : `attendance-absence-${date}`,
        title,
        start: day,
        end: day,
        allDay: true,
        color: !isPast ? "blue" : leave?.isHalfDay ? "yellow" : "red",
        category: "attendance",
        source: "attendance",
        description: !isPast
          ? "Approved work-from-home day"
          : leave?.isHalfDay
            ? "Attendance is required for the working half of this approved leave day."
            : wfh
              ? "Work from home was approved, but no attendance was recorded."
              : "No attendance, approved leave, holiday, or weekly off was found for this scheduled workday.",
      });
    }

    result.sort((a, b) => a.start.getTime() - b.start.getTime());
    return result;
  }
}
