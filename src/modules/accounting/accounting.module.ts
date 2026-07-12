import { forwardRef, Module } from "@nestjs/common";
import { AccountingLedgerController } from "./accounting-ledger.controller";
import { AccountingStatementsController } from "./accounting-statements.controller";
import { AccountingPayablesReceivablesController } from "./accounting-payables-receivables.controller";
import { AccountingGstController } from "./accounting-gst.controller";
import { JournalPostingService } from "./journal-posting.service";
import { FinancePostingService } from "./finance-posting.service";
import { AccountingLedgerService } from "./accounting-ledger.service";
import { AccountingStatementsService } from "./accounting-statements.service";
import { AccountingPayablesService } from "./accounting-payables.service";
import { AccountingPayablesQueryService } from "./accounting-payables-query.service";
import { AccountingReceivablesService } from "./accounting-receivables.service";
import { AccountingGstService } from "./accounting-gst.service";
import { NotificationsModule } from "../notifications/notifications.module";
import { FinanceControlsModule } from "../finance-controls/finance-controls.module";

@Module({
  imports: [NotificationsModule, forwardRef(() => FinanceControlsModule)],
  controllers: [
    AccountingLedgerController,
    AccountingStatementsController,
    AccountingPayablesReceivablesController,
    AccountingGstController,
  ],
  providers: [
    JournalPostingService,
    FinancePostingService,
    AccountingLedgerService,
    AccountingStatementsService,
    AccountingPayablesQueryService,
    AccountingPayablesService,
    AccountingReceivablesService,
    AccountingGstService,
  ],
  exports: [JournalPostingService, FinancePostingService],
})
export class AccountingModule {}
