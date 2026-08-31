import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AnalyticsReportsService } from "./analytics-reports.service";
import {
  dateRangeSchema,
  budgetVsActualQuerySchema,
  workingCapitalQuerySchema,
  cashRunwayQuerySchema,
  type DateRangeQuery,
  type BudgetVsActualQuery,
  type WorkingCapitalQuery,
  type CashRunwayQuery,
} from "./dto/finance-reports.schemas";
import { Validate } from "../../../common/validation/validate.decorator";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

@RequireModule("accounting")
@Controller("accounting/reports")
@UseGuards(JwtAuthGuard)
export class AnalyticsReportsController {
  constructor(private readonly analyticsService: AnalyticsReportsService) {}

  @Get("project-profitability")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  @Validate({ query: dateRangeSchema })
  getProjectProfitability(
    @Query() query: DateRangeQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analyticsService.projectProfitability(u.orgId, query.from, query.to);
  }

  @Get("department-profitability")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  @Validate({ query: dateRangeSchema })
  getDepartmentProfitability(
    @Query() query: DateRangeQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analyticsService.departmentProfitability(u.orgId, query.from, query.to);
  }

  @Get("budget-vs-actual")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  @Validate({ query: budgetVsActualQuerySchema })
  getBudgetVsActual(
    @Query() query: BudgetVsActualQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analyticsService.budgetVsActual(u.orgId, query.budgetId, query.from, query.to);
  }

  @Get("working-capital")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  @Validate({ query: workingCapitalQuerySchema })
  getWorkingCapital(
    @Query() query: WorkingCapitalQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const asOf = query.asOf ?? todayIso();
    return this.analyticsService.workingCapital(u.orgId, asOf);
  }

  @Get("burn-rate")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  getBurnRate(@CurrentUser() u: CurrentUserContext) {
    return this.analyticsService.burnRate(u.orgId);
  }

  @Get("cash-runway")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  @Validate({ query: cashRunwayQuerySchema })
  getCashRunway(
    @Query() query: CashRunwayQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.analyticsService.cashRunway(u.orgId, query.months);
  }
}
