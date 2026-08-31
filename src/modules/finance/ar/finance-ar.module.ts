import { Module } from "@nestjs/common";
import { OutboxModule } from "../../../common/outbox/outbox.module";
import { AccountingModule } from "../../accounting/core/accounting.module";
import { InvoicesModule } from "../../invoices/invoices.module";
import { NotificationsModule } from "../../notifications/notifications.module";
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
import { ArPaymentsController } from "./ar-payments.controller";
import { ArPaymentsService } from "./ar-payments.service";
import { ReminderOutboxConsumer } from "./reminder-outbox.consumer";

@Module({
  imports: [AccountingModule, InvoicesModule, NotificationsModule, OutboxModule],
  controllers: [
    CreditNotesController,
    RecurringInvoicesController,
    RemindersController,
    StatementsController,
    CollectionsController,
    ArPaymentsController,
  ],
  providers: [
    CreditNotesService,
    RecurringInvoicesService,
    RemindersService,
    StatementsService,
    CollectionsService,
    ArPaymentsService,
    ReminderOutboxConsumer,
  ],
  exports: [RecurringInvoicesService, RemindersService],
})
export class FinanceArModule {}
