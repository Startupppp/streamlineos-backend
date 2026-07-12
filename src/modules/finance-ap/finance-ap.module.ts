import { Module } from "@nestjs/common";
import { AccountingModule } from "../accounting/accounting.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { FinanceControlsModule } from "../finance-controls/finance-controls.module";
import { BillsWorkflowController } from "./bills-workflow.controller";
import { VendorCreditsController } from "./vendor-credits.controller";
import { RecurringBillsController } from "./recurring-bills.controller";
import { PaymentRunsController } from "./payment-runs.controller";
import { VendorPaymentsAllocationsController } from "./vendor-payments-allocations.controller";
import { VendorPaymentsListController } from "./vendor-payments-list.controller";
import { BillsWorkflowService } from "./bills-workflow.service";
import { VendorCreditsService } from "./vendor-credits.service";
import { RecurringBillsService } from "./recurring-bills.service";
import { PaymentRunsService } from "./payment-runs.service";
import { VendorPaymentsAllocationsService } from "./vendor-payments-allocations.service";
import { VendorPaymentsListService } from "./vendor-payments-list.service";
import { BillsDueCheckService } from "./bills-due-check.service";

@Module({
  imports: [AccountingModule, NotificationsModule, FinanceControlsModule],
  controllers: [
    BillsWorkflowController,
    VendorCreditsController,
    RecurringBillsController,
    PaymentRunsController,
    VendorPaymentsAllocationsController,
    VendorPaymentsListController,
  ],
  providers: [
    BillsWorkflowService,
    VendorCreditsService,
    RecurringBillsService,
    PaymentRunsService,
    VendorPaymentsAllocationsService,
    VendorPaymentsListService,
    BillsDueCheckService,
  ],
  exports: [RecurringBillsService, BillsDueCheckService],
})
export class FinanceApModule {}
