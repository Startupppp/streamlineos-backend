import {
  Controller,
  Get,
  Header,
  InternalServerErrorException,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { AccessService } from "../access/access.service";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
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
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { Validate } from "../../common/validation/validate.decorator";

@RequireModule("crm")
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
  @Validate({ query: analyticsQuerySchema })
  async getAnalytics(
    @Query() query: AnalyticsQuery,
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
  async getSlaAlerts(@CurrentUser() u: CurrentUserContext) {
    const scope = await resolveLeadsViewScope(this.access, u);
    return this.reports.getLeadSlaAlerts(u.orgId, {
      ownScope: scope === "own" || scope === "none",
      userId: u.userId,
    });
  }

  @Get("follow-ups")
  @RequirePermission("crm:leads:view")
  @Validate({ query: followUpsQuerySchema })
  getFollowUps(
    @Query() query: FollowUpsQuery,
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
  @Validate({ query: checkDuplicatesQuerySchema })
  checkDuplicates(
    @Query() query: CheckDuplicatesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exports.checkDuplicates(u.orgId, query);
  }

  @Get("export")
  @RequirePermission("crm:leads:view")
  @Validate({ query: exportQuerySchema })
  async exportCsv(
    @Query() query: ExportQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    const scope = await resolveLeadsViewScope(this.access, u);
    const result = await this.exports.exportCsv(u.orgId, u.userId, scope, query);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="leads-export.csv"');
    if (result.truncated) res.setHeader("X-Truncated", "true");
    res.setHeader("X-Row-Count", String(result.rowCount));
    res.send(result.csv);
  }
}
