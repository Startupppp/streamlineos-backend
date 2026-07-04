import { Module } from "@nestjs/common";
import { PayrollInsightsModule } from "../insights/payroll-insights.module";
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

@Module({
  imports: [PayrollInsightsModule],
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
  ],
})
export class PayrollPayoutModule {}
