import { Module } from "@nestjs/common";
import { AccountingModule } from "../../accounting/core/accounting.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { FinanceControlsModule } from "../controls/finance-controls.module";
import { OutboxModule } from "../../../common/outbox/outbox.module";
import { AccountingBillApprovedConsumerService } from "./accounting-bill-approved-consumer.service";
import { AccountingBillPaidConsumerService } from "./accounting-bill-paid-consumer.service";
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
import { PaymentRunExecutorService } from "./payment-run-executor.service";
import { VendorPaymentsAllocationsService } from "./vendor-payments-allocations.service";
import { VendorPaymentsListService } from "./vendor-payments-list.service";
import { BillsDueCheckService } from "./bills-due-check.service";

@Module({
  imports: [AccountingModule, NotificationsModule, FinanceControlsModule, OutboxModule],
  controllers: [
    BillsWorkflowController,
    VendorCreditsController,
    RecurringBillsController,
    PaymentRunsController,
    VendorPaymentsAllocationsController,
    VendorPaymentsListController,
  ],
  providers: [
    AccountingBillApprovedConsumerService,
    AccountingBillPaidConsumerService,
    BillsWorkflowService,
    VendorCreditsService,
    RecurringBillsService,
    PaymentRunsService,
    PaymentRunExecutorService,
    VendorPaymentsAllocationsService,
    VendorPaymentsListService,
    BillsDueCheckService,
  ],
  exports: [RecurringBillsService, BillsDueCheckService],
})
export class FinanceApModule {}
