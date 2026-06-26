import { Module } from "@nestjs/common";
import { ExpensesController } from "./expenses.controller";
import { ExpenseCategoriesController } from "./expense-categories.controller";
import { ExpensesService } from "./expenses.service";

@Module({
  controllers: [ExpensesController, ExpenseCategoriesController],
  providers: [ExpensesService],
})
export class ExpensesModule {}
