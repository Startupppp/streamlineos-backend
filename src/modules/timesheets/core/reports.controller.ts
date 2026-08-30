import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ReportsService } from "./reports.service";
import { TimesheetAnalyticsService } from "./timesheet-analytics.service";
import {
  overviewQuerySchema,
  reportRangeQuerySchema,
  type OverviewQuery,
  type ReportRangeQuery,
} from "./dto/reports.schemas";

@RequireModule("build")
@Controller("timesheets/reports")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly analytics: TimesheetAnalyticsService,
  ) {}

  @Get("overview")
  @RequirePermission("timesheets:reports:view")
  overview(
    @Query(new ZodValidationPipe(overviewQuerySchema)) query: OverviewQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.getOverview(u, query);
  }

  @Get("utilization")
  @RequirePermission("timesheets:reports:view")
  utilization(
    @Query(new ZodValidationPipe(reportRangeQuerySchema)) query: ReportRangeQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.getUtilization(u, query);
  }

  @Get("client-profitability")
  @RequirePermission("timesheets:reports:view")
  clientProfitability(
    @Query(new ZodValidationPipe(reportRangeQuerySchema)) query: ReportRangeQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analytics.getClientProfitability(u, query);
  }

  @Get("compliance")
  @RequirePermission("timesheets:reports:view")
  compliance(
    @Query(new ZodValidationPipe(reportRangeQuerySchema)) query: ReportRangeQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analytics.getCompliance(u, query);
  }

  @Get("approval-sla")
  @RequirePermission("timesheets:reports:view")
  approvalSla(
    @Query(new ZodValidationPipe(reportRangeQuerySchema)) query: ReportRangeQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analytics.getApprovalSla(u, query);
  }

  @Get("billing-leakage")
  @RequirePermission("timesheets:reports:view")
  billingLeakage(
    @Query(new ZodValidationPipe(reportRangeQuerySchema)) query: ReportRangeQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analytics.getBillingLeakage(u, query);
  }
}
