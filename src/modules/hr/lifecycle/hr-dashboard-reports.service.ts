import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { livePersonOfUser, primaryEmploymentOfPerson } from "../../directory/employment-query";
import {
  hrEmployments,
  hrPeople,
  organizationMembers,
  orgUnits,
  users,
  jobPostings,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import { buildAttendanceAnalytics } from "./hr-dashboard-attendance";

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
      .where(and(eq(organizationMembers.orgId, orgId), isNotNull(hrEmployments.joiningDate), lte(hrEmployments.joiningDate, windowEnd)))
      .limit(10_000);

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
      .where(and(eq(jobPostings.orgId, orgId), eq(jobPostings.status, "FILLED"), isNotNull(jobPostings.updatedAt)))
      .limit(10_000);

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
        .where(and(inArray(orgUnits.id, deptIds), eq(orgUnits.orgId, orgId), isNull(orgUnits.deletedAt)))
        .limit(Math.max(deptIds.length, 1));
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
    return this.cache.cached(`hr:dashboard:attendance-analytics:${orgId}`, () => buildAttendanceAnalytics(this.db, orgId), CACHE_TTL.SHORT);
  }
}
