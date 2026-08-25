import { Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { AgingService } from "./aging.service";
import { BalanceSheetService } from "./balance-sheet.service";
import { CashFlowService } from "./cash-flow.service";
import { ProfitLossService } from "./profit-loss.service";
import { TaxSummaryService } from "./tax-summary.service";
import { TrialBalanceService } from "./trial-balance.service";
import { csvFilename } from "./report-csv";
import {
  agingQuerySchema,
  balanceSheetQuerySchema,
  cashFlowQuerySchema,
  profitLossQuerySchema,
  reportExportQuerySchema,
  taxSummaryQuerySchema,
  trialBalanceQuerySchema,
  type AgingQueryDto,
  type BalanceSheetQueryDto,
  type CashFlowQueryDto,
  type ProfitLossQueryDto,
  type ReportExportQueryDto,
  type TaxSummaryQueryDto,
  type TrialBalanceQueryDto,
} from "./dto/reports.schemas";

/**
 * Financial statements. Read-only by construction — there is no POST here and
 * there never will be, because a report that can write is a report that can
 * disagree with the ledger it claims to describe.
 *
 * Every handler is gated with `accounting:reports:read`; CSV goes through the
 * one export route so `accounting:reports:export` is asserted in a single place.
 */
@RequireModule("accounting")
@Controller("accounting/reports")
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(
    private readonly trialBalance: TrialBalanceService,
    private readonly profitLoss: ProfitLossService,
    private readonly balanceSheet: BalanceSheetService,
    private readonly cashFlow: CashFlowService,
    private readonly aging: AgingService,
    private readonly taxSummary: TaxSummaryService,
  ) {}

  @Get("trial-balance")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  getTrialBalance(
    @Query(new ZodValidationPipe(trialBalanceQuerySchema)) query: TrialBalanceQueryDto,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.trialBalance.run(user.orgId, query);
  }

  @Get("pnl")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  getProfitLoss(
    @Query(new ZodValidationPipe(profitLossQuerySchema)) query: ProfitLossQueryDto,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.profitLoss.run(user.orgId, query);
  }

  @Get("balance-sheet")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  getBalanceSheet(
    @Query(new ZodValidationPipe(balanceSheetQuerySchema)) query: BalanceSheetQueryDto,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.balanceSheet.run(user.orgId, query);
  }

  @Get("cash-flow")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  getCashFlow(
    @Query(new ZodValidationPipe(cashFlowQuerySchema)) query: CashFlowQueryDto,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.cashFlow.run(user.orgId, query);
  }

  @Get("aging")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  getAging(
    @Query(new ZodValidationPipe(agingQuerySchema)) query: AgingQueryDto,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.aging.run(user.orgId, query);
  }

  @Get("tax-summary")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  getTaxSummary(
    @Query(new ZodValidationPipe(taxSummaryQuerySchema)) query: TaxSummaryQueryDto,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.taxSummary.run(user.orgId, query);
  }

  /** `GET /accounting/reports/export?report=trial-balance&asOf=…` → text/csv. */
  @Get("export")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:export")
  async export(
    @Query(new ZodValidationPipe(reportExportQuerySchema)) query: ReportExportQueryDto,
    @CurrentUser() user: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const { csv, stamp } = await this.renderCsv(user.orgId, query);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${csvFilename([query.report, ...stamp])}"`,
    );
    res.send(csv);
  }

  private async renderCsv(
    orgId: string,
    query: ReportExportQueryDto,
  ): Promise<{ csv: string; stamp: string[] }> {
    switch (query.report) {
      case "trial-balance":
        return { csv: await this.trialBalance.csv(orgId, query), stamp: [query.asOf] };
      case "pnl":
        return { csv: await this.profitLoss.csv(orgId, query), stamp: [query.from, query.to] };
      case "balance-sheet":
        return { csv: await this.balanceSheet.csv(orgId, query), stamp: [query.asOf] };
      case "cash-flow":
        return { csv: await this.cashFlow.csv(orgId, query), stamp: [query.from, query.to] };
      case "aging":
        return { csv: await this.aging.csv(orgId, query), stamp: [query.side, query.asOf] };
      case "tax-summary":
        return { csv: await this.taxSummary.csv(orgId, query), stamp: [query.from, query.to] };
    }
  }
}
