import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import {
  organizationMembers,
  users,
  departments,
  departmentMembers,
  attendance,
  wfhRequests,
  jobPostings,
  shiftTemplates,
  employeeShiftAssignments,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";

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

    const months: { label: string; start: string; end: string }[] = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const start = d.toISOString().slice(0, 10);
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
      const label = d.toLocaleString("en-US", { month: "short", year: "2-digit" });
      months.push({ label, start, end });
    }

    const results = await Promise.all(
      months.map(async ({ label, end }) => {
        const [row] = await this.db
          .select({ count: sql<number>`count(*)` })
          .from(organizationMembers)
          .innerJoin(users, eq(organizationMembers.userId, users.id))
          .where(and(eq(organizationMembers.orgId, orgId), lte(users.joiningDate, end)));
        return { month: label, count: Number(row?.count ?? 0) };
      }),
    );

    return { trends: results };
  }

  timeToFill(orgId: string) {
    return this.cache.cached(`hr:dashboard:time-to-fill:${orgId}`, () => this.buildTimeToFill(orgId), CACHE_TTL.LONG);
  }

  private async buildTimeToFill(orgId: string) {
    const filledJobs = await this.db
      .select({
        departmentId: jobPostings.departmentId,
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

      const deptKey = job.departmentId != null ? String(job.departmentId) : "unknown";
      if (!deptMap[deptKey]) deptMap[deptKey] = { total: 0, count: 0 };
      deptMap[deptKey].total += days;
      deptMap[deptKey].count++;
    }

    const avgDaysOverall = Math.round(totalDays / filledJobs.length);

    const deptIds = Object.keys(deptMap)
      .filter((k) => k !== "unknown")
      .map(Number);

    let deptNames: Record<number, string> = {};
    if (deptIds.length > 0) {
      const rows = await this.db
        .select({ id: departments.id, name: departments.name })
        .from(departments)
        .where(inArray(departments.id, deptIds));
      deptNames = Object.fromEntries(rows.map((r) => [r.id, r.name]));
    }

    const byDepartment = Object.entries(deptMap).map(([deptId, { total, count: deptCount }]) => ({
      department: deptId === "unknown" ? "No Department" : (deptNames[Number(deptId)] ?? `Dept ${deptId}`),
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
          .select({ departmentName: departments.name, presentCount: count(attendance.id) })
          .from(departments)
          .leftJoin(departmentMembers, eq(departmentMembers.departmentId, departments.id))
          .leftJoin(
            attendance,
            and(
              eq(attendance.userId, departmentMembers.userId),
              eq(attendance.orgId, orgId),
              gte(attendance.date, monthStart),
              lte(attendance.date, monthEnd),
              inArray(attendance.status, ["PRESENT", "HALF_DAY", "LATE"]),
            ),
          )
          .where(eq(departments.orgId, orgId))
          .groupBy(departments.id, departments.name)
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
        joiningDate: users.joiningDate,
        taxId: users.taxId,
        departmentName: departments.name,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .leftJoin(departmentMembers, eq(departmentMembers.userId, organizationMembers.userId))
      .leftJoin(departments, eq(departments.id, departmentMembers.departmentId))
      .where(eq(organizationMembers.orgId, orgId));
  }
}
