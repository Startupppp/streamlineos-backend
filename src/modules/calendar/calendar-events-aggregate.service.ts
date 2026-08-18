import { Inject, Injectable } from "@nestjs/common";
import { formatInTimeZone } from "date-fns-tz";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CalendarEventItem, LinkedTicket } from "./calendar.types";
import { dateOnly } from "./calendar.types";
import { AttendancePolicyService } from "../hr/time/attendance-policy.service";
import { CalendarEventSourceLoader } from "./calendar-event-source.loader";

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
  private readonly sourceLoader: CalendarEventSourceLoader;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly attendancePolicy: AttendancePolicyService,
  ) {
    this.sourceLoader = new CalendarEventSourceLoader(db, attendancePolicy);
  }

  async getEvents(
    orgId: string,
    userId: string,
    start: Date,
    end: Date,
  ): Promise<CalendarEventItem[]> {
    const {
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
      rsvpMap,
      linkedTicketMap,
    } = await this.sourceLoader.load(orgId, userId, start, end);

    const result: CalendarEventItem[] = [];

    for (const calendarEvent of eventsData) {
      let linkedTicket: LinkedTicket | null | undefined;
      if (
        calendarEvent.entityType === "ticket" &&
        calendarEvent.entityId != null
      ) {
        const linkedTicketIdentifier = parseInt(calendarEvent.entityId, 10);
        linkedTicket = Number.isNaN(linkedTicketIdentifier)
          ? null
          : (linkedTicketMap.get(linkedTicketIdentifier) ?? null);
      }
      result.push({
        id: `event-${calendarEvent.id}`,
        title: calendarEvent.title,
        start: calendarEvent.startDate,
        end: calendarEvent.endDate,
        allDay: calendarEvent.allDay ?? false,
        color: calendarEvent.color,
        category: calendarEvent.category,
        source: "event",
        location: calendarEvent.location,
        meetingUrl: calendarEvent.meetingUrl,
        description: calendarEvent.description,
        creatorName: calendarEvent.creator?.name ?? null,
        entityId: calendarEvent.entityId,
        entityType: calendarEvent.entityType,
        myRsvpStatus: rsvpMap.get(calendarEvent.id) ?? null,
        linkedTicket,
      });
    }

    for (const leaveRequest of leavesData) {
      const halfDayLabel = leaveRequest.isHalfDay
        ? `Half-day leave${
            leaveRequest.halfDayPeriod
              ? ` (${leaveRequest.halfDayPeriod})`
              : ""
          }`
        : "OOO";
      result.push({
        id: `leave-${leaveRequest.id}`,
        title: `${leaveRequest.userName ?? "Employee"} - ${halfDayLabel}`,
        start: dateAtNoonUtc(leaveRequest.startDate),
        end: dateAtNoonUtc(leaveRequest.endDate),
        allDay: true,
        color: "green",
        category: "leave",
        source: "leave",
        description: leaveRequest.reason ?? null,
        creatorName: leaveRequest.userName ?? null,
      });
    }

    for (const interview of interviewsData) {
      const interviewEnd = new Date(interview.scheduledAt);
      interviewEnd.setMinutes(
        interviewEnd.getMinutes() + (interview.duration ?? 60),
      );
      result.push({
        id: `interview-${interview.id}`,
        title: `Interview (${interview.type ?? "Video"})`,
        start: interview.scheduledAt,
        end: interviewEnd,
        allDay: false,
        color: "orange",
        category: "interview",
        source: "interview",
        location: interview.location ?? interview.meetingLink ?? null,
      });
    }

    for (const task of tasksData) {
      if (!task.dueDate) continue;
      result.push({
        id: `task-${task.id}`,
        title: task.title,
        start: task.dueDate,
        end: task.dueDate,
        allDay: true,
        color: task.status === "completed" ? "gray" : "red",
        category: "task",
        source: "task",
      });
    }

    for (const projectTicket of projectTicketsData) {
      if (!projectTicket.dueDate) continue;
      const projectTicketDate = new Date(projectTicket.dueDate);
      result.push({
        id: `ticket-${projectTicket.id}`,
        title: `${projectTicket.projectKey}-${projectTicket.ticketNumber}: ${projectTicket.title}`,
        start: projectTicketDate,
        end: projectTicketDate,
        allDay: true,
        color: "blue",
        category: "task",
        source: "task",
        entityType: "ticket",
        entityId: String(projectTicket.id),
        projectId: projectTicket.projectId,
      });
    }

    for (const holiday of holidaysData) {
      const holidayDate = dateAtNoonUtc(holiday.date);
      result.push({
        id: `holiday-${holiday.id}`,
        title: holiday.name,
        start: holidayDate,
        end: holidayDate,
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

    result.sort(
      (leftEvent, rightEvent) =>
        leftEvent.start.getTime() - rightEvent.start.getTime(),
    );
    return result;
  }
}
