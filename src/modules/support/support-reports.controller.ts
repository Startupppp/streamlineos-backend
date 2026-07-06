import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { AccessService } from "../access/access.service";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { SupportReportsService } from "./support-reports.service";
import { resolveSupportTicketsViewScope } from "./support-tickets-scope";
import { supportReportFiltersSchema, type SupportReportFiltersInput } from "./dto/support.schemas";

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
  getOverview(
    @Query(new ZodValidationPipe(supportReportFiltersSchema)) filters: SupportReportFiltersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.getOverview(u.orgId, filters);
  }

  @Get("agent-performance")
  async getAgentPerformance(
    @Query(new ZodValidationPipe(supportReportFiltersSchema)) filters: SupportReportFiltersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveSupportTicketsViewScope(this.access, u);
    const scopeToUserId = scope === "all" ? undefined : u.userId;
    return this.reports.getAgentPerformance(u.orgId, { ...filters, scopeToUserId });
  }

  @Get("queue-performance")
  getQueuePerformance(
    @Query(new ZodValidationPipe(supportReportFiltersSchema)) filters: SupportReportFiltersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.getQueuePerformance(u.orgId, filters);
  }

  @Get("channel-performance")
  getChannelPerformance(
    @Query(new ZodValidationPipe(supportReportFiltersSchema)) filters: SupportReportFiltersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.getChannelPerformance(u.orgId, filters);
  }

  @Get("automation-performance")
  getAutomationPerformance(
    @Query(new ZodValidationPipe(supportReportFiltersSchema)) filters: SupportReportFiltersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.getAutomationPerformance(u.orgId, filters);
  }
}
