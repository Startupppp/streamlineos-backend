import { Module } from "@nestjs/common";
import { AccountingModule } from "../accounting/accounting.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { ExpensesModule } from "../expenses/expenses.module";
import { ReceiptsController } from "./receipts.controller";
import { ReimbursementsController } from "./reimbursements.controller";
import { ExpensePoliciesController } from "./expense-policies.controller";
import { ReceiptsService } from "./receipts.service";
import { ReimbursementsService } from "./reimbursements.service";
import { ExpensePoliciesService } from "./expense-policies.service";

@Module({
  imports: [AccountingModule, NotificationsModule, ExpensesModule],
  controllers: [ReceiptsController, ReimbursementsController, ExpensePoliciesController],
  providers: [ReceiptsService, ReimbursementsService, ExpensePoliciesService],
})
export class FinanceExpensesModule {}
