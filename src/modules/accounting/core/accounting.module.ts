import { Module } from "@nestjs/common";
import { AccountingLedgerController } from "./accounting-ledger.controller";
import { AccountingStatementsController } from "./accounting-statements.controller";
import { AccountingPayablesReceivablesController } from "./accounting-payables-receivables.controller";
import { AccountingGstController } from "./accounting-gst.controller";
import { AccountingLedgerService } from "./accounting-ledger.service";
import { AccountingStatementsService } from "./accounting-statements.service";
import { AccountingPayablesService } from "./accounting-payables.service";
import { AccountingPayablesQueryService } from "./accounting-payables-query.service";
import { AccountingReceivablesService } from "./accounting-receivables.service";
import { AccountingGstService } from "./accounting-gst.service";
import { AccountingCashFlowService } from "./accounting-cash-flow.service";
import { AccountingVendorQueryService } from "./accounting-vendor-query.service";
import { AccountingJournalEntryService } from "./accounting-journal-entry.service";
import { AccountingAgedReceivablesService } from "./accounting-aged-receivables.service";
import { NotificationsModule } from "../../notifications/notifications.module";
import { FinanceControlsModule } from "../../finance/controls/finance-controls.module";
import { AccountingPostingModule } from "../posting/accounting-posting.module";

@Module({
  imports: [NotificationsModule, AccountingPostingModule, FinanceControlsModule],
  controllers: [
    AccountingLedgerController,
    AccountingStatementsController,
    AccountingPayablesReceivablesController,
    AccountingGstController,
  ],
  providers: [
    AccountingLedgerService,
    AccountingStatementsService,
    AccountingPayablesQueryService,
    AccountingPayablesService,
    AccountingReceivablesService,
    AccountingAgedReceivablesService,
    AccountingGstService,
    AccountingCashFlowService,
    AccountingVendorQueryService,
    AccountingJournalEntryService,
  ],
  exports: [AccountingPostingModule],
})
export class AccountingModule {}
