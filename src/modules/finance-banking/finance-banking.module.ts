import { Module } from "@nestjs/common";
import { AccountingModule } from "../accounting/accounting.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { BankAccountsController } from "./bank-accounts.controller";
import { ImportsController } from "./imports.controller";
import { ReconciliationController } from "./reconciliation.controller";
import { TransfersController } from "./transfers.controller";
import { BankAccountsService } from "./bank-accounts.service";
import { ImportsService } from "./imports.service";
import { MatchingService } from "./matching.service";
import { ReconciliationService } from "./reconciliation.service";
import { TransfersService } from "./transfers.service";

@Module({
  imports: [AccountingModule, NotificationsModule],
  controllers: [
    BankAccountsController,
    ImportsController,
    ReconciliationController,
    TransfersController,
  ],
  providers: [
    BankAccountsService,
    ImportsService,
    MatchingService,
    ReconciliationService,
    TransfersService,
  ],
})
export class FinanceBankingModule {}
