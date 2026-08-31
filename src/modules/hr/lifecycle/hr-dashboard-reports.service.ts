import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { livePersonOfUser, orgUnitInOrg, primaryEmploymentOfPerson } from "../../directory/employment-query";
import {
  hrEmployeeSensitiveFields,
  hrEmployments,
  hrPeople,
  organizationMembers,
  orgUnitMembers,
  orgUnits,
  users,
  attendance,
  wfhRequests,
  jobPostings,
  shiftTemplates,
  employeeShiftAssignments,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";

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

@Injectable()
export class HrDashboardReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  headcountTrends(orgId: string) {
    return this.cache.cached(`hr:dashboard:headcount-trends:${orgId}`, () => this.buildHeadcountTrends(orgId), CACHE_TTL.LONG);
  }

  private async buildHeadcountTrends(orgId: string) {
    const now = new Date();

    const months: { label: string; end: string }[] = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
      const label = d.toLocaleString("en-US", { month: "short", year: "2-digit" });
      months.push({ end, label });
    }

    const windowEnd = months[months.length - 1].end;

    const joiningRows = await this.db
      .select({ joiningDate: hrEmployments.joiningDate })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
      .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
      .where(and(eq(organizationMembers.orgId, orgId), isNotNull(hrEmployments.joiningDate), lte(hrEmployments.joiningDate, windowEnd)));

    const countByMonthEnd = new Map<string, number>();
    for (const r of joiningRows) {
      if (!r.joiningDate) continue;
      const d = new Date(r.joiningDate);
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
      countByMonthEnd.set(end, (countByMonthEnd.get(end) ?? 0) + 1);
    }

    let cumulative = 0;
    const cumulativeByEnd = new Map<string, number>();
    const sortedEnds = [...countByMonthEnd.keys()].sort();
    for (const end of sortedEnds) {
      cumulative += countByMonthEnd.get(end) ?? 0;
      cumulativeByEnd.set(end, cumulative);
    }

    let lastKnown = 0;
    const results = months.map(({ label, end }) => {
      if (cumulativeByEnd.has(end)) lastKnown = cumulativeByEnd.get(end) ?? lastKnown;
      return { month: label, count: lastKnown };
    });

    return { trends: results };
  }

  timeToFill(orgId: string) {
    return this.cache.cached(`hr:dashboard:time-to-fill:${orgId}`, () => this.buildTimeToFill(orgId), CACHE_TTL.LONG);
  }

  private async buildTimeToFill(orgId: string) {
    const filledJobs = await this.db
      .select({
        orgDepartmentId: jobPostings.orgDepartmentId,
        createdAt: jobPostings.createdAt,
        updatedAt: jobPostings.updatedAt,
      })
      .from(jobPostings)
      .where(and(eq(jobPostings.orgId, orgId), eq(jobPostings.status, "FILLED"), isNotNull(jobPostings.updatedAt)));

    if (!filledJobs.length) {
      return { avgDaysOverall: null, byDepartment: [] };
    }

    let totalDays = 0;
    const deptMap: Record<string, { total: number; count: number }> = {};

    for (const job of filledJobs) {
      if (!job.createdAt || !job.updatedAt) continue;
      const days = Math.max(
        0,
        Math.round((new Date(job.updatedAt).getTime() - new Date(job.createdAt).getTime()) / (1000 * 60 * 60 * 24)),
      );
      totalDays += days;

      const deptKey = job.orgDepartmentId ?? "unknown";
      if (!deptMap[deptKey]) deptMap[deptKey] = { total: 0, count: 0 };
      deptMap[deptKey].total += days;
      deptMap[deptKey].count++;
    }

    const avgDaysOverall = Math.round(totalDays / filledJobs.length);

    const deptIds = Object.keys(deptMap).filter((k) => k !== "unknown");

    let deptNames: Record<string, string> = {};
    if (deptIds.length > 0) {
      const rows = await this.db
        .select({ id: orgUnits.id, name: orgUnits.name })
        .from(orgUnits)
        .where(inArray(orgUnits.id, deptIds));
      deptNames = Object.fromEntries(rows.map((r) => [r.id, r.name]));
    }

    const byDepartment = Object.entries(deptMap).map(([deptId, { total, count: deptCount }]) => ({
      department: deptId === "unknown" ? "No Department" : (deptNames[deptId] ?? `Dept ${deptId}`),
      avgDays: Math.round(total / deptCount),
      filledCount: deptCount,
    }));

    byDepartment.sort((a, b) => b.avgDays - a.avgDays);

    return { avgDaysOverall, byDepartment };
  }

  attendanceAnalytics(orgId: string) {
    return this.cache.cached(`hr:dashboard:attendance-analytics:${orgId}`, () => this.buildAttendanceAnalytics(orgId), CACHE_TTL.SHORT);
  }

  private async buildAttendanceAnalytics(orgId: string) {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
    const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`;

    const workingDaysSoFar = getWorkingDaysSoFar(year, month);

    const lateThresholdMinutes = await this.resolveLateThresholdMinutes(orgId, monthStart);

    const [activeMembers, monthlyAttendance, lateArrivals, wfhApproved, overtimeRecords, deptAttendance] =
      await Promise.all([
        this.db
          .select({ count: count() })
          .from(organizationMembers)
          .innerJoin(users, eq(organizationMembers.userId, users.id))
          .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true))),

        this.db
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

        this.db
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

        this.db
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

        this.db
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

        this.db
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

  private async resolveLateThresholdMinutes(orgId: string, referenceDate: string): Promise<number> {
    const rows = await this.db
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

  exportRows(orgId: string) {
    return this.db
      .select({
        userId: organizationMembers.userId,
        role: organizationMembers.role,
        joinedAt: organizationMembers.joinedAt,
        name: users.name,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        gender: users.gender,
        dateOfBirth: users.dateOfBirth,
        joiningDate: hrEmployments.joiningDate,
        taxId: hrEmployeeSensitiveFields.taxId,
        departmentName: orgUnits.name,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
      .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
      .leftJoin(hrEmployeeSensitiveFields, and(eq(hrEmployeeSensitiveFields.employmentId, hrEmployments.id), eq(hrEmployeeSensitiveFields.orgId, orgId)))
      .leftJoin(orgUnitMembers, and(eq(orgUnitMembers.membershipId, organizationMembers.id), eq(orgUnitMembers.orgId, orgId)))
      .leftJoin(orgUnits, orgUnitInOrg(orgId, orgUnitMembers.orgUnitId))
      .where(eq(organizationMembers.orgId, orgId));
  }
}
