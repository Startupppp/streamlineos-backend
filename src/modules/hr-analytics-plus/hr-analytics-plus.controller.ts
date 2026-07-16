import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  ParseIntPipe,
  UseGuards,
  ForbiddenException,
} from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AccessService } from "../access/access.service";
import { HrAnalyticsPlusService } from "./hr-analytics-plus.service";

const headcountPlanSchema = z.object({
  fiscalYear: z.number().int().min(2020).max(2050),
  departmentId: z.number().int().positive().optional(),
  budgetedHeadcount: z.number().int().positive(),
  budgetedCostCents: z.number().int().positive().optional(),
  note: z.string().max(500).optional(),
});

const updatePlanSchema = headcountPlanSchema.partial().omit({ fiscalYear: true });

const drilldownMetricSchema = z.enum(["attrition", "leave", "attendance", "cases"]);

@RequireModule("hr")
@Controller("hr/analytics-plus")
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermission("hr:analytics:read")
export class HrAnalyticsPlusController {
  constructor(
    private readonly svc: HrAnalyticsPlusService,
    private readonly access: AccessService,
  ) {}

  @Get()
  getCommandCenter(
    @CurrentUser() u: CurrentUserContext,
    @Query("departmentId", new ParseIntPipe({ optional: true })) departmentId?: number,
  ) {
    return this.svc.getCommandCenter(u.orgId, departmentId);
  }

  @Get("attrition")
  getAttrition(
    @CurrentUser() u: CurrentUserContext,
    @Query("departmentId", new ParseIntPipe({ optional: true })) departmentId?: number,
  ) {
    return this.svc.getAttrition(u.orgId, departmentId);
  }

  @Get("leave-trends")
  getLeaveTrends(
    @CurrentUser() u: CurrentUserContext,
    @Query("departmentId", new ParseIntPipe({ optional: true })) departmentId?: number,
  ) {
    return this.svc.getLeaveTrends(u.orgId, departmentId);
  }

  @Get("payroll-cost")
  async getPayrollCost(@CurrentUser() u: CurrentUserContext) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:salary:view") && !perms.has("hr:payroll:view")) {
        throw new ForbiddenException("hr:salary:view or hr:payroll:view required");
      }
    }
    return this.svc.getPayrollCost(u.orgId);
  }

  @Get("engagement")
  getEngagement(@CurrentUser() u: CurrentUserContext) {
    return this.svc.getEngagementTrends(u.orgId);
  }

  @Get("performance-distribution")
  getPerformanceDist(
    @CurrentUser() u: CurrentUserContext,
    @Query("cycleId", new ParseIntPipe({ optional: true })) cycleId?: number,
  ) {
    return this.svc.getPerformanceDistribution(u.orgId, cycleId);
  }

  @Get("compliance-gaps")
  getComplianceGaps(
    @CurrentUser() u: CurrentUserContext,
    @Query("departmentId", new ParseIntPipe({ optional: true })) departmentId?: number,
  ) {
    return this.svc.getComplianceGaps(u.orgId, departmentId);
  }

  @Get("metric-definitions")
  getMetricDefinitions() {
    return HrAnalyticsPlusService.getMetricDefinitions();
  }

  @Get("drilldown")
  getDrilldown(
    @CurrentUser() u: CurrentUserContext,
    @Query("metric") metric: string,
    @Query("page", new ParseIntPipe({ optional: true })) page = 1,
    @Query("limit", new ParseIntPipe({ optional: true })) limit = 20,
    @Query("departmentId", new ParseIntPipe({ optional: true })) departmentId?: number,
  ) {
    const parsedMetric = drilldownMetricSchema.parse(metric);
    return this.svc.getDrilldown(u.orgId, parsedMetric, page, Math.min(limit, 100), departmentId);
  }

  @Get("workforce/plans")
  @RequirePermission("hr:headcount:read")
  getWorkforcePlans(@CurrentUser() u: CurrentUserContext) {
    return this.svc.getWorkforcePlans(u.orgId);
  }

  @Post("workforce/plans")
  @RequirePermission("hr:workforce:manage")
  createPlan(@CurrentUser() u: CurrentUserContext, @Body() body: unknown) {
    const parsed = headcountPlanSchema.parse(body);
    return this.svc.createHeadcountPlan(u.orgId, parsed);
  }

  @Patch("workforce/plans/:id")
  @RequirePermission("hr:workforce:manage")
  updatePlan(
    @CurrentUser() u: CurrentUserContext,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: unknown,
  ) {
    const parsed = updatePlanSchema.parse(body);
    return this.svc.updateHeadcountPlan(u.orgId, id, parsed);
  }

  @Get("workforce/budget-vs-actual")
  @RequirePermission("hr:headcount:read")
  getBudgetVsActual(@CurrentUser() u: CurrentUserContext) {
    return this.svc.getBudgetVsActual(u.orgId);
  }

  @Get("workforce/skills-gap")
  getSkillsGap(@CurrentUser() u: CurrentUserContext) {
    return this.svc.getSkillsGap(u.orgId);
  }

  @Get("workforce/succession-risk")
  @RequirePermission("hr:succession:view")
  getSuccessionRisk(@CurrentUser() u: CurrentUserContext) {
    return this.svc.getSuccessionRisk(u.orgId);
  }

  @Get("workforce/attrition-forecast")
  getAttritionForecast(@CurrentUser() u: CurrentUserContext) {
    return this.svc.getAttritionForecast(u.orgId);
  }
}
