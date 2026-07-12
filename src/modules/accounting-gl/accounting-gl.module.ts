import { Module } from "@nestjs/common";
import { AccountingModule } from "../accounting/accounting.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { GeneralLedgerController } from "./general-ledger.controller";
import { PeriodsController } from "./periods.controller";
import { JournalApprovalsController } from "./journal-approvals.controller";
import { RecurringJournalsController } from "./recurring-journals.controller";
import { GeneralLedgerService } from "./general-ledger.service";
import { PeriodsService } from "./periods.service";
import { JournalApprovalsService } from "./journal-approvals.service";
import { RecurringJournalsService } from "./recurring-journals.service";

@Module({
  imports: [AccountingModule, NotificationsModule],
  controllers: [
    GeneralLedgerController,
    PeriodsController,
    JournalApprovalsController,
    RecurringJournalsController,
  ],
  providers: [
    GeneralLedgerService,
    PeriodsService,
    JournalApprovalsService,
    RecurringJournalsService,
  ],
  exports: [PeriodsService, RecurringJournalsService],
})
export class AccountingGlModule {}
