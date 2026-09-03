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
        .select({ count: count() })
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
        .select({ count: count() })
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
        .select({ departmentName: orgUnits.name, presentCount: count(attendance.id) })
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
        .orderBy(sql`count(${attendance.id}) desc`),
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
