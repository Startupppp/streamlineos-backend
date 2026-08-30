import { Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AnalyticsReportsService } from "./analytics-reports.service";
import { buildCsv } from "./finance-reports-csv.util";
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

  @Get("project-profitability/export")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:export")
  @Validate({ query: dateRangeSchema })
  async exportProjectProfitability(
    @Query() query: DateRangeQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    const data = await this.analyticsService.projectProfitability(u.orgId, query.from, query.to);
    const csv = buildCsv(
      ["Project ID", "Project Name", "Revenue", "Cost", "Margin", "Margin %"],
      data.map((r) => [r.projectId, r.projectName, r.revenue, r.cost, r.margin, r.marginPct]),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="project-profitability.csv"`);
    res.send(csv);
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

  @Get("department-profitability/export")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:export")
  @Validate({ query: dateRangeSchema })
  async exportDepartmentProfitability(
    @Query() query: DateRangeQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    const data = await this.analyticsService.departmentProfitability(u.orgId, query.from, query.to);
    const csv = buildCsv(
      ["Department ID", "Department Name", "Revenue", "Cost", "Margin", "Margin %"],
      data.map((r) => [r.departmentId, r.departmentName, r.revenue, r.cost, r.margin, r.marginPct]),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="department-profitability.csv"`);
    res.send(csv);
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

  @Get("budget-vs-actual/export")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:export")
  @Validate({ query: budgetVsActualQuerySchema })
  async exportBudgetVsActual(
    @Query() query: BudgetVsActualQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    const data = await this.analyticsService.budgetVsActual(u.orgId, query.budgetId, query.from, query.to);
    const csv = buildCsv(
      ["Account ID", "Account Name", "Period", "Budget Amount", "Actual Amount", "Variance", "Variance %"],
      data.lines.map((l) => [l.accountId, l.accountName, l.periodKey, l.budgetAmount, l.actualAmount, l.variance, l.variancePct]),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="budget-vs-actual-${query.budgetId}.csv"`);
    res.send(csv);
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
