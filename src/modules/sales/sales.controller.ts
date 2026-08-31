import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { subMonths } from "../../common/date";
import { AccessService } from "../access/access.service";
import { SalesService, isForbidden, isNotFound, isConflict } from "./sales.service";
import { SalesDashboardService, type DateRange } from "./sales-dashboard.service";
import { SalesAnalyticsService, isRepNotFound } from "./sales-analytics.service";
import {
  commissionRuleCreateSchema,
  commissionListSchema,
  commissionUpdateSchema,
  quotaListSchema,
  quotaCreateSchema,
  playbookCreateSchema,
  playbookUpdateSchema,
  dashboardRangeSchema,
  leaderboardSchema,
  agingSchema,
  cohortSchema,
  revenueVsGoalSchema,
  repFilterSchema,
  repComparisonSchema,
  type CommissionRuleCreateInput,
  type CommissionListInput,
  type CommissionUpdateInput,
  type QuotaListInput,
  type QuotaCreateInput,
  type PlaybookCreateInput,
  type PlaybookUpdateInput,
  type DashboardRangeInput,
  type LeaderboardInput,
  type AgingInput,
  type CohortInput,
  type RevenueVsGoalInput,
  type RepFilterInput,
  type RepComparisonInput,
} from "./dto/sales.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";

const commissionIdParams = z.object({ commissionId: z.coerce.number().int().positive() }).strict();
const entryIdParams = z.object({ entryId: z.coerce.number().int().positive() }).strict();

function toRange(input: { from?: string; to?: string }): DateRange {
  return {
    from: input.from ? new Date(input.from) : undefined,
    to: input.to ? new Date(input.to) : undefined,
  };
}

@RequireModule("crm")
@Controller("sales")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class SalesController {
  constructor(
    private readonly sales: SalesService,
    private readonly dashboard: SalesDashboardService,
    private readonly analytics: SalesAnalyticsService,
    private readonly access: AccessService,
  ) {}

  private async scopeToSelfUnlessManager(
    u: CurrentUserContext,
    requested: string | undefined,
  ): Promise<string | undefined> {
    if (await this.access.holds(u, "sales:manage")) return requested;
    if (requested && requested !== u.userId) {
      throw new ForbiddenException("Not allowed to view another rep's records");
    }
    return u.userId;
  }

  @Get("commission-rules")
  @RequirePermission("sales:view")
  listCommissionRules(@CurrentUser() u: CurrentUserContext) {
    return this.sales.listCommissionRules(u.orgId);
  }

  @Post("commission-rules")
  @HttpCode(201)
  @RequirePermission("settings:manage")
  @Validate({ body: commissionRuleCreateSchema })
  createCommissionRule(
    @Body() body: CommissionRuleCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sales.createCommissionRule(u.orgId, body);
  }

  @Get("commissions")
  @RequirePermission("crm:incentives:read")
  @Validate({ query: commissionListSchema })
  async listCommissions(
    @Query() query: CommissionListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const userId = await this.scopeToSelfUnlessManager(u, query.userId);
    return this.sales.listCommissions(u.orgId, { ...query, userId });
  }

  @Patch("commissions/:commissionId")
  @UseGuards(PermissionGuard)
  @RequirePermission("sales:manage")
  @Validate({ params: commissionIdParams, body: commissionUpdateSchema })
  async updateCommission(
    @Param("commissionId", ParseIntPipe) commissionId: number,
    @Body() body: CommissionUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.sales.updateCommission(u.orgId, commissionId, body.status);
    if (isNotFound(result)) throw new NotFoundException("Commission not found");
    if (isConflict(result)) throw new ConflictException(result.message);
    return result;
  }

  @Get("quotas")
  @RequirePermission("crm:targets:view")
  @Validate({ query: quotaListSchema })
  async listQuotas(
    @Query() query: QuotaListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const userId = await this.scopeToSelfUnlessManager(u, query.userId);
    return this.sales.listQuotas(u.orgId, { ...query, userId });
  }

  @Post("quotas")
  @HttpCode(201)
  @RequirePermission("crm:targets:manage")
  @Validate({ body: quotaCreateSchema })
  async createQuota(
    @Body() body: QuotaCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.sales.createQuota(u.orgId, u, u.userId, body);
    if (isForbidden(result)) throw new ForbiddenException(result.message);
    return result;
  }

  @Get("playbook")
  @UseGuards(PermissionGuard)
  @RequirePermission("sales:view")
  listPlaybook(@CurrentUser() u: CurrentUserContext) {
    return this.sales.listPlaybook(u.orgId);
  }

  @Post("playbook")
  @UseGuards(PermissionGuard)
  @RequirePermission("sales:manage")
  @HttpCode(201)
  @Validate({ body: playbookCreateSchema })
  createPlaybookEntry(
    @Body() body: PlaybookCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sales.createPlaybookEntry(u.orgId, u.userId, body);
  }

  @Patch("playbook/:entryId")
  @UseGuards(PermissionGuard)
  @RequirePermission("sales:manage")
  @Validate({ params: entryIdParams, body: playbookUpdateSchema })
  async updatePlaybookEntry(
    @Param("entryId", ParseIntPipe) entryId: number,
    @Body() body: PlaybookUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const updated = await this.sales.updatePlaybookEntry(u.orgId, entryId, body);
    if (!updated) throw new NotFoundException("Playbook entry not found");
    return updated;
  }

  @Delete("playbook/:entryId")
  @UseGuards(PermissionGuard)
  @RequirePermission("sales:manage")
  @Validate({ params: entryIdParams })
  async removePlaybookEntry(
    @Param("entryId", ParseIntPipe) entryId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.sales.removePlaybookEntry(u.orgId, entryId);
    if (!result) throw new NotFoundException("Playbook entry not found");
    return result;
  }

  @Get("dashboard/kpis")
  @RequirePermission("sales:view")
  @Validate({ query: dashboardRangeSchema })
  dashboardKpis(
    @Query() query: DashboardRangeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const repId = query.repId ? Number(query.repId) : undefined;
    return this.dashboard.getKpis(u.orgId, toRange(query), repId);
  }

  @Get("dashboard/funnel")
  @RequirePermission("sales:view")
  @Validate({ query: dashboardRangeSchema })
  dashboardFunnel(
    @Query() query: DashboardRangeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const repId = query.repId ? Number(query.repId) : undefined;
    return this.dashboard.getFunnel(u.orgId, toRange(query), repId);
  }

  @Get("dashboard/leaderboard")
  @RequirePermission("sales:view")
  @Validate({ query: leaderboardSchema })
  dashboardLeaderboard(
    @Query() query: LeaderboardInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.dashboard.getLeaderboard(u.orgId, toRange(query));
  }

  @Get("dashboard/revenue-vs-goal")
  @RequirePermission("sales:view")
  @Validate({ query: revenueVsGoalSchema })
  dashboardRevenueVsGoal(
    @Query() query: RevenueVsGoalInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const yearNum = query.year ?? new Date().getFullYear();
    return this.dashboard.getRevenueVsGoal(u.orgId, yearNum);
  }

  @Get("dashboard/velocity")
  @RequirePermission("sales:view")
  @Validate({ query: leaderboardSchema })
  dashboardVelocity(
    @Query() query: LeaderboardInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.dashboard.getVelocity(u.orgId, toRange(query));
  }

  @Get("dashboard/aging")
  @RequirePermission("sales:view")
  @Validate({ query: agingSchema })
  dashboardAging(
    @Query() query: AgingInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.dashboard.getAging(u.orgId, query.threshold ?? 14);
  }

  @Get("dashboard/cohort")
  @RequirePermission("sales:view")
  @Validate({ query: cohortSchema })
  dashboardCohort(
    @Query() query: CohortInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analytics.getCohort(u.orgId, query.months);
  }

  @Get("dashboard/cycle-length")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:read")
  @Validate({ query: repFilterSchema })
  dashboardCycleLength(
    @Query() query: RepFilterInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analytics.getCycleLength(u.orgId, query.repId);
  }

  @Get("dashboard/lost-analysis")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:read")
  @Validate({ query: repFilterSchema })
  dashboardLostAnalysis(
    @Query() query: RepFilterInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analytics.getLostAnalysis(u.orgId, query.repId);
  }

  @Get("dashboard/rep-comparison")
  @RequirePermission("sales:view")
  @Validate({ query: repComparisonSchema })
  async dashboardRepComparison(
    @Query() query: RepComparisonInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const rep1Id = Number(query.rep1);
    const rep2Id = Number(query.rep2);
    if (!Number.isFinite(rep1Id) || !Number.isFinite(rep2Id)) {
      throw new BadRequestException("Invalid rep IDs");
    }

    const from = query.from ? new Date(query.from) : subMonths(new Date(), 6);
    const to = query.to ? new Date(query.to) : new Date();

    const result = await this.analytics.getRepComparison(u.orgId, rep1Id, rep2Id, from, to);
    if (isRepNotFound(result)) throw new NotFoundException("One or both reps not found");
    return result;
  }
}
