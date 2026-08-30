import { Module } from "@nestjs/common";
import { NotificationsModule } from "../../notifications/notifications.module";
import { PayrollInsightsModule } from "../insights/payroll-insights.module";
import { PayrollRunsModule } from "../runs/payroll-runs.module";
import { DirectoryModule } from "../../directory/directory.module";
import { AccountingAdaptersModule } from "../../accounting/adapters/accounting-adapters.module";
import { AccountingKernelModule } from "../../accounting/kernel/accounting-kernel.module";
import { ApprovalsController } from "./approvals.controller";
import { ApprovalsService } from "./approvals.service";
import { LockingController } from "./locking.controller";
import { LockingService } from "./locking.service";
import {
  PayoutBatchesController,
  PayoutEmployeeBankController,
  PayoutRunController,
} from "./payout-batches.controller";
import { PayoutBatchesService } from "./payout-batches.service";
import { PayoutValidationService } from "./payout-validation.service";
import { PayslipTemplatesController } from "./payslip-templates.controller";
import { PayslipTemplatesService } from "./payslip-templates.service";
import { PublishingController } from "./publishing.controller";
import { PublishingService } from "./publishing.service";
import { PayrollPostingService } from "../payroll-posting.service";

@Module({
  imports: [
    NotificationsModule,
    PayrollInsightsModule,
    PayrollRunsModule,
    DirectoryModule,
    AccountingAdaptersModule,
    AccountingKernelModule,
  ],
  controllers: [
    ApprovalsController,
    LockingController,
    PayoutRunController,
    PayoutBatchesController,
    PayoutEmployeeBankController,
    PayslipTemplatesController,
    PublishingController,
  ],
  providers: [
    ApprovalsService,
    LockingService,
    PayoutBatchesService,
    PayoutValidationService,
    PayslipTemplatesService,
    PublishingService,
    PayrollPostingService,
  ],
  exports: [PublishingService, LockingService, PayoutBatchesService],
})
export class PayrollPayoutModule {}
