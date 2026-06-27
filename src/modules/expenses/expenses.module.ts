import { Module } from "@nestjs/common";
import { AutomationModule } from "../automation/automation.module";
import { ExpensesController } from "./expenses.controller";
import { ExpenseCategoriesController } from "./expense-categories.controller";
import { ExpensesImportController } from "./expenses-import.controller";
import { ExpensesService } from "./expenses.service";
import { ExpensesWriteService } from "./expenses-write.service";
import { ExpensesImportService } from "./expenses-import.service";

@Module({
  imports: [AutomationModule],
  controllers: [ExpensesController, ExpenseCategoriesController, ExpensesImportController],
  providers: [ExpensesService, ExpensesWriteService, ExpensesImportService],
})
export class ExpensesModule {}
