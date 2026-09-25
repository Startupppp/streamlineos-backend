import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { livePersonOfUser, primaryEmploymentOfPerson } from "../../directory/employment-query";
import {
  hrEmployments,
  hrPeople,
  organizationMembers,
  orgUnits,
  users,
  attendance,
  resignations,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import { acceptedEmployee } from "../shared/employee-acceptance";

@Injectable()
export class HrAttendanceAnalyticsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  attendance(orgId: string, yearInput?: number, monthInput?: number) {
    const year = yearInput || new Date().getFullYear();
    const month = monthInput || new Date().getMonth() + 1;
    return this.cache.cachedVersionedForOrg(
      orgId,
      "hr:analytics",
      `attendance:${year}:${month}`,
      () => this.buildAttendance(orgId, year, month),
      CACHE_TTL.SHORT,
    );
  }

  private async buildAttendance(orgId: string, year: number, month: number) {
    const mm = String(month).padStart(2, "0");
    const startDate = `${year}-${mm}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${mm}-${String(lastDay).padStart(2, "0")}`;

    const [deptWise, dailySummary, totalPresent, allDepts] = await Promise.all([
      this.db
        .select({ departmentId: hrEmployments.departmentId, count: count() })
        .from(attendance)
        .innerJoin(users, eq(attendance.userId, users.id))
        .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
        .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
        .where(and(eq(attendance.orgId, orgId), gte(attendance.date, startDate), lte(attendance.date, endDate)))
        .groupBy(hrEmployments.departmentId),

      this.db
        .select({ date: attendance.date, count: count() })
        .from(attendance)
        .where(and(eq(attendance.orgId, orgId), gte(attendance.date, startDate), lte(attendance.date, endDate)))
        .groupBy(attendance.date)
        .orderBy(attendance.date),

      this.db
        .select({ count: count() })
        .from(attendance)
        .where(and(eq(attendance.orgId, orgId), gte(attendance.date, startDate), lte(attendance.date, endDate))),

      this.db
        .select({ id: orgUnits.id, name: orgUnits.name })
        .from(orgUnits)
        .where(and(eq(orgUnits.orgId, orgId), isNull(orgUnits.deletedAt), eq(orgUnits.kind, "DEPARTMENT")))
        .limit(1_000),
    ]);

    const deptMap = new Map(allDepts.map((d) => [d.id, d.name]));

    return {
      year,
      month,
      totalAttendanceLogs: Number(totalPresent[0]?.count ?? 0),
      byDepartment: deptWise.map((d) => ({
        department: d.departmentId ? (deptMap.get(d.departmentId) ?? "Other") : "Unassigned",
        count: Number(d.count),
      })),
      daily: dailySummary.map((d) => ({
        date: d.date,
        count: Number(d.count),
      })),
    };
  }

  attrition(orgId: string) {
    const year = new Date().getFullYear();
    return this.cache.cachedVersionedForOrg(
      orgId,
      "hr:analytics",
      `attrition:${year}`,
      () => this.buildAttrition(orgId),
      CACHE_TTL.MEDIUM,
    );
  }

  private async buildAttrition(orgId: string) {
    const now = new Date();
    const yearStart = `${now.getFullYear()}-01-01`;

    const [totalEmployees, resignedThisYear, byMonth] = await Promise.all([
      this.db
        .select({ count: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(and(eq(organizationMembers.orgId, orgId), acceptedEmployee())),

      this.db
        .select({ count: count() })
        .from(resignations)
        .where(and(eq(resignations.orgId, orgId), gte(resignations.createdAt, new Date(yearStart)))),

      this.db
        .select({
          month: sql<string>`to_char(${resignations.createdAt}, 'YYYY-MM')`,
          count: count(),
        })
        .from(resignations)
        .where(and(eq(resignations.orgId, orgId), gte(resignations.createdAt, new Date(yearStart))))
        .groupBy(sql`to_char(${resignations.createdAt}, 'YYYY-MM')`)
        .orderBy(sql`to_char(${resignations.createdAt}, 'YYYY-MM')`),
    ]);

    const total = Number(totalEmployees[0]?.count ?? 0);
    const resigned = Number(resignedThisYear[0]?.count ?? 0);
    const attritionRate = total > 0 ? ((resigned / total) * 100).toFixed(1) : "0.0";

    return {
      totalEmployees: total,
      resignedThisYear: resigned,
      attritionRatePercent: attritionRate,
      byMonth: byMonth.map((m) => ({ month: m.month, count: Number(m.count) })),
    };
  }
}
