import { Module } from "@nestjs/common";
import { AutomationModule } from "../automation/automation.module";
import { AccountingModule } from "../accounting/core/accounting.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { ExpensesController } from "./expenses.controller";
import { ExpenseCategoriesController } from "./expense-categories.controller";
import { ExpensesImportController } from "./expenses-import.controller";
import { ExpensesService } from "./expenses.service";
import { ExpensesWriteService } from "./expenses-write.service";
import { ExpensesImportService } from "./expenses-import.service";
import { ExpenseLifecycleService } from "./expense-lifecycle.service";
import { TravelController } from "./travel.controller";
import { TravelService } from "./travel.service";

@Module({
  imports: [AutomationModule, AccountingModule, NotificationsModule],
  controllers: [ExpensesController, ExpenseCategoriesController, ExpensesImportController, TravelController],
  providers: [ExpensesService, ExpensesWriteService, ExpensesImportService, ExpenseLifecycleService, TravelService],
  exports: [ExpensesService, ExpenseLifecycleService],
})
export class ExpensesModule {}
