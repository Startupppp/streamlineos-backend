import { Module } from "@nestjs/common";
import { AccountingLedgerController } from "./accounting-ledger.controller";
import { AccountingStatementsController } from "./accounting-statements.controller";
import { AccountingPayablesReceivablesController } from "./accounting-payables-receivables.controller";
import { AccountingGstController } from "./accounting-gst.controller";
import { JournalPostingService } from "./journal-posting.service";
import { AccountingLedgerService } from "./accounting-ledger.service";
import { AccountingStatementsService } from "./accounting-statements.service";
import { AccountingPayablesService } from "./accounting-payables.service";
import { AccountingReceivablesService } from "./accounting-receivables.service";
import { AccountingGstService } from "./accounting-gst.service";

@Module({
  controllers: [
    AccountingLedgerController,
    AccountingStatementsController,
    AccountingPayablesReceivablesController,
    AccountingGstController,
  ],
  providers: [
    JournalPostingService,
    AccountingLedgerService,
    AccountingStatementsService,
    AccountingPayablesService,
    AccountingReceivablesService,
    AccountingGstService,
  ],
  exports: [JournalPostingService],
})
export class AccountingModule {}
