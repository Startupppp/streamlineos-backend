import {
  Controller,
  Get,
  Header,
  InternalServerErrorException,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { logger } from "../../common/logger/logger.service";
import { LeadsReportsService } from "./leads-reports.service";
import { LeadsExportsService } from "./leads-exports.service";
import {
  analyticsQuerySchema,
  checkDuplicatesQuerySchema,
  exportQuerySchema,
  followUpsQuerySchema,
  type AnalyticsQuery,
  type CheckDuplicatesQuery,
  type ExportQuery,
  type FollowUpsQuery,
} from "./dto/lead-reports.schemas";

@Controller("leads")
@UseGuards(JwtAuthGuard)
export class LeadsReportsController {
  constructor(
    private readonly reports: LeadsReportsService,
    private readonly exports: LeadsExportsService,
  ) {}

  @Get("analytics")
  getAnalytics(
    @Query(new ZodValidationPipe(analyticsQuerySchema)) query: AnalyticsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.getLeadAnalytics(u.orgId, query);
  }

  @Get("dashboard-metrics")
  getDashboardMetrics(@CurrentUser() u: CurrentUserContext) {
    return this.reports.getDashboardMetrics(u.orgId);
  }

  @Get("source-report")
  getSourceReport(@CurrentUser() u: CurrentUserContext) {
    return this.reports.getSourceReport(u.orgId);
  }

  @Get("sales-leaderboard")
  getSalesLeaderboard(@CurrentUser() u: CurrentUserContext) {
    return this.reports.getSalesLeaderboard(u.orgId);
  }

  @Get("sales-team-capacity")
  getSalesTeamCapacity(@CurrentUser() u: CurrentUserContext) {
    return this.reports.getSalesTeamCapacity(u.orgId);
  }

  @Get("sla-alerts")
  getSlaAlerts(@CurrentUser() u: CurrentUserContext) {
    return this.reports.getLeadSlaAlerts(u.orgId, {
      role: u.role || undefined,
      userId: u.userId,
    });
  }

  @Get("follow-ups")
  getFollowUps(
    @Query(new ZodValidationPipe(followUpsQuerySchema)) query: FollowUpsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.getFollowUps(u.orgId, query);
  }

  @Get("unverified")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "crm:leads")
  getUnverified(@CurrentUser() u: CurrentUserContext) {
    return this.reports.getUnverifiedLeads(u.orgId);
  }

  @Get("duplicates")
  async getDuplicates(@CurrentUser() u: CurrentUserContext) {
    try {
      return await this.exports.getDuplicates(u.orgId);
    } catch (error) {
      logger.error("[duplicates] Error finding duplicate leads", { error });
      throw new InternalServerErrorException("Failed to scan for duplicates");
    }
  }

  @Get("check-duplicates")
  checkDuplicates(
    @Query(new ZodValidationPipe(checkDuplicatesQuerySchema)) query: CheckDuplicatesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exports.checkDuplicates(u.orgId, query);
  }

  @Get("export")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="leads-export.csv"')
  exportCsv(
    @Query(new ZodValidationPipe(exportQuerySchema)) query: ExportQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exports.exportCsv(u.orgId, query);
  }
}
