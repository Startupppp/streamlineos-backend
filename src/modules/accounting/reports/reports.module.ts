import { Module } from "@nestjs/common";
import { AccountingKernelModule } from "../kernel/accounting-kernel.module";
import { AgingService } from "./aging.service";
import { BalanceSheetService } from "./balance-sheet.service";
import { CashFlowService } from "./cash-flow.service";
import { ProfitLossService } from "./profit-loss.service";
import { ReportsController } from "./reports.controller";
import { TaxSummaryService } from "./tax-summary.service";
import { TrialBalanceService } from "./trial-balance.service";

const REPORT_SERVICES = [
  TrialBalanceService,
  ProfitLossService,
  BalanceSheetService,
  CashFlowService,
  AgingService,
  TaxSummaryService,
];

/**
 * The reporting layer.
 *
 * Every service here is a **reader**. It resolves a book, queries
 * `gl_journal_lines` and open items, and returns a projection — no writes, no
 * cached balances, no reporting table. That is what lets a report be trusted:
 * there is no stored number that can drift from the ledger.
 *
 * Book and pack lookups come from the kernel module rather than being
 * re-provided here, so the whole context shares one instance of each.
 */
@Module({
  imports: [AccountingKernelModule],
  controllers: [ReportsController],
  providers: REPORT_SERVICES,
  exports: REPORT_SERVICES,
})
export class ReportsModule {}
