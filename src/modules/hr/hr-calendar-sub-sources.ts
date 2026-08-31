import { and, desc, eq, gte, lte } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";
import type { Db } from "../../db/drizzle.module";
import { attendance, organizations, wfhRequests } from "../../db/schema";
import type { AttendancePolicyService } from "./time/attendance-policy.service";
import type { CalendarEventProjection, CalendarSourceContext } from "../calendar/calendar-event-source";

export const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function dateAtNoon(date: string): Date {
  return new Date(`${date}T12:00:00.000Z`);
}

export function enumerateDates(start: string, end: string): string[] {
  const dates: string[] = [];
  const current = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${end}T00:00:00.000Z`);
  while (current <= last) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

export async function loadAttendanceOnly(
  db: Db,
  attendancePolicy: AttendancePolicyService,
  ctx: CalendarSourceContext,
): Promise<CalendarEventProjection[]> {
  const startStr = dateOnly(ctx.start);
  const endStr = dateOnly(ctx.end);
  const policyDate = dateOnly(ctx.end.getTime() < Date.now() ? ctx.end : new Date());

  const [attendanceData, wfhData, organizationData, attendanceRules] = await Promise.all([
    db
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
      .where(and(
        eq(attendance.orgId, ctx.orgId),
        eq(attendance.userId, ctx.userId),
        gte(attendance.date, startStr),
        lte(attendance.date, endStr),
      ))
      .orderBy(desc(attendance.createdAt)),
    db
      .select({ id: wfhRequests.id, date: wfhRequests.date })
      .from(wfhRequests)
      .where(and(
        eq(wfhRequests.orgId, ctx.orgId),
        eq(wfhRequests.userId, ctx.userId),
        eq(wfhRequests.status, "APPROVED"),
        gte(wfhRequests.date, startStr),
        lte(wfhRequests.date, endStr),
      )),
    db
      .select({ timezone: organizations.timezone })
      .from(organizations)
      .where(eq(organizations.id, ctx.orgId))
      .limit(1),
    attendancePolicy.getAttendanceRules(ctx.orgId, ctx.userId, policyDate),
  ]);

  const timezone = organizationData[0]?.timezone ?? "Asia/Kolkata";
  const today = formatInTimeZone(new Date(), timezone, "yyyy-MM-dd");
  const wfhDates = new Set(wfhData.map((row) => row.date));

  type AttendanceLog = (typeof attendanceData)[number];
  const byDate = new Map<string, AttendanceLog[]>();
  for (const log of attendanceData) byDate.set(log.date, [...(byDate.get(log.date) ?? []), log]);

  return [...byDate.entries()].map(([date, logs]) => {
    const latest = logs.reduce((current, log) => (log.createdAt > current.createdAt ? log : current));
    const statuses = new Set(logs.map((log) => log.status?.toUpperCase()).filter((value): value is string => Boolean(value)));
    const open = logs.some((log) => !log.checkOut);
    const workedMinutes = Math.round(logs.reduce(
      (total, log) => total + Math.max(0, Number(log.workHours ?? 0) - Number(log.breakHours ?? 0)),
      0,
    ) * 60);
    const past = date < today;
    let status: "ABSENT" | "HALF_DAY" | "LATE" | "MISSING_CHECKOUT" | "PRESENT" = "PRESENT";
    if (statuses.has("ABSENT")) status = "ABSENT";
    else if (statuses.has("HALF_DAY")) status = "HALF_DAY";
    else if (statuses.has("LATE")) status = "LATE";
    else if (open && past) status = "MISSING_CHECKOUT";
    else if (!open && past) {
      if (workedMinutes <= attendanceRules.absentThresholdMinutes) status = "ABSENT";
      else if (workedMinutes < attendanceRules.halfDayThresholdMinutes) status = "HALF_DAY";
    }
    const statusLabel = status === "HALF_DAY" ? "Half day" : status === "ABSENT" ? "Absent" : status === "LATE" ? "Late" : status === "MISSING_CHECKOUT" ? "Missing checkout" : "Present";
    const netHours = workedMinutes / 60;
    const wfh = wfhDates.has(date) || statuses.has("WFH");
    const onBreak = statuses.has("ON_BREAK");
    const description = [
      wfh ? "Work from home" : null,
      onBreak ? "Currently on break" : null,
      netHours > 0 ? `${netHours.toFixed(1)} hours recorded` : null,
    ].filter((value): value is string => Boolean(value)).join(" - ");
    return {
      id: `attendance-${latest.id}`,
      title: `${wfh ? "WFH" : "Attendance"} - ${statusLabel}${netHours > 0 ? ` - ${netHours.toFixed(1)}h` : ""}`,
      start: dateAtNoon(date),
      end: dateAtNoon(date),
      allDay: true,
      color: status === "ABSENT" ? "red" : status === "HALF_DAY" || status === "LATE" || status === "MISSING_CHECKOUT" || onBreak ? "yellow" : wfh ? "blue" : "green",
      category: "attendance",
      meta: { source: "attendance", description: description || null },
    };
  });
}
