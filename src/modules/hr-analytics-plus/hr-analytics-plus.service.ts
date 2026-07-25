import { Injectable, Inject } from "@nestjs/common";
import { sql, eq, and } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import {
  hrEmployments,
  hrPeople,
  hrEmployeeProfiles,
  departments,
  attendance,
  leaveRequests,
  leaveTypes,
  hrLeaveLedger,
  payrollRuns,
  hrSuccessionPlans,
  hrRoleSkillRequirements,
  hrCases,
  hrMoodCheckins,
} from "../../db/schema";
import {
  hrHeadcountPlans,
  hrHiringPlanItems,
} from "../../db/schema/hr/workforce-planning";

@Injectable()
export class HrAnalyticsPlusService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  getCommandCenter(orgId: string, departmentId?: number) {
    return this.cache.cached(
      `hr:analytics-plus:cc:${orgId}:${departmentId ?? "all"}`,
      () => this.buildCommandCenter(orgId, departmentId),
      CACHE_TTL.MEDIUM,
    );
  }

  private async buildCommandCenter(orgId: string, departmentId?: number) {
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

    const statusMap: Record<string, number> = {};
    for (const row of headcountByStatus) {
      statusMap[String(row.lifecycle_status)] = Number(row.count);
    }

    const attrRow = attritionRate[0];
    const active = Number(attrRow?.active ?? 0);
    const exits = Number(attrRow?.exits ?? 0);
    const attritionPct = active > 0 ? Number(((exits / (active + exits)) * 100).toFixed(1)) : 0;

    const tenureMonthsRaw = avgTenure[0]?.avg_months;
    const avgTenureMonths = tenureMonthsRaw ? Number(Number(tenureMonthsRaw).toFixed(1)) : 0;

    const leaveRow = leaveUtilization[0];
    const leaveAccrued = Number(leaveRow?.accrued ?? 0);
    const leaveUtil = leaveAccrued > 0
      ? Number(((Number(leaveRow?.consumed ?? 0) / leaveAccrued) * 100).toFixed(1))
      : 0;

    const attRow = attendanceRate[0];
    const attTotal = Number(attRow?.total ?? 0);
    const attendancePct = attTotal > 0
      ? Number(((Number(attRow?.present ?? 0) / attTotal) * 100).toFixed(1))
      : 0;

    const casesCount = Number(openCases[0]?.count ?? 0);
    const moodRaw = avgMood[0]?.avg_mood;
    const payrollGrossRaw = lastPayroll[0]?.gross_total;
    const payrollMonthRaw = lastPayroll[0]?.month;

    return {
      headcount: {
        total: Object.values(statusMap).reduce((a, b) => a + b, 0),
        active: statusMap["ACTIVE"] ?? 0,
        probation: statusMap["ONBOARDING"] ?? 0,
        notice: statusMap["NOTICE"] ?? 0,
      },
      attritionRate12mo: attritionPct,
      avgTenureMonths,
      leaveUtilizationPct: leaveUtil,
      attendanceRatePct: attendancePct,
      openCasesCount: casesCount,
      avgMood: moodRaw ? Number(Number(moodRaw).toFixed(2)) : null,
      payrollCostLastMonth: payrollGrossRaw ? Number(payrollGrossRaw) : null,
    };
  }

  getAttrition(orgId: string, departmentId?: number) {
    return this.cache.cached(
      `hr:analytics-plus:attrition:${orgId}:${departmentId ?? "all"}`,
      async () => {
        const deptFilter = departmentId ? sql` AND e.department_id = ${departmentId}` : sql``;
        const [joinsVsExits, byDepartment, byReason] = await Promise.all([
          this.db.execute(sql`
            SELECT
              to_char(date_trunc('month', joining_date::timestamp), 'YYYY-MM') as month,
              COUNT(*) as joins,
              0 as exits
            FROM hr_employments e
            WHERE e.org_id = ${orgId} AND e.deleted_at IS NULL
              AND e.joining_date >= NOW() - INTERVAL '24 months'${deptFilter}
            GROUP BY 1
            UNION ALL
            SELECT
              to_char(date_trunc('month', exit_date::timestamp), 'YYYY-MM') as month,
              0 as joins,
              COUNT(*) as exits
            FROM hr_employments e
            WHERE e.org_id = ${orgId} AND e.deleted_at IS NULL
              AND e.exit_date >= NOW() - INTERVAL '24 months'${deptFilter}
            GROUP BY 1
            ORDER BY 1
          `),
          this.db.execute(sql`
            SELECT d.name as department, COUNT(*) as exits
            FROM hr_employments e
            JOIN departments d ON d.id = e.department_id
            WHERE e.org_id = ${orgId} AND e.exit_date IS NOT NULL
              AND e.exit_date >= NOW() - INTERVAL '24 months' AND e.deleted_at IS NULL
            GROUP BY d.name
            ORDER BY exits DESC
          `),
          this.db.execute(sql`
            SELECT COALESCE(exit_reason, 'Unknown') as reason, COUNT(*) as count
            FROM hr_employments
            WHERE org_id = ${orgId} AND exit_date IS NOT NULL
              AND exit_date >= NOW() - INTERVAL '24 months' AND deleted_at IS NULL
            GROUP BY exit_reason
            ORDER BY count DESC
          `),
        ]);

        const monthMap: Record<string, { month: string; joins: number; exits: number }> = {};
        for (const row of joinsVsExits) {
          const month = String(row.month);
          if (!monthMap[month]) monthMap[month] = { month, joins: 0, exits: 0 };
          monthMap[month].joins += Number(row.joins);
          monthMap[month].exits += Number(row.exits);
        }

        return {
          joinsVsExits: Object.values(monthMap).sort((a, b) => a.month.localeCompare(b.month)),
          byDepartment: byDepartment.map((r) => ({
            department: String(r.department ?? "Unknown"),
            exits: Number(r.exits ?? 0),
          })),
          byReason: byReason.map((r) => ({
            reason: String(r.reason ?? "Unknown"),
            count: Number(r.count ?? 0),
          })),
        };
      },
      CACHE_TTL.MEDIUM,
    );
  }

  getLeaveTrends(orgId: string, departmentId?: number) {
    return this.cache.cached(
      `hr:analytics-plus:leave:${orgId}:${departmentId ?? "all"}`,
      async () => {
        const rows = await this.db.execute(sql`
          SELECT
            to_char(date_trunc('month', l.effective_date::timestamp), 'YYYY-MM') as month,
            lt.name as leave_type,
            SUM(l.days::numeric) as days
          FROM hr_leave_ledger l
          JOIN leave_types lt ON lt.id = l.leave_type_id
          WHERE l.org_id = ${orgId}
            AND l.txn_type = 'consumption'
            AND l.effective_date >= NOW() - INTERVAL '12 months'
          GROUP BY 1, 2
          ORDER BY 1, 2
        `);
        return { trends: rows };
      },
      CACHE_TTL.MEDIUM,
    );
  }

  getPayrollCost(orgId: string) {
    return this.cache.cached(
      `hr:analytics-plus:payroll:${orgId}`,
      async () => {
        const rows = await this.db.execute(sql`
          SELECT month, gross_total, net_total, deduction_total, employee_count
          FROM payroll_runs
          WHERE org_id = ${orgId}
            AND month >= to_char(NOW() - INTERVAL '12 months', 'YYYY-MM')
          ORDER BY month DESC
        `);
        return {
          monthly: rows.map((r) => ({
            month: String(r.month ?? ""),
            grossTotal: Number(r.gross_total ?? 0),
          })),
        };
      },
      CACHE_TTL.MEDIUM,
    );
  }

  getEngagementTrends(orgId: string) {
    return this.cache.cached(
      `hr:analytics-plus:engagement:${orgId}`,
      async () => {
        const rows = await this.db.execute(sql`
          SELECT
            to_char(date_trunc('month', date::timestamp), 'YYYY-MM') as month,
            AVG(mood) as avg_mood,
            COUNT(*) as checkins
          FROM hr_mood_checkins
          WHERE org_id = ${orgId}
            AND date >= NOW() - INTERVAL '12 months'
          GROUP BY 1
          ORDER BY 1
        `);
        return {
          moodByMonth: rows.map((r) => ({
            month: String(r.month ?? ""),
            avgMood: Number(r.avg_mood ?? 0),
          })),
        };
      },
      CACHE_TTL.MEDIUM,
    );
  }

  getPerformanceDistribution(orgId: string, cycleId?: number) {
    return this.cache.cached(
      `hr:analytics-plus:perf:${orgId}:${cycleId ?? "all"}`,
      async () => {
        const cycleFilter = cycleId ? sql` AND pr.cycle_id = ${cycleId}` : sql``;
        const rows = await this.db.execute(sql`
          SELECT overall_rating as rating, COUNT(*) as count
          FROM performance_reviews pr
          WHERE pr.org_id = ${orgId}${cycleFilter}
            AND overall_rating IS NOT NULL
          GROUP BY overall_rating
          ORDER BY overall_rating
        `);
        return {
          distribution: rows.map((r) => ({
            rating: Number(r.rating ?? 0),
            count: Number(r.count ?? 0),
          })),
        };
      },
      CACHE_TTL.MEDIUM,
    );
  }

  getComplianceGaps(orgId: string, departmentId?: number) {
    return this.cache.cached(
      `hr:analytics-plus:compliance:${orgId}:${departmentId ?? "all"}`,
      async () => {
        const rows = await this.db.execute(sql`
          SELECT category, severity, COUNT(*) as count
          FROM hr_cases
          WHERE org_id = ${orgId}
            AND status IN ('open','under_investigation')
            AND deleted_at IS NULL
          GROUP BY category, severity
          ORDER BY count DESC
        `);
        return {
          openCases: rows.map((r) => ({
            category: String(r.category ?? "Unknown"),
            count: Number(r.count ?? 0),
          })),
        };
      },
      CACHE_TTL.SHORT,
    );
  }

  static getMetricDefinitions() {
    return [
      { name: "headcount", formula: "COUNT(active employments)", source: "hr_employments" },
      { name: "attritionRate", formula: "exits_12m / (active + exits_12m) * 100", source: "hr_employments" },
      { name: "avgTenure", formula: "AVG(months since joining_date) for ACTIVE", source: "hr_employments" },
      { name: "leaveUtilization", formula: "consumed_days / accrued_days * 100 (YTD)", source: "hr_leave_ledger" },
      { name: "attendanceRate", formula: "PRESENT / total * 100 (last 30d)", source: "attendance" },
      { name: "openCases", formula: "COUNT(status IN open,under_investigation)", source: "hr_cases" },
      { name: "avgMood", formula: "AVG(mood) last 30d", source: "hr_mood_checkins" },
      { name: "payrollGross", formula: "gross_total of last PAID run", source: "payroll_runs" },
    ];
  }

  async getDrilldown(orgId: string, metric: string, page: number, limit: number, departmentId?: number) {
    const offset = (page - 1) * limit;
    let rows: unknown[] = [];
    let total = 0;

    if (metric === "attrition") {
      const result = await this.db.execute(sql`
        SELECT e.id, e.employee_number, p.first_name, p.last_name, e.exit_date, e.exit_reason, d.name as department
        FROM hr_employments e
        JOIN hr_people p ON p.id = e.person_id
        LEFT JOIN departments d ON d.id = e.department_id
        WHERE e.org_id = ${orgId} AND e.exit_date IS NOT NULL AND e.deleted_at IS NULL
        ORDER BY e.exit_date DESC
        LIMIT ${limit} OFFSET ${offset}
      `);
      const cnt = await this.db.execute(sql`
        SELECT COUNT(*) as total FROM hr_employments
        WHERE org_id = ${orgId} AND exit_date IS NOT NULL AND deleted_at IS NULL
      `);
      rows = result;
      total = Number(cnt[0]?.total ?? 0);
    } else if (metric === "leave") {
      const result = await this.db.execute(sql`
        SELECT lr.id, lr.user_id, lt.name as leave_type, lr.start_date, lr.end_date, lr.status
        FROM leave_requests lr
        JOIN leave_types lt ON lt.id = lr.leave_type_id
        WHERE lr.org_id = ${orgId}
        ORDER BY lr.start_date DESC
        LIMIT ${limit} OFFSET ${offset}
      `);
      const cnt = await this.db.execute(sql`SELECT COUNT(*) as total FROM leave_requests WHERE org_id = ${orgId}`);
      rows = result;
      total = Number(cnt[0]?.total ?? 0);
    } else if (metric === "attendance") {
      const result = await this.db.execute(sql`
        SELECT id, user_id, date, status, work_hours
        FROM attendance
        WHERE org_id = ${orgId}
        ORDER BY date DESC
        LIMIT ${limit} OFFSET ${offset}
      `);
      const cnt = await this.db.execute(sql`SELECT COUNT(*) as total FROM attendance WHERE org_id = ${orgId}`);
      rows = result;
      total = Number(cnt[0]?.total ?? 0);
    } else if (metric === "cases") {
      const result = await this.db.execute(sql`
        SELECT id, case_number, category, severity, status, created_at
        FROM hr_cases
        WHERE org_id = ${orgId} AND status IN ('open','under_investigation') AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `);
      const cnt = await this.db.execute(sql`
        SELECT COUNT(*) as total FROM hr_cases
        WHERE org_id = ${orgId} AND status IN ('open','under_investigation') AND deleted_at IS NULL
      `);
      rows = result;
      total = Number(cnt[0]?.total ?? 0);
    }

    return { rows, total, page, limit };
  }

  getWorkforcePlans(orgId: string) {
    return this.db
      .select({
        id: hrHeadcountPlans.id,
        fiscalYear: hrHeadcountPlans.fiscalYear,
        departmentId: hrHeadcountPlans.departmentId,
        departmentName: departments.name,
        budgetedHeadcount: hrHeadcountPlans.budgetedHeadcount,
        budgetedCostCents: hrHeadcountPlans.budgetedCostCents,
        note: hrHeadcountPlans.note,
        createdAt: hrHeadcountPlans.createdAt,
      })
      .from(hrHeadcountPlans)
      .leftJoin(departments, eq(departments.id, hrHeadcountPlans.departmentId))
      .where(eq(hrHeadcountPlans.orgId, orgId))
      .orderBy(hrHeadcountPlans.fiscalYear, departments.name);
  }

  createHeadcountPlan(orgId: string, data: {
    fiscalYear: number;
    departmentId?: number;
    budgetedHeadcount: number;
    budgetedCostCents?: number;
    note?: string;
  }) {
    return this.db
      .insert(hrHeadcountPlans)
      .values({ orgId, ...data })
      .returning();
  }

  async updateHeadcountPlan(
    orgId: string,
    id: number,
    data: Partial<{
      departmentId: number;
      budgetedHeadcount: number;
      budgetedCostCents: number;
      note: string;
    }>,
  ) {
    const [row] = await this.db
      .update(hrHeadcountPlans)
      .set(data)
      .where(and(eq(hrHeadcountPlans.id, id), eq(hrHeadcountPlans.orgId, orgId)))
      .returning();
    return row;
  }

  async getBudgetVsActual(orgId: string) {
    const rows = await this.db.execute(sql`
      SELECT
        h.id,
        h.fiscal_year,
        h.department_id,
        d.name as department_name,
        h.budgeted_headcount,
        h.budgeted_cost_cents,
        COUNT(e.id) FILTER (WHERE e.lifecycle_status = 'ACTIVE' AND e.deleted_at IS NULL) as actual_headcount
      FROM hr_headcount_plans h
      LEFT JOIN departments d ON d.id = h.department_id
      LEFT JOIN hr_employments e ON e.org_id = h.org_id AND e.department_id = h.department_id
      WHERE h.org_id = ${orgId}
      GROUP BY h.id, h.fiscal_year, h.department_id, d.name, h.budgeted_headcount, h.budgeted_cost_cents
      ORDER BY h.fiscal_year DESC, d.name
    `);
    return Array.from(rows, (row) => {
      const budgeted = Number(row.budgeted_headcount ?? 0);
      const actual = Number(row.actual_headcount ?? 0);
      return {
        planId: Number(row.id ?? 0),
        fiscalYear: Number(row.fiscal_year ?? 0),
        departmentId: row.department_id == null ? null : Number(row.department_id),
        departmentName: String(row.department_name ?? "Organization-wide"),
        budgeted,
        actual,
        variance: actual - budgeted,
      };
    });
  }

  async getSkillsGap(orgId: string) {
    const rows = await this.db.execute(sql`
      SELECT
        r.skill_name,
        COUNT(DISTINCT r.id) as required_count,
        COUNT(DISTINCT CASE WHEN p.skills::text LIKE '%' || r.skill_name || '%' THEN e.id END) as covered_count
      FROM hr_role_skill_requirements r
      JOIN hr_employments e ON e.org_id = r.org_id AND e.lifecycle_status = 'ACTIVE' AND e.job_role_id = r.job_role_id AND e.deleted_at IS NULL
      LEFT JOIN hr_employee_profiles p ON p.employment_id = e.id
      WHERE r.org_id = ${orgId}
      GROUP BY r.skill_name
      ORDER BY (COUNT(DISTINCT r.id) - COUNT(DISTINCT CASE WHEN p.skills::text LIKE '%' || r.skill_name || '%' THEN e.id END)) DESC
    `);
    return {
      gaps: Array.from(rows, (row) => {
        const required = Number(row.required_count ?? 0);
        const covered = Number(row.covered_count ?? 0);
        return {
          skillName: String(row.skill_name ?? ""),
          required,
          covered,
          gap: Math.max(0, required - covered),
        };
      }),
    };
  }

  async getSuccessionRisk(orgId: string) {
    const rows = await this.db.execute(sql`
      SELECT
        s.id, s.role_name, s.incumbent_id, s.readiness,
        (s.successor_id IS NOT NULL) as has_successor,
        s.note
      FROM hr_succession_plans s
      WHERE s.org_id = ${orgId}
      ORDER BY CASE s.readiness WHEN 'ready_now' THEN 1 WHEN '1_2_years' THEN 2 ELSE 3 END
    `);
    return {
      riskyRoles: Array.from(rows, (row) => ({
        id: Number(row.id ?? 0),
        roleName: String(row.role_name ?? ""),
        incumbentId: row.incumbent_id == null ? null : String(row.incumbent_id),
        readiness: row.readiness == null ? null : String(row.readiness),
        hasSuccessor: Boolean(row.has_successor),
        note: row.note == null ? null : String(row.note),
      })),
    };
  }

  async getAttritionForecast(orgId: string) {
    const monthlyResult = await this.db.execute(sql`
      SELECT
        to_char(date_trunc('month', exit_date::timestamp), 'YYYY-MM') as month,
        COUNT(*) as exits
      FROM hr_employments
      WHERE org_id = ${orgId} AND exit_date >= NOW() - INTERVAL '12 months' AND deleted_at IS NULL
      GROUP BY 1
      ORDER BY 1
    `);

    const headcountResult = await this.db.execute(sql`
      SELECT COUNT(*) as active
      FROM hr_employments
      WHERE org_id = ${orgId} AND exit_date IS NULL AND deleted_at IS NULL
    `);
    const activeHeadcount = Math.max(1, Number(headcountResult[0]?.active ?? 0));

    const toRate = (exits: number) =>
      Number(((exits / activeHeadcount) * 100).toFixed(1));

    const historical = Array.from(monthlyResult, (row) => {
      const exits = Number(row.exits ?? 0);
      return {
        month: String(row.month ?? ""),
        exits,
        rate: toRate(exits),
      };
    });

    if (historical.length === 0) {
      return {
        historical: [],
        forecast: [],
        disclaimer:
          "No employee exits recorded in the last 12 months, so there is no trend to project yet.",
      };
    }

    const avgExits =
      historical.reduce((sum, row) => sum + row.exits, 0) / historical.length;

    const now = new Date();
    const forecast = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() + i + 1, 1);
      return {
        month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
        projectedExits: Number(avgExits.toFixed(1)),
        projectedRate: toRate(avgExits),
      };
    });

    return {
      historical,
      forecast,
      disclaimer:
        "Simple 12-month average of recorded exits against current active headcount — a trend illustration, not a prediction.",
    };
  }
}
