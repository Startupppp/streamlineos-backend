import {
  Controller,
  Get,
  Header,
  InternalServerErrorException,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { AccessService } from "../access/access.service";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { logger } from "../../common/logger/logger.service";
import { LeadsReportsService } from "./leads-reports.service";
import { LeadsExportsService } from "./leads-exports.service";
import { resolveLeadsViewScope } from "./leads-scope";
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
@UseGuards(JwtAuthGuard, PermissionGuard)
export class LeadsReportsController {
  constructor(
    private readonly reports: LeadsReportsService,
    private readonly exports: LeadsExportsService,
    private readonly access: AccessService,
  ) {}

  @Get("analytics")
  @RequirePermission("crm:leads:view")
  async getAnalytics(
    @Query(new ZodValidationPipe(analyticsQuerySchema)) query: AnalyticsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveLeadsViewScope(this.access, u);
    return this.reports.getLeadAnalytics(u.orgId, query, { scope, userId: u.userId });
  }

  @Get("dashboard-metrics")
  @RequirePermission("crm:leads:view")
  getDashboardMetrics(@CurrentUser() u: CurrentUserContext) {
    return this.reports.getDashboardMetrics(u.orgId);
  }

  @Get("source-report")
  @RequirePermission("crm:leads:view")
  getSourceReport(@CurrentUser() u: CurrentUserContext) {
    return this.reports.getSourceReport(u.orgId);
  }

  @Get("sales-leaderboard")
  @RequirePermission("crm:leads:view")
  getSalesLeaderboard(@CurrentUser() u: CurrentUserContext) {
    return this.reports.getSalesLeaderboard(u.orgId);
  }

  @Get("sales-team-capacity")
  @RequirePermission("crm:leads:view")
  getSalesTeamCapacity(@CurrentUser() u: CurrentUserContext) {
    return this.reports.getSalesTeamCapacity(u.orgId);
  }

  @Get("sla-alerts")
  @RequirePermission("crm:leads:view")
  getSlaAlerts(@CurrentUser() u: CurrentUserContext) {
    return this.reports.getLeadSlaAlerts(u.orgId, {
      role: u.role || undefined,
      userId: u.userId,
    });
  }

  @Get("follow-ups")
  @RequirePermission("crm:leads:view")
  getFollowUps(
    @Query(new ZodValidationPipe(followUpsQuerySchema)) query: FollowUpsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.getFollowUps(u.orgId, query);
  }

  @Get("unverified")
  @RequirePermission("crm:leads:view")
  getUnverified(@CurrentUser() u: CurrentUserContext) {
    return this.reports.getUnverifiedLeads(u.orgId);
  }

  @Get("duplicates")
  @RequirePermission("crm:leads:view")
  async getDuplicates(@CurrentUser() u: CurrentUserContext) {
    try {
      return await this.exports.getDuplicates(u.orgId);
    } catch (error) {
      logger.error("[duplicates] Error finding duplicate leads", { error });
      throw new InternalServerErrorException("Failed to scan for duplicates");
    }
  }

  @Get("check-duplicates")
  @RequirePermission("crm:leads:view")
  checkDuplicates(
    @Query(new ZodValidationPipe(checkDuplicatesQuerySchema)) query: CheckDuplicatesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exports.checkDuplicates(u.orgId, query);
  }

  @Get("export")
  @RequirePermission("crm:leads:view")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="leads-export.csv"')
  exportCsv(
    @Query(new ZodValidationPipe(exportQuerySchema)) query: ExportQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exports.exportCsv(u.orgId, query);
  }
}
