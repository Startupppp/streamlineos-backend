import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { hrCompCycles } from "../../../db/schema/hr/enterprise-comp";

@Injectable()
export class WorkforceCostingService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async costByDepartment(orgId: string, periodKey: string) {
    const parts = periodKey.split("-");
    const year = Number(parts[0]);
    const month = Number(parts[1]);
    const periodEnd = new Date(Date.UTC(year, month, 0));
    const periodEndStr = periodEnd.toISOString().slice(0, 10);

    const rows = await this.db.execute(sql`
      SELECT
        d.id AS department_id,
        d.name AS department_name,
        COUNT(DISTINCT esp.user_id) AS headcount,
        SUM(CAST(esp.annual_ctc AS BIGINT) / 12) AS monthly_cost_cents
      FROM (
        SELECT DISTINCT ON (user_id) user_id, annual_ctc
        FROM employee_salary_profiles
        WHERE org_id = ${orgId}
          AND effective_from <= ${periodEndStr}
          AND (effective_to IS NULL OR effective_to > ${periodEndStr})
        ORDER BY user_id, effective_from DESC
      ) esp
      JOIN organization_members om ON om.user_id = esp.user_id AND om.org_id = ${orgId}
      JOIN org_unit_members oum ON oum.membership_id = om.id
      JOIN org_units d ON d.id = oum.org_unit_id AND d.org_id = ${orgId} AND d.kind = 'DEPARTMENT'
      GROUP BY d.id, d.name
      ORDER BY monthly_cost_cents DESC
    `);
    return rows.map((row) => ({
      departmentId: row.department_id === null || row.department_id === undefined ? null : String(row.department_id),
      departmentName: row.department_name === null || row.department_name === undefined ? null : String(row.department_name),
      headcount: Number(row.headcount ?? 0),
      monthlyCostCents: Number(row.monthly_cost_cents ?? 0),
    }));
  }

  async costByLocation(orgId: string) {
    const rows = await this.db.execute(sql`
      SELECT
        COALESCE(he.location_id::TEXT, 'unassigned') AS location_id,
        COUNT(DISTINCT esp.user_id) AS headcount,
        SUM(CAST(esp.annual_ctc AS BIGINT) / 12) AS monthly_cost_cents
      FROM employee_salary_profiles esp
      JOIN hr_employments he ON he.user_id = esp.user_id AND he.org_id = ${orgId} AND he.deleted_at IS NULL
      WHERE esp.org_id = ${orgId}
        AND esp.status = 'ACTIVE'
      GROUP BY he.location_id
      ORDER BY monthly_cost_cents DESC
    `);
    return rows.map((row) => ({
      locationId: String(row.location_id ?? "unassigned"),
      headcount: Number(row.headcount ?? 0),
      monthlyCostCents: Number(row.monthly_cost_cents ?? 0),
    }));
  }

  async forecastedCost(orgId: string, cycleId: number) {
    const [cycle] = await this.db
      .select({ budgetPoolCents: hrCompCycles.budgetPoolCents, fiscalYear: hrCompCycles.fiscalYear })
      .from(hrCompCycles)
      .where(and(eq(hrCompCycles.id, cycleId), eq(hrCompCycles.orgId, orgId)))
      .limit(1);

    const [agg] = await this.db.execute(sql`
      SELECT
        COALESCE(SUM(current_salary_cents), 0) AS total_current,
        COALESCE(SUM(current_salary_cents + COALESCE(hr_calibrated_cents, recommended_increase_cents)), 0) AS total_forecasted,
        COUNT(*) AS headcount
      FROM hr_comp_recommendations
      WHERE org_id = ${orgId} AND cycle_id = ${cycleId}
    `);

    const totalCurrentCents = Number(agg?.["total_current"] ?? 0);
    const totalForecastedCents = Number(agg?.["total_forecasted"] ?? 0);
    const headcount = Number(agg?.["headcount"] ?? 0);

    return {
      cycleId,
      fiscalYear: cycle?.fiscalYear,
      budgetPoolCents: cycle?.budgetPoolCents ?? 0,
      headcount,
      totalCurrentAnnualCents: totalCurrentCents,
      totalForecastedAnnualCents: totalForecastedCents,
      totalIncreaseCents: totalForecastedCents - totalCurrentCents,
    };
  }

  async costSummary(orgId: string) {
    const rows = await this.db.execute(sql`
      SELECT
        COUNT(DISTINCT user_id) AS total_headcount,
        SUM(CAST(annual_ctc AS BIGINT)) AS total_annual_ctc_cents,
        SUM(CAST(annual_ctc AS BIGINT) / 12) AS total_monthly_cost_cents
      FROM employee_salary_profiles
      WHERE org_id = ${orgId}
        AND status = 'ACTIVE'
    `);
    const row = rows[0];
    return {
      totalHeadcount: Number(row?.total_headcount ?? 0),
      totalAnnualCtcCents: Number(row?.total_annual_ctc_cents ?? 0),
      totalMonthlyCostCents: Number(row?.total_monthly_cost_cents ?? 0),
    };
  }
}
