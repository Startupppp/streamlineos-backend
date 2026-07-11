import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { hrCompCycles, hrCompRecommendations } from "../../db/schema/hr/enterprise-comp";

@Injectable()
export class WorkforceCostingService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async costByDepartment(orgId: string, periodKey: string) {
    const rows = await this.db.execute(sql`
      SELECT
        d.id AS department_id,
        d.name AS department_name,
        COUNT(DISTINCT esp.user_id) AS headcount,
        SUM(CAST(esp.annual_ctc AS BIGINT) / 12) AS monthly_cost_cents
      FROM employee_salary_profiles esp
      JOIN department_members dm ON dm.user_id = esp.user_id
      JOIN departments d ON d.id = dm.department_id AND d.org_id = ${orgId}
      WHERE esp.org_id = ${orgId}
        AND esp.status = 'ACTIVE'
      GROUP BY d.id, d.name
      ORDER BY monthly_cost_cents DESC
    `);
    return rows as Record<string, unknown>[];
  }

  async costByLocation(orgId: string) {
    const rows = await this.db.execute(sql`
      SELECT
        COALESCE(he.location_id::TEXT, 'unassigned') AS location_id,
        COUNT(DISTINCT esp.user_id) AS headcount,
        SUM(CAST(esp.annual_ctc AS BIGINT) / 12) AS monthly_cost_cents
      FROM employee_salary_profiles esp
      JOIN hr_employments he ON he.org_id = ${orgId} AND he.deleted_at IS NULL
      WHERE esp.org_id = ${orgId}
        AND esp.status = 'ACTIVE'
      GROUP BY he.location_id
      ORDER BY monthly_cost_cents DESC
    `);
    return rows as Record<string, unknown>[];
  }

  async forecastedCost(orgId: string, cycleId: number) {
    const [cycle] = await this.db.select({ budgetPoolCents: hrCompCycles.budgetPoolCents, fiscalYear: hrCompCycles.fiscalYear }).from(hrCompCycles).where(and(eq(hrCompCycles.id, cycleId), eq(hrCompCycles.orgId, orgId))).limit(1);

    const approvedRecs = await this.db.select({
      userId: hrCompRecommendations.userId,
      currentSalaryCents: hrCompRecommendations.currentSalaryCents,
      finalIncrease: sql<number>`COALESCE(hr_calibrated_cents, recommended_increase_cents)`,
    }).from(hrCompRecommendations).where(and(eq(hrCompRecommendations.orgId, orgId), eq(hrCompRecommendations.cycleId, cycleId)));

    const totalCurrentCents = approvedRecs.reduce((s, r) => s + Number(r.currentSalaryCents), 0);
    const totalForecastedCents = approvedRecs.reduce((s, r) => s + Number(r.currentSalaryCents) + Number(r.finalIncrease), 0);

    return {
      cycleId,
      fiscalYear: cycle?.fiscalYear,
      budgetPoolCents: cycle?.budgetPoolCents ?? 0,
      headcount: approvedRecs.length,
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
    return rows[0] as Record<string, unknown>;
  }
}
