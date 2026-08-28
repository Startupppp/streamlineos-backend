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
  leaveRequests,
  payrollRuns,
  payrollRunEmployees,
  expenses,
  resignations,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";

const ALL_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

@Injectable()
export class HrAnalyticsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  overview(orgId: string) {
    return this.cache.cached(`hr:analytics:${orgId}`, () => this.buildOverview(orgId), CACHE_TTL.MEDIUM);
  }

  private async buildOverview(orgId: string) {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;
    const monthStart = `${year}-${String(month + 1).padStart(2, "0")}-01`;
    const lastDay = new Date(year, month + 1, 0).getDate();
    const monthEnd = `${year}-${String(month + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

    const [
      totalEmployeesResult,
      activeEmployeesResult,
      deptDistribution,
      genderDistribution,
      roleDistribution,
      monthlyAttendanceResult,
      leavesByStatusResult,
      leavesByMonthResult,
      payrollCostResult,
      recentJoinsResult,
      expenseTotalResult,
      headcountTrendResult,
      exitsByMonthResult,
      allDepts,
    ] = await Promise.all([
      this.db.select({ count: count() }).from(organizationMembers).where(eq(organizationMembers.orgId, orgId)),

      this.db
        .select({ count: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true))),

      this.db
        .select({ departmentId: hrEmployments.departmentId, count: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
        .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
        .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true)))
        .groupBy(hrEmployments.departmentId),

      this.db
        .select({ gender: users.gender, count: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true)))
        .groupBy(users.gender),

      this.db
        .select({ role: organizationMembers.role, count: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true)))
        .groupBy(organizationMembers.role),

      this.db
        .select({ count: count() })
        .from(attendance)
        .where(and(eq(attendance.orgId, orgId), gte(attendance.date, monthStart), lte(attendance.date, monthEnd))),

      this.db
        .select({ status: leaveRequests.status, count: count() })
        .from(leaveRequests)
        .where(and(eq(leaveRequests.orgId, orgId), gte(leaveRequests.startDate, yearStart), lte(leaveRequests.startDate, yearEnd)))
        .groupBy(leaveRequests.status),

      this.db
        .select({
          month: sql<string>`to_char(${leaveRequests.startDate}::date, 'YYYY-MM')`,
          count: count(),
        })
        .from(leaveRequests)
        .where(and(eq(leaveRequests.orgId, orgId), gte(leaveRequests.startDate, yearStart), lte(leaveRequests.startDate, yearEnd)))
        .groupBy(sql`to_char(${leaveRequests.startDate}::date, 'YYYY-MM')`)
        .orderBy(sql`to_char(${leaveRequests.startDate}::date, 'YYYY-MM')`),

      this.db
        .select({ total: sql<string>`COALESCE(SUM(${payrollRunEmployees.net}::numeric), 0)` })
        .from(payrollRunEmployees)
        .innerJoin(payrollRuns, eq(payrollRunEmployees.runId, payrollRuns.id))
        .where(and(eq(payrollRuns.orgId, orgId), gte(payrollRuns.month, `${year}-01`), lte(payrollRuns.month, `${year}-12`))),

      this.db
        .select({ count: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
        .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
        .where(and(eq(organizationMembers.orgId, orgId), gte(hrEmployments.joiningDate, monthStart))),

      this.db
        .select({ total: sql<string>`COALESCE(SUM(${expenses.amount}::numeric), 0)` })
        .from(expenses)
        .where(and(eq(expenses.orgId, orgId), eq(expenses.status, "APPROVED"), gte(expenses.expenseDate, yearStart), lte(expenses.expenseDate, yearEnd))),

      this.db
        .select({
          month: sql<string>`to_char(${hrEmployments.joiningDate}::date, 'Mon')`,
          monthNum: sql<number>`EXTRACT(MONTH FROM ${hrEmployments.joiningDate}::date)`.mapWith(Number),
          joins: count(),
        })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
        .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
        .where(and(eq(organizationMembers.orgId, orgId), gte(hrEmployments.joiningDate, yearStart), lte(hrEmployments.joiningDate, yearEnd)))
        .groupBy(sql`to_char(${hrEmployments.joiningDate}::date, 'Mon')`, sql`EXTRACT(MONTH FROM ${hrEmployments.joiningDate}::date)`)
        .orderBy(sql`EXTRACT(MONTH FROM ${hrEmployments.joiningDate}::date)`),

      this.db
        .select({
          month: sql<string>`to_char(${resignations.createdAt}, 'Mon')`,
          monthNum: sql<number>`EXTRACT(MONTH FROM ${resignations.createdAt})`.mapWith(Number),
          exits: count(),
        })
        .from(resignations)
        .where(and(eq(resignations.orgId, orgId), gte(resignations.createdAt, new Date(yearStart)), lte(resignations.createdAt, new Date(yearEnd))))
        .groupBy(sql`to_char(${resignations.createdAt}, 'Mon')`, sql`EXTRACT(MONTH FROM ${resignations.createdAt})`)
        .orderBy(sql`EXTRACT(MONTH FROM ${resignations.createdAt})`),

      this.db.select({ id: orgUnits.id, name: orgUnits.name }).from(orgUnits).where(and(eq(orgUnits.orgId, orgId), isNull(orgUnits.deletedAt), eq(orgUnits.kind, "DEPARTMENT"))),
    ]);

    const deptMap = new Map(allDepts.map((d) => [d.id, d.name]));

    const leavesByStatus: Record<string, number> = {};
    for (const row of leavesByStatusResult) {
      leavesByStatus[row.status ?? "UNKNOWN"] = Number(row.count);
    }

    const joinsMap = new Map(headcountTrendResult.map((r) => [r.month, Number(r.joins)]));
    const exitsMap = new Map(exitsByMonthResult.map((r) => [r.month, Number(r.exits)]));
    const joiningExitsTrend = ALL_MONTHS.map((m) => ({
      month: m,
      joins: joinsMap.get(m) ?? 0,
      exits: exitsMap.get(m) ?? 0,
    }));

    return {
      headcount: {
        total: Number(totalEmployeesResult[0]?.count ?? 0),
        active: Number(activeEmployeesResult[0]?.count ?? 0),
        newThisMonth: Number(recentJoinsResult[0]?.count ?? 0),
      },
      departments: deptDistribution.map((d) => ({
        name: d.departmentId ? (deptMap.get(d.departmentId) ?? "Other") : "Unassigned",
        count: Number(d.count),
      })),
      gender: genderDistribution.map((g) => ({
        gender: g.gender ?? "Unknown",
        count: Number(g.count),
      })),
      roles: roleDistribution.map((r) => ({
        role: r.role,
        count: Number(r.count),
      })),
      attendance: {
        totalLogsThisMonth: Number(monthlyAttendanceResult[0]?.count ?? 0),
      },
      leaves: {
        byStatus: leavesByStatus,
        byMonth: leavesByMonthResult.map((r) => ({
          month: r.month,
          count: Number(r.count),
        })),
      },
      payroll: {
        totalCostYTD: payrollCostResult[0]?.total ?? "0",
      },
      expenses: {
        approvedYTD: expenseTotalResult[0]?.total ?? "0",
      },
      joiningExitsTrend,
    };
  }

  attendance(orgId: string, yearInput?: number, monthInput?: number) {
    const year = yearInput || new Date().getFullYear();
    const month = monthInput || new Date().getMonth() + 1;
    return this.cache.cached(
      `hr:analytics:attendance:${orgId}:${year}:${month}`,
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

      this.db.select({ id: orgUnits.id, name: orgUnits.name }).from(orgUnits).where(and(eq(orgUnits.orgId, orgId), isNull(orgUnits.deletedAt), eq(orgUnits.kind, "DEPARTMENT"))),
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
    return this.cache.cached(`hr:analytics:attrition:${orgId}:${year}`, () => this.buildAttrition(orgId), CACHE_TTL.MEDIUM);
  }

  private async buildAttrition(orgId: string) {
    const now = new Date();
    const yearStart = `${now.getFullYear()}-01-01`;

    const [totalEmployees, resignedThisYear, byMonth] = await Promise.all([
      this.db
        .select({ count: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true))),

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
