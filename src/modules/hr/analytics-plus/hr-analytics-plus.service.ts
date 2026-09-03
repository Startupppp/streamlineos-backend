import { Injectable, Inject } from "@nestjs/common";
import { sql, eq, and } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import {
  orgUnits,
} from "../../../db/schema";
import {
  hrHeadcountPlans,
} from "../../../db/schema/hr/workforce-planning";
import { HrCommandCenterAnalyticsService } from "./hr-command-center-analytics.service";
import { boundHrReadLimit } from "../hr-read-limits";
import { getMetricDefinitions } from "./hr-analytics-plus-metric-definitions";

const MAX_ANALYTICS_ROWS = 1000;

@Injectable()
export class HrAnalyticsPlusService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly commandCenter: HrCommandCenterAnalyticsService,
  ) {}

  getCommandCenter(orgId: string, departmentId?: string) {
    return this.commandCenter.getCommandCenter(orgId, departmentId);
  }

  getAttrition(orgId: string, departmentId?: string) {
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
            JOIN org_units d ON d.id = e.department_id
            WHERE e.org_id = ${orgId} AND e.exit_date IS NOT NULL
              AND e.exit_date >= NOW() - INTERVAL '24 months' AND e.deleted_at IS NULL
            GROUP BY d.name
            ORDER BY exits DESC
            LIMIT ${MAX_ANALYTICS_ROWS}
          `),
          this.db.execute(sql`
            SELECT COALESCE(exit_reason, 'Unknown') as reason, COUNT(*) as count
            FROM hr_employments
            WHERE org_id = ${orgId} AND exit_date IS NOT NULL
              AND exit_date >= NOW() - INTERVAL '24 months' AND deleted_at IS NULL
            GROUP BY exit_reason
            ORDER BY count DESC
            LIMIT ${MAX_ANALYTICS_ROWS}
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

  getLeaveTrends(orgId: string, departmentId?: string) {
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
          LIMIT ${MAX_ANALYTICS_ROWS}
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
          LIMIT ${MAX_ANALYTICS_ROWS}
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
          LIMIT ${MAX_ANALYTICS_ROWS}
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
          LIMIT ${MAX_ANALYTICS_ROWS}
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

  getComplianceGaps(orgId: string, departmentId?: string) {
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
          LIMIT ${MAX_ANALYTICS_ROWS}
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
    return getMetricDefinitions();
  }

  async getDrilldown(orgId: string, metric: string, page: number, limit: number, _?: string) {
    limit = boundHrReadLimit(limit);
    const offset = (page - 1) * limit;
    let rows: unknown[] = [];
    let total = 0;

    if (metric === "attrition") {
      const result = await this.db.execute(sql`
        SELECT e.id, e.employee_number, p.first_name, p.last_name, e.exit_date, e.exit_reason, d.name as department
        FROM hr_employments e
        JOIN hr_people p ON p.id = e.person_id
        LEFT JOIN org_units d ON d.id = e.department_id
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
        departmentName: orgUnits.name,
        budgetedHeadcount: hrHeadcountPlans.budgetedHeadcount,
        budgetedCostCents: hrHeadcountPlans.budgetedCostCents,
        note: hrHeadcountPlans.note,
        createdAt: hrHeadcountPlans.createdAt,
      })
      .from(hrHeadcountPlans)
      .leftJoin(orgUnits, eq(orgUnits.id, hrHeadcountPlans.departmentId))
      .where(eq(hrHeadcountPlans.orgId, orgId))
      .orderBy(hrHeadcountPlans.fiscalYear, orgUnits.name)
      .limit(100);
  }

  createHeadcountPlan(orgId: string, data: {
    fiscalYear: number;
    departmentId?: string;
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
    headcountPlanId: number,
    data: Partial<{
      departmentId: string;
      budgetedHeadcount: number;
      budgetedCostCents: number;
      note: string;
    }>,
  ) {
    const [row] = await this.db
      .update(hrHeadcountPlans)
      .set({ ...data, updatedAt: new Date() })
      .where(
        and(
          eq(hrHeadcountPlans.id, headcountPlanId),
          eq(hrHeadcountPlans.orgId, orgId),
        ),
      )
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
      LEFT JOIN org_units d ON d.id = h.department_id
      LEFT JOIN hr_employments e ON e.org_id = h.org_id AND e.department_id = h.department_id
      WHERE h.org_id = ${orgId}
      GROUP BY h.id, h.fiscal_year, h.department_id, d.name, h.budgeted_headcount, h.budgeted_cost_cents
      ORDER BY h.fiscal_year DESC, d.name
      LIMIT ${MAX_ANALYTICS_ROWS}
    `);
    return Array.from(rows, (row) => {
      const budgeted = Number(row.budgeted_headcount ?? 0);
      const actual = Number(row.actual_headcount ?? 0);
      return {
        planId: Number(row.id ?? 0),
        fiscalYear: Number(row.fiscal_year ?? 0),
        departmentId: row.department_id == null ? null : String(row.department_id),
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
        COUNT(DISTINCT CASE WHEN es.id IS NOT NULL THEN e.id END) as covered_count
      FROM hr_role_skill_requirements r
      JOIN hr_employments e ON e.org_id = r.org_id AND e.lifecycle_status = 'ACTIVE' AND e.job_role_id = r.job_role_id AND e.deleted_at IS NULL
      JOIN hr_people hp ON hp.id = e.person_id AND hp.deleted_at IS NULL AND hp.user_id IS NOT NULL
      LEFT JOIN employee_skills es ON es.org_id = r.org_id AND es.user_id = hp.user_id AND lower(es.skill_name) = lower(r.skill_name)
      WHERE r.org_id = ${orgId}
      GROUP BY r.skill_name
      ORDER BY (COUNT(DISTINCT r.id) - COUNT(DISTINCT CASE WHEN es.id IS NOT NULL THEN e.id END)) DESC
      LIMIT ${MAX_ANALYTICS_ROWS}
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
      LIMIT ${MAX_ANALYTICS_ROWS}
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
      LIMIT ${MAX_ANALYTICS_ROWS}
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
