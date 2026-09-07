import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { AccessService } from "../../access/access.service";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { SupportReportsService } from "./support-reports.service";
import { resolveSupportTicketsViewScope } from "./support-tickets-scope";
import { supportReportFiltersSchema, type SupportReportFiltersInput } from "./dto/support.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  supportOverviewSchema,
  agentPerformanceListSchema,
  queuePerformanceListSchema,
  channelPerformanceListSchema,
  automationPerformanceListSchema,
} from "./dto/support-report-response.schemas";

@RequireModule("support")
@Controller("support/reports")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
@RequirePermission("support:reports:view")
export class SupportReportsController {
  constructor(
    private readonly reports: SupportReportsService,
    private readonly access: AccessService,
  ) {}

  @Get("overview")
  @Validate({ query: supportReportFiltersSchema })
  @ResponseSchema(supportOverviewSchema)
  getOverview(
    @Query() filters: SupportReportFiltersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.getOverview(u.orgId, filters);
  }

  @Get("agent-performance")
  @Validate({ query: supportReportFiltersSchema })
  @ResponseSchema(agentPerformanceListSchema)
  async getAgentPerformance(
    @Query() filters: SupportReportFiltersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveSupportTicketsViewScope(this.access, u);
    const scopeToUserId = scope === "all" ? undefined : u.userId;
    return this.reports.getAgentPerformance(u.orgId, { ...filters, scopeToUserId });
  }

  @Get("queue-performance")
  @Validate({ query: supportReportFiltersSchema })
  @ResponseSchema(queuePerformanceListSchema)
  getQueuePerformance(
    @Query() filters: SupportReportFiltersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.getQueuePerformance(u.orgId, filters);
  }

  @Get("channel-performance")
  @Validate({ query: supportReportFiltersSchema })
  @ResponseSchema(channelPerformanceListSchema)
  getChannelPerformance(
    @Query() filters: SupportReportFiltersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.getChannelPerformance(u.orgId, filters);
  }

  @Get("automation-performance")
  @Validate({ query: supportReportFiltersSchema })
  @ResponseSchema(automationPerformanceListSchema)
  getAutomationPerformance(
    @Query() filters: SupportReportFiltersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.getAutomationPerformance(u.orgId, filters);
  }
}
