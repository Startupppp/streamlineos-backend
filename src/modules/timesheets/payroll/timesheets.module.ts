import { Module } from "@nestjs/common";
import { PayrollController } from "./payroll.controller";
import { PayrollSummaryService } from "./payroll-summary.service";
import { PayrollExportService } from "./payroll-export.service";
import { PayrollSettingsService } from "./payroll-settings.service";

@Module({
  controllers: [PayrollController],
  providers: [PayrollSummaryService, PayrollExportService, PayrollSettingsService],
})
export class TimesheetsModule {}
