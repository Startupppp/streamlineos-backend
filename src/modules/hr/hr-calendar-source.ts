import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, exists, gte, lte, or } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";
import { formatZoneClockTime } from "../../common/date/zoned-wall-clock";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import {
  attendance,
  interviewPanelMembers,
  interviews,
  leaveRequests,
  organizationMembers,
  organizations,
  rosterEntries,
  rosters,
  users,
  wfhRequests,
} from "../../db/schema";
import { listCompatibleHolidays } from "../../db/compat/organization-holidays";
import { AttendancePolicyService } from "./time/attendance-policy.service";
import type {
  CalendarEventProjection,
  CalendarEventSource,
  CalendarSourceContext,
} from "../calendar/calendar-event-source";
import { EmploymentFactsService } from "../directory/employment-facts.service";
import { WEEKDAY_NAMES, HR_CALENDAR_READ_BATCH_SIZE, dateOnly, dateAtNoon, enumerateDates, loadAttendanceOnly } from "./hr-calendar-sub-sources";
import { findActiveHrCalendarMembership } from "./hr-calendar-membership";

@Injectable()
export class HrCalendarSource implements CalendarEventSource {
  readonly key = "hr";
  readonly label = "HR";
  readonly module = "hr";

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly attendancePolicy: AttendancePolicyService,
    private readonly employment: EmploymentFactsService,
  ) {}

  async loadSource(
    ctx: CalendarSourceContext,
    source: "leave" | "interview" | "attendance",
  ): Promise<CalendarEventProjection[]> {
    if (source === "leave") return this.loadLeaves(ctx);
    if (source === "interview") return this.loadInterviews(ctx);
    return loadAttendanceOnly(this.db, this.attendancePolicy, ctx);
  }

  private async loadLeaves(ctx: CalendarSourceContext): Promise<CalendarEventProjection[]> {
    const membership = await findActiveHrCalendarMembership(this.db, ctx.orgId, ctx.userId);
    if (!membership) return [];
    const rows = await this.db
      .select({
        id: leaveRequests.id,
        userMembershipId: leaveRequests.userMembershipId,
        startDate: leaveRequests.startDate,
        endDate: leaveRequests.endDate,
        reason: leaveRequests.reason,
        userName: users.name,
        isHalfDay: leaveRequests.isHalfDay,
        halfDayPeriod: leaveRequests.halfDayPeriod,
      })
      .from(leaveRequests)
      .innerJoin(users, eq(leaveRequests.userId, users.id))
      .where(and(
        eq(leaveRequests.orgId, ctx.orgId),
        eq(leaveRequests.status, "APPROVED"),
        lte(leaveRequests.startDate, dateOnly(ctx.end)),
        gte(leaveRequests.endDate, dateOnly(ctx.start)),
      ))
      .orderBy(asc(leaveRequests.id))
      .limit(HR_CALENDAR_READ_BATCH_SIZE);

    return rows.map((leave) => ({
      id: `leave-${leave.id}`,
      title: `${leave.userName ?? "Employee"} - ${leave.isHalfDay ? `Half-day leave${leave.halfDayPeriod ? ` (${leave.halfDayPeriod})` : ""}` : "OOO"}`,
      start: dateAtNoon(leave.startDate),
      end: dateAtNoon(leave.endDate),
      allDay: true,
      color: "green",
      category: "leave",
      meta: {
        source: "leave",
        description: leave.userMembershipId === membership.id ? (leave.reason ?? null) : null,
        creatorName: leave.userName ?? null,
      },
    }));
  }

  private async loadInterviews(ctx: CalendarSourceContext): Promise<CalendarEventProjection[]> {
    const membership = await findActiveHrCalendarMembership(this.db, ctx.orgId, ctx.userId);
    if (!membership) return [];
    const rows = await this.db
      .select({
        id: interviews.id,
        scheduledAt: interviews.scheduledAt,
        duration: interviews.duration,
        type: interviews.type,
        interviewerId: interviews.interviewerId,
        interviewerMembershipId: interviews.interviewerMembershipId,
        location: interviews.location,
        meetingLink: interviews.meetingLink,
      })
      .from(interviews)
      .where(and(
        eq(interviews.orgId, ctx.orgId),
        gte(interviews.scheduledAt, ctx.start),
        lte(interviews.scheduledAt, ctx.end),
        or(
          eq(interviews.interviewerMembershipId, membership.id),
          exists(this.db.select({ id: interviewPanelMembers.id })
            .from(interviewPanelMembers)
            .where(and(
              eq(interviewPanelMembers.orgId, ctx.orgId),
              eq(interviewPanelMembers.interviewId, interviews.id),
              eq(interviewPanelMembers.userMembershipId, membership.id),
            )),
          ),
        ),
      ))
      .orderBy(asc(interviews.id))
      .limit(HR_CALENDAR_READ_BATCH_SIZE);

    return rows.map((interview) => {
      const end = new Date(interview.scheduledAt);
      end.setMinutes(end.getMinutes() + (interview.duration ?? 60));
      return {
        id: `interview-${interview.id}`,
        title: `Interview (${interview.type ?? "Video"})`,
        start: interview.scheduledAt,
        end,
        allDay: false,
        color: "orange",
        category: "interview",
        meta: { source: "interview", location: interview.location ?? interview.meetingLink ?? null },
      };
    });
  }

  async load(ctx: CalendarSourceContext): Promise<CalendarEventProjection[]> {
    const { orgId, userId, start, end } = ctx;
    const startStr = dateOnly(start);
    const endStr = dateOnly(end);
    const membership = await findActiveHrCalendarMembership(this.db, orgId, userId);
    if (!membership) return [];
    const policyDate = dateOnly(end.getTime() < Date.now() ? end : new Date());

    const [
      leavesData,
      interviewsData,
      attendanceData,
      wfhData,
      organizationData,
      rosterDatesData,
      holidaysData,
      attendanceRules,
      shiftRosterRules,
      membershipData,
      employmentFacts,
    ] = await Promise.all([
      this.db
        .select({
          id: leaveRequests.id,
          userMembershipId: leaveRequests.userMembershipId,
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
            lte(leaveRequests.startDate, endStr),
            gte(leaveRequests.endDate, startStr),
          ),
        )
        .orderBy(asc(leaveRequests.id))
        .limit(HR_CALENDAR_READ_BATCH_SIZE),

      this.db
        .select({
          id: interviews.id,
          scheduledAt: interviews.scheduledAt,
          duration: interviews.duration,
          type: interviews.type,
          interviewerId: interviews.interviewerId,
          interviewerMembershipId: interviews.interviewerMembershipId,
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
              eq(interviews.interviewerMembershipId, membership.id),
              exists(
                this.db
                  .select({ id: interviewPanelMembers.id })
                  .from(interviewPanelMembers)
                  .where(
                    and(
                      eq(interviewPanelMembers.orgId, orgId),
                      eq(interviewPanelMembers.interviewId, interviews.id),
                      eq(interviewPanelMembers.userMembershipId, membership.id),
                    ),
                  ),
              ),
            ),
          ),
        )
        .orderBy(asc(interviews.id))
        .limit(HR_CALENDAR_READ_BATCH_SIZE),

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
            eq(attendance.userMembershipId, membership.id),
            gte(attendance.date, startStr),
            lte(attendance.date, endStr),
          ),
        )
        .orderBy(desc(attendance.createdAt), asc(attendance.id))
        .limit(HR_CALENDAR_READ_BATCH_SIZE),

      this.db
        .select({ id: wfhRequests.id, date: wfhRequests.date })
        .from(wfhRequests)
        .where(
          and(
            eq(wfhRequests.orgId, orgId),
            eq(wfhRequests.userMembershipId, membership.id),
            eq(wfhRequests.status, "APPROVED"),
            gte(wfhRequests.date, startStr),
            lte(wfhRequests.date, endStr),
          ),
        )
        .orderBy(asc(wfhRequests.id))
        .limit(HR_CALENDAR_READ_BATCH_SIZE),

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
            eq(rosterEntries.orgId, orgId),
            eq(rosterEntries.userMembershipId, membership.id),
            gte(rosterEntries.date, startStr),
            lte(rosterEntries.date, endStr),
          ),
        )
        .orderBy(asc(rosterEntries.id))
        .limit(HR_CALENDAR_READ_BATCH_SIZE),

      listCompatibleHolidays(this.db, orgId, startStr, endStr),

      this.attendancePolicy.getAttendanceRules(orgId, userId, policyDate),
      this.attendancePolicy.getShiftRosterRules(orgId, userId, policyDate),

      this.db
        .select({
          joinedAt: organizationMembers.joinedAt,
          activatedAt: organizationMembers.activatedAt,
        })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.userId, userId),
          ),
        )
        .limit(1),

      this.employment.getFacts(orgId, userId),
    ]);

    const result: CalendarEventProjection[] = [];

    for (const leave of leavesData) {
      const halfDayLabel = leave.isHalfDay
        ? `Half-day leave${leave.halfDayPeriod ? ` (${leave.halfDayPeriod})` : ""}`
        : "OOO";
      result.push({
        id: `leave-${leave.id}`,
        title: `${leave.userName ?? "Employee"} - ${halfDayLabel}`,
        start: dateAtNoon(leave.startDate),
        end: dateAtNoon(leave.endDate),
        allDay: true,
        color: "green",
        category: "leave",
        meta: {
          source: "leave",
          description: leave.userMembershipId === membership.id ? (leave.reason ?? null) : null,
          creatorName: leave.userName ?? null,
        },
      });
    }

    for (const interview of interviewsData) {
      const interviewEnd = new Date(interview.scheduledAt);
      interviewEnd.setMinutes(interviewEnd.getMinutes() + (interview.duration ?? 60));
      result.push({
        id: `interview-${interview.id}`,
        title: `Interview (${interview.type ?? "Video"})`,
        start: interview.scheduledAt,
        end: interviewEnd,
        allDay: false,
        color: "orange",
        category: "interview",
        meta: {
          source: "interview",
          location: interview.location ?? interview.meetingLink ?? null,
        },
      });
    }

    const orgTimezone = organizationData[0]?.timezone ?? "Asia/Kolkata";
    const today = formatInTimeZone(new Date(), orgTimezone, "yyyy-MM-dd");
    const membershipForContext = membershipData[0];
    const employmentStart =
      employmentFacts.joiningDate ??
      (membershipForContext?.activatedAt
        ? formatInTimeZone(membershipForContext.activatedAt, orgTimezone, "yyyy-MM-dd")
        : membershipForContext?.joinedAt
          ? formatInTimeZone(membershipForContext.joinedAt, orgTimezone, "yyyy-MM-dd")
          : startStr);

    const holidayDateSet = new Set(holidaysData.map((h) => h.date));
    const rosterDateSet = new Set(rosterDatesData.map((r) => r.date));
    const weeklyOffDays = new Set(shiftRosterRules.weeklyOffDays.map((d) => d.toLowerCase()));
    const wfhByDate = new Map(wfhData.map((r) => [r.date, r]));

    const selfLeaveByDate = new Map<string, { isHalfDay: boolean; halfDayPeriod: string | null }>();
    for (const leave of leavesData) {
      if (leave.userMembershipId !== membership.id) continue;
      const leaveStart = leave.startDate < startStr ? startStr : leave.startDate;
      const leaveEnd = leave.endDate > endStr ? endStr : leave.endDate;
      for (const date of enumerateDates(leaveStart, leaveEnd))
        selfLeaveByDate.set(date, { isHalfDay: leave.isHalfDay, halfDayPeriod: leave.halfDayPeriod });
    }

    type AttendanceLog = (typeof attendanceData)[number];
    const attendanceByDate = new Map<string, AttendanceLog[]>();
    for (const log of attendanceData) {
      const logs = attendanceByDate.get(log.date) ?? [];
      logs.push(log);
      attendanceByDate.set(log.date, logs);
    }

    for (const [date, logs] of attendanceByDate) {
      const latest = logs.reduce((cur, log) => (log.createdAt > cur.createdAt ? log : cur));
      const storedStatuses = new Set(
        logs.map((log) => log.status?.toUpperCase()).filter((v): v is string => v !== undefined && v !== null),
      );
      const hasOpenSession = logs.some((log) => !log.checkOut);
      const firstCheckIn = logs
        .map((log) => log.checkIn)
        .filter((v): v is Date => v !== null)
        .reduce<Date | null>((e, v) => (!e || v < e ? v : e), null);
      const lastCheckOut = logs
        .map((log) => log.checkOut)
        .filter((v): v is Date => v !== null)
        .reduce<Date | null>((e, v) => (!e || v > e ? v : e), null);
      const netHours = logs.reduce(
        (total, log) => total + Math.max(0, Number(log.workHours ?? 0) - Number(log.breakHours ?? 0)),
        0,
      );
      const workedMinutes = Math.round(netHours * 60);
      const isPast = date < today;
      const isWfh = wfhByDate.has(date) || storedStatuses.has("WFH");

      let status: "ABSENT" | "HALF_DAY" | "LATE" | "MISSING_CHECKOUT" | "PRESENT" = "PRESENT";
      if (storedStatuses.has("ABSENT")) {
        status = "ABSENT";
      } else if (storedStatuses.has("HALF_DAY")) {
        status = "HALF_DAY";
      } else if (storedStatuses.has("LATE")) {
        status = "LATE";
      } else if (hasOpenSession && isPast) {
        status = "MISSING_CHECKOUT";
      } else if (!hasOpenSession && isPast) {
        if (workedMinutes <= attendanceRules.absentThresholdMinutes) status = "ABSENT";
        else if (workedMinutes < attendanceRules.halfDayThresholdMinutes) status = "HALF_DAY";
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
        firstCheckIn ? `Check-in ${formatZoneClockTime(firstCheckIn, orgTimezone)}` : null,
        lastCheckOut ? `Check-out ${formatZoneClockTime(lastCheckOut, orgTimezone)}` : null,
      ].filter((v): v is string => Boolean(v));
      const color =
        status === "ABSENT"
          ? "red"
          : status === "HALF_DAY" || status === "LATE" || status === "MISSING_CHECKOUT" || onBreak
            ? "yellow"
            : isWfh
              ? "blue"
              : "green";

      result.push({
        id: `attendance-${latest.id}`,
        title: `${isWfh ? "WFH" : "Attendance"} - ${statusLabel}${netHours > 0 ? ` - ${netHours.toFixed(1)}h` : ""}`,
        start: dateAtNoon(date),
        end: dateAtNoon(date),
        allDay: true,
        color,
        category: "attendance",
        meta: { source: "attendance", description: details.join(" - ") || null },
      });
    }

    for (const date of enumerateDates(startStr, endStr)) {
      if (date < employmentStart) continue;
      if (attendanceByDate.has(date) || holidayDateSet.has(date)) continue;
      const leave = selfLeaveByDate.get(date);
      if (leave && !leave.isHalfDay) continue;
      const dayOfWeek = WEEKDAY_NAMES[new Date(`${date}T00:00:00.000Z`).getUTCDay()];
      const isScheduledDay = rosterDateSet.has(date) || !weeklyOffDays.has(dayOfWeek);
      const wfh = wfhByDate.get(date);
      const isPast = date < today;
      if (!isScheduledDay && !wfh) continue;
      if (!isPast && !wfh) continue;

      const title = !isPast
        ? "WFH approved"
        : leave?.isHalfDay
          ? `Half-day leave${leave.halfDayPeriod ? ` (${leave.halfDayPeriod})` : ""} - Attendance missing`
          : wfh
            ? "WFH - No attendance"
            : "Absent";
      const description = !isPast
        ? "Approved work-from-home day"
        : leave?.isHalfDay
          ? "Attendance is required for the working half of this approved leave day."
          : wfh
            ? "Work from home was approved, but no attendance was recorded."
            : "No attendance, approved leave, holiday, or weekly off was found for this scheduled workday.";

      result.push({
        id: wfh ? `attendance-wfh-${wfh.id}` : `attendance-absence-${date}`,
        title,
        start: dateAtNoon(date),
        end: dateAtNoon(date),
        allDay: true,
        color: !isPast ? "blue" : leave?.isHalfDay ? "yellow" : "red",
        category: "attendance",
        meta: { source: "attendance", description },
      });
    }

    return result;
  }
}
