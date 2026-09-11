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
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { ApiOkResponse } from "@nestjs/swagger";
import {
  leadsAnalyticsSchema,
  leadsDashboardMetricsSchema,
  leadsSourceReportSchema,
  leadsSalesLeaderboardSchema,
  leadsSalesTeamCapacitySchema,
  leadsSlaAlertsSchema,
  leadsFollowUpsSchema,
  leadsUnverifiedSchema,
  leadsDuplicateGroupsSchema,
  leadsCheckDuplicatesSchema,
} from "./dto/leads-response.schemas";

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
  @ResponseSchema(leadsAnalyticsSchema)
  @Validate({ query: analyticsQuerySchema })
  async getAnalytics(
    @Query() query: AnalyticsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const read = await resolveLeadsViewScope(this.access, u);
    return this.reports.getLeadAnalytics(read, query);
  }

  @Get("dashboard-metrics")
  @RequirePermission("crm:leads:view")
  @ResponseSchema(leadsDashboardMetricsSchema)
  async getDashboardMetrics(@CurrentUser() u: CurrentUserContext) {
    const read = await resolveLeadsViewScope(this.access, u);
    return this.reports.getDashboardMetrics(read);
  }

  @Get("source-report")
  @RequirePermission("crm:leads:view")
  @ResponseSchema(leadsSourceReportSchema)
  async getSourceReport(@CurrentUser() u: CurrentUserContext) {
    const read = await resolveLeadsViewScope(this.access, u);
    return this.reports.getSourceReport(read);
  }

  @Get("sales-leaderboard")
  @RequirePermission("crm:leads:view")
  @ResponseSchema(leadsSalesLeaderboardSchema)
  getSalesLeaderboard(@CurrentUser() u: CurrentUserContext) {
    return this.reports.getSalesLeaderboard(u.orgId);
  }

  @Get("sales-team-capacity")
  @RequirePermission("crm:leads:view")
  @ResponseSchema(leadsSalesTeamCapacitySchema)
  getSalesTeamCapacity(@CurrentUser() u: CurrentUserContext) {
    return this.reports.getSalesTeamCapacity(u.orgId);
  }

  @Get("sla-alerts")
  @RequirePermission("crm:leads:view")
  @ResponseSchema(leadsSlaAlertsSchema)
  async getSlaAlerts(@CurrentUser() u: CurrentUserContext) {
    const read = await resolveLeadsViewScope(this.access, u);
    return this.reports.getLeadSlaAlerts(read);
  }

  @Get("follow-ups")
  @RequirePermission("crm:leads:view")
  @ResponseSchema(leadsFollowUpsSchema)
  @Validate({ query: followUpsQuerySchema })
  async getFollowUps(
    @Query() query: FollowUpsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const read = await resolveLeadsViewScope(this.access, u);
    return this.reports.getFollowUps(read, query);
  }

  @Get("unverified")
  @RequirePermission("crm:leads:view")
  @ResponseSchema(leadsUnverifiedSchema)
  async getUnverified(@CurrentUser() u: CurrentUserContext) {
    const read = await resolveLeadsViewScope(this.access, u);
    return this.reports.getUnverifiedLeads(read);
  }

  @Get("duplicates")
  @RequirePermission("crm:leads:view")
  @ResponseSchema(leadsDuplicateGroupsSchema)
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
  @ResponseSchema(leadsCheckDuplicatesSchema)
  @Validate({ query: checkDuplicatesQuerySchema })
  checkDuplicates(
    @Query() query: CheckDuplicatesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exports.checkDuplicates(u.orgId, query);
  }

  @Get("export")
  @RequirePermission("crm:leads:view")
  @ApiOkResponse({ description: "CSV file download", content: { "text/csv": { schema: { type: "string" } } } })
  @Validate({ query: exportQuerySchema })
  async exportCsv(
    @Query() query: ExportQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    const read = await resolveLeadsViewScope(this.access, u);
    const result = await this.exports.exportCsv(read, query);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="leads-export.csv"');
    if (result.truncated) res.setHeader("X-Truncated", "true");
    res.setHeader("X-Row-Count", String(result.rowCount));
    res.send(result.csv);
  }
}
