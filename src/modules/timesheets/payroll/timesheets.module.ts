import { Module } from "@nestjs/common";
import { PayrollController } from "./payroll.controller";
import { PayrollSummaryService } from "./payroll-summary.service";
import { PayrollExportService } from "./payroll-export.service";
import { PayrollExportsReadService } from "./payroll-exports-read.service";
import { PayrollSettingsService } from "./payroll-settings.service";

@Module({
  controllers: [PayrollController],
  providers: [PayrollSummaryService, PayrollExportsReadService, PayrollExportService, PayrollSettingsService],
})
export class TimesheetsModule {}
