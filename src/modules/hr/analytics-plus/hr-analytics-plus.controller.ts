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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { AccessService } from "../../access/access.service";
import { HrAnalyticsPlusService } from "./hr-analytics-plus.service";
import {
  departmentQuerySchema,
  cycleQuerySchema,
  drilldownQuerySchema,
  headcountPlanSchema,
  updateHeadcountPlanSchema,
  type DepartmentQuery,
  type CycleQuery,
  type DrilldownQuery,
  type HeadcountPlanInput,
  type UpdateHeadcountPlanInput,
} from "./dto/hr-analytics-plus.schemas";
import { z } from "zod";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts"
import { getCommandCenterResponseSchema, getAttritionResponseSchema, getLeaveTrendsResponseSchema, getPayrollCostResponseSchema, getEngagementResponseSchema, getPerformanceDistResponseSchema, getComplianceGapsResponseSchema, getMetricDefinitionsResponseSchema, getDrilldownResponseSchema, getWorkforcePlansResponseSchema, createHeadcountPlanResponseSchema, updateHeadcountPlanResponseSchema, getBudgetVsActualResponseSchema, getSkillsGapResponseSchema, getSuccessionRiskResponseSchema, getAttritionForecastResponseSchema } from "./dto/analytics-plus-response.schemas"

const planIdParams = z.object({ planId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/analytics-plus")
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermission("hr:analytics:read")
export class HrAnalyticsPlusController {
  constructor(
    private readonly svc: HrAnalyticsPlusService,
    private readonly access: AccessService,
  ) {}

  @ResponseSchema(getCommandCenterResponseSchema)
  @Get()
  @Validate({ query: departmentQuerySchema })
  getCommandCenter(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: DepartmentQuery,
  ) {
    return this.svc.getCommandCenter(u.orgId, query.departmentId);
  }

  @ResponseSchema(getAttritionResponseSchema)
  @Get("attrition")
  @Validate({ query: departmentQuerySchema })
  getAttrition(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: DepartmentQuery,
  ) {
    return this.svc.getAttrition(u.orgId, query.departmentId);
  }

  @ResponseSchema(getLeaveTrendsResponseSchema)
  @Get("leave-trends")
  @Validate({ query: departmentQuerySchema })
  getLeaveTrends(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: DepartmentQuery,
  ) {
    return this.svc.getLeaveTrends(u.orgId, query.departmentId);
  }

  @ResponseSchema(getPayrollCostResponseSchema)
  @Get("payroll-cost")
  async getPayrollCost(@CurrentUser() u: CurrentUserContext) {
    if (!u.isOrgOwner) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:salary:view") && !perms.has("hr:payroll:view"))
        throw new ForbiddenException("hr:salary:view or hr:payroll:view required");
    }
    return this.svc.getPayrollCost(u.orgId);
  }

  @ResponseSchema(getEngagementResponseSchema)
  @Get("engagement")
  getEngagement(@CurrentUser() u: CurrentUserContext) {
    return this.svc.getEngagementTrends(u.orgId);
  }

  @ResponseSchema(getPerformanceDistResponseSchema)
  @Get("performance-distribution")
  @Validate({ query: cycleQuerySchema })
  getPerformanceDist(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: CycleQuery,
  ) {
    return this.svc.getPerformanceDistribution(u.orgId, query.cycleId);
  }

  @ResponseSchema(getComplianceGapsResponseSchema)
  @Get("compliance-gaps")
  @Validate({ query: departmentQuerySchema })
  getComplianceGaps(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: DepartmentQuery,
  ) {
    return this.svc.getComplianceGaps(u.orgId, query.departmentId);
  }

  @ResponseSchema(getMetricDefinitionsResponseSchema)
  @Get("metric-definitions")
  getMetricDefinitions() {
    return HrAnalyticsPlusService.getMetricDefinitions();
  }

  @ResponseSchema(getDrilldownResponseSchema)
  @Get("drilldown")
  @Validate({ query: drilldownQuerySchema })
  getDrilldown(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: DrilldownQuery,
  ) {
    return this.svc.getDrilldown(
      u.orgId,
      query.metric,
      query.page ?? 1,
      query.limit ?? 20,
      query.departmentId,
    );
  }

  @ResponseSchema(getWorkforcePlansResponseSchema)
  @Get("workforce/plans")
  @RequirePermission("hr:headcount:read")
  getWorkforcePlans(@CurrentUser() u: CurrentUserContext) {
    return this.svc.getWorkforcePlans(u.orgId);
  }

  @ResponseSchema(createHeadcountPlanResponseSchema)
  @Post("workforce/plans")
  @RequirePermission("hr:workforce:manage")
  @Validate({ body: headcountPlanSchema })
  createPlan(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: HeadcountPlanInput,
  ) {
    return this.svc.createHeadcountPlan(u.orgId, body);
  }

  @ResponseSchema(updateHeadcountPlanResponseSchema)
  @Patch("workforce/plans/:planId")
  @RequirePermission("hr:workforce:manage")
  @Validate({ body: updateHeadcountPlanSchema, params: planIdParams })
  updatePlan(
    @CurrentUser() u: CurrentUserContext,
    @Param("planId", ParseIntPipe) planId: number,
    @Body() body: UpdateHeadcountPlanInput,
  ) {
    return this.svc.updateHeadcountPlan(u.orgId, planId, body);
  }

  @ResponseSchema(getBudgetVsActualResponseSchema)
  @Get("workforce/budget-vs-actual")
  @RequirePermission("hr:headcount:read")
  getBudgetVsActual(@CurrentUser() u: CurrentUserContext) {
    return this.svc.getBudgetVsActual(u.orgId);
  }

  @ResponseSchema(getSkillsGapResponseSchema)
  @Get("workforce/skills-gap")
  getSkillsGap(@CurrentUser() u: CurrentUserContext) {
    return this.svc.getSkillsGap(u.orgId);
  }

  @ResponseSchema(getSuccessionRiskResponseSchema)
  @Get("workforce/succession-risk")
  @RequirePermission("hr:succession:view")
  getSuccessionRisk(@CurrentUser() u: CurrentUserContext) {
    return this.svc.getSuccessionRisk(u.orgId);
  }

  @ResponseSchema(getAttritionForecastResponseSchema)
  @Get("workforce/attrition-forecast")
  getAttritionForecast(@CurrentUser() u: CurrentUserContext) {
    return this.svc.getAttritionForecast(u.orgId);
  }
}
