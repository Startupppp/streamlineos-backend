import { Module } from "@nestjs/common";
import { AutomationModule } from "../automation/automation.module";
import { AccountingModule } from "../accounting/core/accounting.module";
import { EmploymentFactsModule } from "../directory/employment-facts.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { OutboxModule } from "../../common/outbox/outbox.module";
import {
  ExpenseDecidedConsumer,
  ExpenseExportRequestedConsumer,
  ExpenseSubmittedConsumer,
} from "./expense-outbox.consumer";
import { ExpensesController } from "./expenses.controller";
import { ExpenseCategoriesController } from "./expense-categories.controller";
import { ExpensesImportController } from "./expenses-import.controller";
import { ExpensesService } from "./expenses.service";
import { ExpensesWriteService } from "./expenses-write.service";
import { ExpensesImportService } from "./expenses-import.service";
import { ExpenseLifecycleService } from "./expense-lifecycle.service";
import { TravelController } from "./travel.controller";
import { TravelService } from "./travel.service";
import { EmployeeExpensesController } from "./employee-expenses.controller";
import { ExpenseExportService } from "./expense-export.service";
import { ExpenseExportWorkerService } from "./expense-export-worker.service";

@Module({
  imports: [AutomationModule, AccountingModule, NotificationsModule, OutboxModule, EmploymentFactsModule],
  controllers: [EmployeeExpensesController, ExpensesController, ExpenseCategoriesController, ExpensesImportController, TravelController],
  providers: [
    ExpensesService,
    ExpensesWriteService,
    ExpensesImportService,
    ExpenseLifecycleService,
    TravelService,
    ExpenseSubmittedConsumer,
    ExpenseDecidedConsumer,
    ExpenseExportRequestedConsumer,
    ExpenseExportService,
    ExpenseExportWorkerService,
  ],
  exports: [ExpensesService, ExpenseLifecycleService],
})
export class ExpensesModule {}
