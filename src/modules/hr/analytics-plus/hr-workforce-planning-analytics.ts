import { sql } from "drizzle-orm";
import { type Db } from "../../../db/drizzle.module";
import { MAX_ANALYTICS_ROWS } from "./hr-analytics-plus.constants";

export async function fetchBudgetVsActual(db: Db, orgId: string) {
  const rows = await db.execute(sql`
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

export async function fetchSkillsGap(db: Db, orgId: string) {
  const rows = await db.execute(sql`
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

export async function fetchSuccessionRisk(db: Db, orgId: string) {
  const rows = await db.execute(sql`
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

export async function fetchAttritionForecast(db: Db, orgId: string) {
  const monthlyResult = await db.execute(sql`
    SELECT
      to_char(date_trunc('month', exit_date::timestamp), 'YYYY-MM') as month,
      COUNT(*) as exits
    FROM hr_employments
    WHERE org_id = ${orgId} AND exit_date >= NOW() - INTERVAL '12 months' AND deleted_at IS NULL
    GROUP BY 1
    ORDER BY 1
    LIMIT ${MAX_ANALYTICS_ROWS}
  `);

  const headcountResult = await db.execute(sql`
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
