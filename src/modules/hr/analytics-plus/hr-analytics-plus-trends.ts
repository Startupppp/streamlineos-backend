import { sql } from "drizzle-orm";
import { type Db } from "../../../db/drizzle.module";
import { MAX_ANALYTICS_ROWS } from "./hr-analytics-plus.constants";
import { departmentMemberFilter } from "./hr-analytics-plus-department-filter";

export async function fetchAttritionBreakdown(db: Db, orgId: string, departmentId?: string) {
  const deptFilter = departmentId ? sql` AND e.department_id = ${departmentId}` : sql``;
  const [joinsVsExits, byDepartment, byReason] = await Promise.all([
    db.execute(sql`
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
    db.execute(sql`
      SELECT d.name as department, COUNT(*) as exits
      FROM hr_employments e
      JOIN org_units d ON d.id = e.department_id
      WHERE e.org_id = ${orgId} AND e.exit_date IS NOT NULL
        AND e.exit_date >= NOW() - INTERVAL '24 months' AND e.deleted_at IS NULL
      GROUP BY d.name
      ORDER BY exits DESC
      LIMIT ${MAX_ANALYTICS_ROWS}
    `),
    db.execute(sql`
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
}

export async function fetchLeaveTrends(db: Db, orgId: string, departmentId?: string) {
  const deptFilter = departmentMemberFilter(orgId, departmentId, sql`l.user_id`);
  const rows = await db.execute(sql`
    SELECT
      to_char(date_trunc('month', l.effective_date::timestamp), 'YYYY-MM') as month,
      lt.name as leave_type,
      SUM(l.days::numeric) as days
    FROM hr_leave_ledger l
    JOIN leave_types lt ON lt.id = l.leave_type_id
    WHERE l.org_id = ${orgId}
      AND l.txn_type = 'consumption'
      AND l.effective_date >= NOW() - INTERVAL '12 months'${deptFilter}
    GROUP BY 1, 2
    ORDER BY 1, 2
    LIMIT ${MAX_ANALYTICS_ROWS}
  `);
  return { trends: rows };
}

export async function fetchPayrollCost(db: Db, orgId: string) {
  const rows = await db.execute(sql`
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
}

/**
 * `hr_mood_checkins.date` is a text column holding YYYY-MM-DD, not a date.
 * Comparing it to `NOW() - INTERVAL '12 months'` asked Postgres for
 * `text >= timestamptz`, which has no operator — so every call to the engagement
 * endpoint raised 42883 and answered 500 before reading a single row, with or
 * without data in the table. That is the whole of "People analytics error /
 * Failed to load People analytics": the page was never failing on an empty
 * tenant, it was failing on the query. The cast below is the same one the SELECT
 * already relies on for `date_trunc`.
 */
export async function fetchEngagementTrends(db: Db, orgId: string) {
  const rows = await db.execute(sql`
    SELECT
      to_char(date_trunc('month', date::timestamp), 'YYYY-MM') as month,
      AVG(mood) as avg_mood,
      COUNT(*) as checkins
    FROM hr_mood_checkins
    WHERE org_id = ${orgId}
      AND date::date >= (NOW() - INTERVAL '12 months')::date
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
}

export async function fetchPerformanceDistribution(db: Db, orgId: string, cycleId?: number) {
  const cycleFilter = cycleId ? sql` AND pr.cycle_id = ${cycleId}` : sql``;
  const rows = await db.execute(sql`
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
}

export async function fetchComplianceGaps(db: Db, orgId: string, departmentId?: string) {
  const deptFilter = departmentMemberFilter(orgId, departmentId, sql`subject_employee_id`);
  const rows = await db.execute(sql`
    SELECT category, severity, COUNT(*) as count
    FROM hr_cases
    WHERE org_id = ${orgId}
      AND status IN ('open','under_investigation')
      AND deleted_at IS NULL${deptFilter}
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
}
