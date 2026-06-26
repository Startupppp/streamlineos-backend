import { Module } from "@nestjs/common";
import { ExpensesController } from "./expenses.controller";
import { ExpenseCategoriesController } from "./expense-categories.controller";
import { ExpensesImportController } from "./expenses-import.controller";
import { ExpensesService } from "./expenses.service";
import { ExpensesImportService } from "./expenses-import.service";

@Module({
  controllers: [ExpensesController, ExpenseCategoriesController, ExpensesImportController],
  providers: [ExpensesService, ExpensesImportService],
})
export class ExpensesModule {}
