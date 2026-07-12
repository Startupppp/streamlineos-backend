import { Module } from "@nestjs/common";
import { AccountingModule } from "../accounting/accounting.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { CreditNotesController } from "./credit-notes.controller";
import { CreditNotesService } from "./credit-notes.service";
import { RecurringInvoicesController } from "./recurring-invoices.controller";
import { RecurringInvoicesService } from "./recurring-invoices.service";
import { RemindersController } from "./reminders.controller";
import { RemindersService } from "./reminders.service";
import { StatementsController } from "./statements.controller";
import { StatementsService } from "./statements.service";
import { CollectionsController } from "./collections.controller";
import { CollectionsService } from "./collections.service";

@Module({
  imports: [AccountingModule, InvoicesModule, NotificationsModule],
  controllers: [
    CreditNotesController,
    RecurringInvoicesController,
    RemindersController,
    StatementsController,
    CollectionsController,
  ],
  providers: [
    CreditNotesService,
    RecurringInvoicesService,
    RemindersService,
    StatementsService,
    CollectionsService,
  ],
  exports: [RecurringInvoicesService, RemindersService],
})
export class FinanceArModule {}
