import { Module } from "@nestjs/common";
import { AccountingModule } from "../../accounting/core/accounting.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { TaxCodesController } from "./tax-codes.controller";
import { TaxDashboardController } from "./tax-dashboard.controller";
import { TaxReportsController } from "./tax-reports.controller";
import { TaxPaymentsController } from "./tax-payments.controller";
import { TaxAdjustmentsController } from "./tax-adjustments.controller";
import { TaxCodesService } from "./tax-codes.service";
import { TaxDashboardService } from "./tax-dashboard.service";
import { TaxReportsService } from "./tax-reports.service";
import { TaxPaymentsService } from "./tax-payments.service";
import { TaxAdjustmentsService } from "./tax-adjustments.service";
import { TaxComplianceService } from "./tax-compliance.service";

@Module({
  imports: [AccountingModule, NotificationsModule],
  controllers: [
    TaxCodesController,
    TaxDashboardController,
    TaxReportsController,
    TaxPaymentsController,
    TaxAdjustmentsController,
  ],
  providers: [
    TaxCodesService,
    TaxDashboardService,
    TaxReportsService,
    TaxPaymentsService,
    TaxAdjustmentsService,
    TaxComplianceService,
  ],
  exports: [TaxComplianceService],
})
export class FinanceTaxModule {}
