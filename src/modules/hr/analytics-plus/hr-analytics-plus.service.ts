import { Injectable, Inject, NotFoundException } from "@nestjs/common";
import { eq, and } from "drizzle-orm";
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
import { getMetricDefinitions } from "./hr-analytics-plus-metric-definitions";
import {
  fetchAttritionBreakdown,
  fetchComplianceGaps,
  fetchEngagementTrends,
  fetchLeaveTrends,
  fetchPayrollCost,
  fetchPerformanceDistribution,
} from "./hr-analytics-plus-trends";
import { fetchDrilldownPage } from "./hr-analytics-plus-drilldown";
import {
  fetchAttritionForecast,
  fetchBudgetVsActual,
  fetchSkillsGap,
  fetchSuccessionRisk,
} from "./hr-workforce-planning-analytics";

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
      () => fetchAttritionBreakdown(this.db, orgId, departmentId),
      CACHE_TTL.MEDIUM,
    );
  }

  getLeaveTrends(orgId: string, departmentId?: string) {
    return this.cache.cached(
      `hr:analytics-plus:leave:${orgId}:${departmentId ?? "all"}`,
      () => fetchLeaveTrends(this.db, orgId, departmentId),
      CACHE_TTL.MEDIUM,
    );
  }

  getPayrollCost(orgId: string) {
    return this.cache.cached(
      `hr:analytics-plus:payroll:${orgId}`,
      () => fetchPayrollCost(this.db, orgId),
      CACHE_TTL.MEDIUM,
    );
  }

  getEngagementTrends(orgId: string) {
    return this.cache.cached(
      `hr:analytics-plus:engagement:${orgId}`,
      () => fetchEngagementTrends(this.db, orgId),
      CACHE_TTL.MEDIUM,
    );
  }

  getPerformanceDistribution(orgId: string, cycleId?: number) {
    return this.cache.cached(
      `hr:analytics-plus:perf:${orgId}:${cycleId ?? "all"}`,
      () => fetchPerformanceDistribution(this.db, orgId, cycleId),
      CACHE_TTL.MEDIUM,
    );
  }

  getComplianceGaps(orgId: string, departmentId?: string) {
    return this.cache.cached(
      `hr:analytics-plus:compliance:${orgId}:${departmentId ?? "all"}`,
      () => fetchComplianceGaps(this.db, orgId, departmentId),
      CACHE_TTL.SHORT,
    );
  }

  static getMetricDefinitions() {
    return getMetricDefinitions();
  }

  getDrilldown(orgId: string, metric: string, page: number, limit: number, departmentId?: string) {
    return fetchDrilldownPage(this.db, orgId, metric, page, limit, departmentId);
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
    /**
     * A tenant-bound UPDATE that matches nothing returns no row, and returning that row unchecked
     * answers 200 with an empty body — for another organization's plan id and for an id belonging
     * to no organization alike. Measured by the live cross-tenant sweep: control 200, cross-tenant
     * 200, absent 200. Nothing crossed (the predicate held), but a caller — and any retry or
     * idempotency layer above it — cannot tell a write that landed from one that did not, and the
     * 404 the contract requires is absent.
     */
    if (!row) throw new NotFoundException("Headcount plan not found");
    return row;
  }

  getBudgetVsActual(orgId: string) {
    return fetchBudgetVsActual(this.db, orgId);
  }

  getSkillsGap(orgId: string) {
    return fetchSkillsGap(this.db, orgId);
  }

  getSuccessionRisk(orgId: string) {
    return fetchSuccessionRisk(this.db, orgId);
  }

  getAttritionForecast(orgId: string) {
    return fetchAttritionForecast(this.db, orgId);
  }
}
