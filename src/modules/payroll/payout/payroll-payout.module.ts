import { Module } from "@nestjs/common";
import { PayrollInsightsModule } from "../insights/payroll-insights.module";
import { PayrollRunsModule } from "../runs/payroll-runs.module";
import { AccountingModule } from "../../accounting/core/accounting.module";
import { DirectoryModule } from "../../directory/directory.module";
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
import { BatchCreatorService } from "./batch-creator.service";
import { BatchStatusService } from "./batch-status.service";
import { PayoutValidationService } from "./payout-validation.service";
import { PayslipTemplatesController } from "./payslip-templates.controller";
import { PayslipTemplatesService } from "./payslip-templates.service";
import { PublishingController } from "./publishing.controller";
import { PublishingService } from "./publishing.service";
import { PayrollPostingService } from "../payroll-posting.service";
import { NotificationsModule } from "../../notifications/notifications.module";

@Module({
  imports: [NotificationsModule, PayrollInsightsModule, PayrollRunsModule, AccountingModule, DirectoryModule],
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
    BatchCreatorService,
    BatchStatusService,
    PayoutValidationService,
    PayslipTemplatesService,
    PublishingService,
    PayrollPostingService,
  ],
  exports: [PublishingService, LockingService, PayoutBatchesService],
})
export class PayrollPayoutModule {}
