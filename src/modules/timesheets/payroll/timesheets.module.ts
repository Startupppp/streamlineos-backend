import { Module } from "@nestjs/common";
import { PayrollController } from "./payroll.controller";
import { PayrollSummaryService } from "./payroll-summary.service";
import { PayrollExportService } from "./payroll-export.service";
import { PayrollSettingsService } from "./payroll-settings.service";
import { TimesheetsPayrollHandoffModule } from "./handoff/timesheets-payroll-handoff.module";

@Module({
  imports: [TimesheetsPayrollHandoffModule],
  controllers: [PayrollController],
  providers: [PayrollSummaryService, PayrollExportService, PayrollSettingsService],
})
export class TimesheetsModule {}
