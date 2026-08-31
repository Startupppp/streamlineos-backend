import { Module } from "@nestjs/common";
import { AccountingModule } from "../../accounting/core/accounting.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { ExpensesModule } from "../../expenses/expenses.module";
import { ReceiptsController } from "./receipts.controller";
import { FinanceReimbursementsController } from "./reimbursements.controller";
import { ExpensePoliciesController } from "./expense-policies.controller";
import { CategorizeSuggestController } from "./categorize-suggest.controller";
import { ReceiptsService } from "./receipts.service";
import { ReimbursementsService } from "./reimbursements.service";
import { ExpensePoliciesService } from "./expense-policies.service";
import { CategorizeSuggestService } from "./categorize-suggest.service";

@Module({
  imports: [AccountingModule, NotificationsModule, ExpensesModule],
  controllers: [ReceiptsController, FinanceReimbursementsController, ExpensePoliciesController, CategorizeSuggestController],
  providers: [ReceiptsService, ReimbursementsService, ExpensePoliciesService, CategorizeSuggestService],
})
export class FinanceExpensesModule {}
