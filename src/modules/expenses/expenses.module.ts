import { Module } from "@nestjs/common";
import { AutomationModule } from "../automation/automation.module";
import { AccountingAdaptersModule } from "../accounting/adapters/accounting-adapters.module";
import { EmploymentFactsModule } from "../directory/employment-facts.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { OutboxModule } from "../../common/outbox/outbox.module";
import { AttentionModule } from "../attention/attention.module";
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
import { ExpenseApprovalAdapter } from "./expense-approval.adapter";

/**
 * Employee expense claims and travel requests — HR self-service, not accounting.
 *
 * The only accounting dependency is the anti-corruption layer: approving a claim
 * posts an accrual through `PostingCommandService`. Importing
 * `AccountingAdaptersModule` rather than the accounting root keeps that arrow
 * pointing at the one seam accounting exposes to other modules.
 */
@Module({
  imports: [AutomationModule, AccountingAdaptersModule, NotificationsModule, OutboxModule, EmploymentFactsModule, AttentionModule],
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
    ExpenseApprovalAdapter,
  ],
  exports: [ExpensesService],
})
export class ExpensesModule {}
