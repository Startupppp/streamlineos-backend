import { and, count, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  organizationMembers,
  orgUnitMembers,
  orgUnits,
  users,
  attendance,
  wfhRequests,
  shiftTemplates,
  employeeShiftAssignments,
} from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";

const FALLBACK_LATE_CHECKIN_HOUR = 9;
const FALLBACK_LATE_CHECKIN_MINUTE = 30;

function getWorkingDaysSoFar(year: number, month: number): number {
  const today = new Date();
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() + 1 === month;
  const lastDay = isCurrentMonth ? today.getDate() : new Date(year, month, 0).getDate();
  let working = 0;
  for (let d = 1; d <= lastDay; d++) {
    const dow = new Date(year, month - 1, d).getDay();
    if (dow !== 0 && dow !== 6) working++;
  }
  return working;
}

export async function resolveLateThresholdMinutes(db: Db, orgId: string, referenceDate: string): Promise<number> {
  const rows = await db
    .select({
      startTime: shiftTemplates.startTime,
      graceMinutes: shiftTemplates.gracePeriodMinutes,
    })
    .from(employeeShiftAssignments)
    .innerJoin(shiftTemplates, eq(shiftTemplates.id, employeeShiftAssignments.shiftId))
    .where(
      and(
        eq(employeeShiftAssignments.orgId, orgId),
        eq(employeeShiftAssignments.isActive, true),
        lte(employeeShiftAssignments.effectiveFrom, referenceDate),
        eq(shiftTemplates.isActive, true),
        or(
          isNull(employeeShiftAssignments.effectiveTo),
          gte(employeeShiftAssignments.effectiveTo, referenceDate),
        ),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (row?.startTime) {
    const [hStr, mStr] = row.startTime.split(":");
    const startMinutes = Number(hStr) * 60 + Number(mStr);
    const grace = Number(row.graceMinutes ?? 15);
    return startMinutes + grace;
  }

  return FALLBACK_LATE_CHECKIN_HOUR * 60 + FALLBACK_LATE_CHECKIN_MINUTE;
}

/**
 * `attendance` is a SESSION table, not a day table: the only unique indexes on
 * it are on the generated serial (`attendance_pkey`, `uniq_attendance_org_id`),
 * and AttendanceClockService.clockIn blocks only an *open* session before
 * inserting, so clocking out for lunch and back in writes a second row for the
 * same person and day. Every ratio below is measured against a per-day
 * expectation (`workingDaysSoFar`), so counting rows would let attendance
 * exceed 100% and drive absenteeism negative — which `Math.max(0, …)` then
 * reports as 0% absenteeism. Count distinct person-days instead.
 *
 * Written inline as raw SQL at each call site rather than hoisted into a shared
 * constant: check:unbounded-reads reads the projection TEXT to recognise an
 * aggregate-only select, and a hoisted identifier hides that from it.
 */
export async function buildAttendanceAnalytics(db: Db, orgId: string) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`;

  const workingDaysSoFar = getWorkingDaysSoFar(year, month);

  const lateThresholdMinutes = await resolveLateThresholdMinutes(db, orgId, monthStart);

  const [activeMembers, monthlyAttendance, lateArrivals, wfhApproved, overtimeRecords, deptAttendance] =
    await Promise.all([
      db
        .select({ count: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true))),

      db
        .select({
          count: sql<number>`count(DISTINCT (${attendance.userId}, ${attendance.date}))`.mapWith(
            Number,
          ),
        })
        .from(attendance)
        .where(
          and(
            eq(attendance.orgId, orgId),
            gte(attendance.date, monthStart),
            lte(attendance.date, monthEnd),
            inArray(attendance.status, ["PRESENT", "HALF_DAY", "LATE"]),
          ),
        ),

      db
        // A person who clocks in late, breaks, and clocks back in after the
        // threshold arrived late once, not twice.
        .select({
          count: sql<number>`count(DISTINCT (${attendance.userId}, ${attendance.date}))`.mapWith(
            Number,
          ),
        })
        .from(attendance)
        .where(
          and(
            eq(attendance.orgId, orgId),
            gte(attendance.date, monthStart),
            lte(attendance.date, monthEnd),
            sql`EXTRACT(HOUR FROM ${attendance.checkIn}) * 60 + EXTRACT(MINUTE FROM ${attendance.checkIn}) > ${lateThresholdMinutes}`,
          ),
        ),

      db
        .select({ count: count() })
        .from(wfhRequests)
        .where(
          and(
            eq(wfhRequests.orgId, orgId),
            eq(wfhRequests.status, "APPROVED"),
            gte(wfhRequests.date, monthStart),
            lte(wfhRequests.date, monthEnd),
          ),
        ),

      db
        .select({ count: count() })
        .from(attendance)
        .where(
          and(
            eq(attendance.orgId, orgId),
            gte(attendance.date, monthStart),
            lte(attendance.date, monthEnd),
            eq(attendance.isOvertime, true),
          ),
        ),

      db
        .select({
          departmentName: orgUnits.name,
          // FILTER is load-bearing: this is a LEFT JOIN, and a department with
          // no attendance yields a row constructor of all NULLs, which
          // count(DISTINCT …) treats as one distinct value — so an empty
          // department would report presentCount 1 without it.
          presentCount: sql<number>`count(DISTINCT (${attendance.userId}, ${attendance.date}))
            FILTER (WHERE ${attendance.id} IS NOT NULL)`.mapWith(Number),
        })
        .from(orgUnits)
        .leftJoin(orgUnitMembers, eq(orgUnitMembers.orgUnitId, orgUnits.id))
        .leftJoin(organizationMembers, eq(organizationMembers.id, orgUnitMembers.membershipId))
        .leftJoin(
          attendance,
          and(
            eq(attendance.userId, organizationMembers.userId),
            eq(attendance.orgId, orgId),
            gte(attendance.date, monthStart),
            lte(attendance.date, monthEnd),
            inArray(attendance.status, ["PRESENT", "HALF_DAY", "LATE"]),
          ),
        )
        .where(and(eq(orgUnits.orgId, orgId), isNull(orgUnits.deletedAt), eq(orgUnits.kind, "DEPARTMENT")))
        .groupBy(orgUnits.id, orgUnits.name)
        .orderBy(
          sql`count(DISTINCT (${attendance.userId}, ${attendance.date}))
            FILTER (WHERE ${attendance.id} IS NOT NULL) DESC`,
        ),
    ]);

  const totalEmployees = Number(activeMembers[0]?.count ?? 0);
  const totalPresentLogs = Number(monthlyAttendance[0]?.count ?? 0);
  const expectedLogs = totalEmployees * workingDaysSoFar;
  const attendancePct = expectedLogs > 0 ? Math.round((totalPresentLogs / expectedLogs) * 100) : 0;
  const absenteeismPct = 100 - attendancePct;

  return {
    month: `${year}-${String(month).padStart(2, "0")}`,
    workingDaysSoFar,
    totalEmployees,
    attendancePct,
    absenteeismPct: Math.max(0, absenteeismPct),
    lateArrivals: Number(lateArrivals[0]?.count ?? 0),
    wfhApproved: Number(wfhApproved[0]?.count ?? 0),
    overtimeInstances: Number(overtimeRecords[0]?.count ?? 0),
    byDepartment: deptAttendance.map((d) => ({
      name: d.departmentName,
      presentCount: Number(d.presentCount),
      expectedCount: workingDaysSoFar,
    })),
  };
}
