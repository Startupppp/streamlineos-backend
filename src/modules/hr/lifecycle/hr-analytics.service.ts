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
import { HrAttendanceAnalyticsService } from "./hr-attendance-analytics.service";
import { acceptedEmployee } from "../shared/employee-acceptance";

const ALL_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

@Injectable()
export class HrAnalyticsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly attendanceAnalytics: HrAttendanceAnalyticsService,
  ) {}

  overview(orgId: string) {
    return this.cache.cachedVersionedForOrg(
      orgId,
      "hr:analytics",
      "overview",
      () => this.buildOverview(orgId),
      CACHE_TTL.MEDIUM,
    );
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
        .where(and(eq(organizationMembers.orgId, orgId), acceptedEmployee())),

      this.db
        .select({ departmentId: hrEmployments.departmentId, count: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
        .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
        .where(and(eq(organizationMembers.orgId, orgId), acceptedEmployee()))
        .groupBy(hrEmployments.departmentId)
        .limit(1_000),

      this.db
        .select({ gender: users.gender, count: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(and(eq(organizationMembers.orgId, orgId), acceptedEmployee()))
        .groupBy(users.gender),

      this.db
        .select({ role: organizationMembers.role, count: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(and(eq(organizationMembers.orgId, orgId), acceptedEmployee()))
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

      this.db
        .select({ id: orgUnits.id, name: orgUnits.name })
        .from(orgUnits)
        .where(and(eq(orgUnits.orgId, orgId), isNull(orgUnits.deletedAt), eq(orgUnits.kind, "DEPARTMENT")))
        .limit(1_000),
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
    return this.attendanceAnalytics.attendance(orgId, yearInput, monthInput);
  }

  attrition(orgId: string) {
    return this.attendanceAnalytics.attrition(orgId);
  }
}
