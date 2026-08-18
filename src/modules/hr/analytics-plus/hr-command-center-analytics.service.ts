import { Inject, Injectable } from "@nestjs/common";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import { CacheService } from "../../../common/cache/cache.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { sql } from "drizzle-orm";

@Injectable()
export class HrCommandCenterAnalyticsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  getCommandCenter(orgId: string, departmentId?: string) {
    return this.cache.cached(
      `hr:analytics-plus:cc:${orgId}:${departmentId ?? "all"}`,
      () => this.buildCommandCenter(orgId),
      CACHE_TTL.MEDIUM,
    );
  }

  private async buildCommandCenter(orgId: string) {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const twelveMonthsAgo = new Date(now.getFullYear() - 1, now.getMonth(), 1);
    const yearStart = new Date(now.getFullYear(), 0, 1);

    const [
      headcountByStatus,
      attritionRate,
      avgTenure,
      leaveUtilization,
      attendanceRate,
      openCases,
      avgMood,
      lastPayroll,
    ] = await Promise.all([
      this.db.execute(sql`
        SELECT lifecycle_status, COUNT(*) as count
        FROM hr_employments
        WHERE org_id = ${orgId} AND deleted_at IS NULL
        GROUP BY lifecycle_status
      `),
      this.db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE exit_date >= ${twelveMonthsAgo.toISOString()} AND exit_date <= NOW()) as exits,
          COUNT(*) FILTER (WHERE lifecycle_status = 'ACTIVE') as active
        FROM hr_employments
        WHERE org_id = ${orgId} AND deleted_at IS NULL
      `),
      this.db.execute(sql`
        SELECT AVG(EXTRACT(EPOCH FROM (NOW() - joining_date::timestamp)) / 2592000) as avg_months
        FROM hr_employments
        WHERE org_id = ${orgId} AND lifecycle_status = 'ACTIVE' AND joining_date IS NOT NULL AND deleted_at IS NULL
      `),
      this.db.execute(sql`
        SELECT
          SUM(CASE WHEN txn_type = 'consumption' THEN days::numeric ELSE 0 END) as consumed,
          SUM(CASE WHEN txn_type = 'accrual' THEN days::numeric ELSE 0 END) as accrued
        FROM hr_leave_ledger
        WHERE org_id = ${orgId} AND effective_date >= ${yearStart.toISOString().split("T")[0]}
      `),
      this.db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'PRESENT') as present,
          COUNT(*) as total
        FROM attendance
        WHERE org_id = ${orgId} AND date >= ${thirtyDaysAgo.toISOString().split("T")[0]}
      `),
      this.db.execute(sql`
        SELECT COUNT(*) as count
        FROM hr_cases
        WHERE org_id = ${orgId} AND status IN ('open','under_investigation') AND deleted_at IS NULL
      `),
      this.db.execute(sql`
        SELECT AVG(mood) as avg_mood
        FROM hr_mood_checkins
        WHERE org_id = ${orgId} AND date >= ${thirtyDaysAgo.toISOString().split("T")[0]}
      `),
      this.db.execute(sql`
        SELECT gross_total, month
        FROM payroll_runs
        WHERE org_id = ${orgId} AND status = 'PAID'
        ORDER BY month DESC
        LIMIT 1
      `),
    ]);

    const headcountByLifecycleStatus: Record<string, number> = {};
    for (const headcountRow of headcountByStatus)
      headcountByLifecycleStatus[String(headcountRow.lifecycle_status)] = Number(
        headcountRow.count,
      );

    const attritionRow = attritionRate[0];
    const activeEmployees = Number(attritionRow?.active ?? 0);
    const employeeExits = Number(attritionRow?.exits ?? 0);
    const attritionPercentage =
      activeEmployees > 0
        ? Number(
            ((employeeExits / (activeEmployees + employeeExits)) * 100).toFixed(1),
          )
        : 0;
    const averageTenureMonths = avgTenure[0]?.avg_months
      ? Number(Number(avgTenure[0].avg_months).toFixed(1))
      : 0;
    const leaveAccrued = Number(leaveUtilization[0]?.accrued ?? 0);
    const leaveUtilizationPercentage =
      leaveAccrued > 0
        ? Number(
            ((Number(leaveUtilization[0]?.consumed ?? 0) / leaveAccrued) * 100).toFixed(1),
          )
        : 0;
    const attendanceTotal = Number(attendanceRate[0]?.total ?? 0);
    const attendancePercentage =
      attendanceTotal > 0
        ? Number(
            ((Number(attendanceRate[0]?.present ?? 0) / attendanceTotal) * 100).toFixed(1),
          )
        : 0;
    const averageMood = avgMood[0]?.avg_mood;
    const lastPayrollGross = lastPayroll[0]?.gross_total;

    return {
      headcount: {
        total: Object.values(headcountByLifecycleStatus).reduce(
          (total, employeeCount) => total + employeeCount,
          0,
        ),
        active: headcountByLifecycleStatus.ACTIVE ?? 0,
        probation: headcountByLifecycleStatus.ONBOARDING ?? 0,
        notice: headcountByLifecycleStatus.NOTICE ?? 0,
      },
      attritionRate12mo: attritionPercentage,
      avgTenureMonths: averageTenureMonths,
      leaveUtilizationPct: leaveUtilizationPercentage,
      attendanceRatePct: attendancePercentage,
      openCasesCount: Number(openCases[0]?.count ?? 0),
      avgMood: averageMood ? Number(Number(averageMood).toFixed(2)) : null,
      payrollCostLastMonth: lastPayrollGross ? Number(lastPayrollGross) : null,
    };
  }
}
