import { Module } from "@nestjs/common";
import { AutomationModule } from "../automation/automation.module";
import { ExpensesController } from "./expenses.controller";
import { ExpenseCategoriesController } from "./expense-categories.controller";
import { ExpensesImportController } from "./expenses-import.controller";
import { ExpensesService } from "./expenses.service";
import { ExpensesWriteService } from "./expenses-write.service";
import { ExpensesImportService } from "./expenses-import.service";
import { TravelController } from "./travel.controller";
import { TravelService } from "./travel.service";

@Module({
  imports: [AutomationModule],
  controllers: [ExpensesController, ExpenseCategoriesController, ExpensesImportController, TravelController],
  providers: [ExpensesService, ExpensesWriteService, ExpensesImportService, TravelService],
})
export class ExpensesModule {}
