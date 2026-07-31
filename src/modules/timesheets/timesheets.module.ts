import { Module } from "@nestjs/common";
import { TimesheetsCoreModule } from "./core/timesheets-core.module";
import { TimesheetsModule } from "./payroll/timesheets.module";

const TIMESHEETS_MODULES = [TimesheetsCoreModule, TimesheetsModule];

@Module({
  imports: TIMESHEETS_MODULES,
  exports: TIMESHEETS_MODULES,
})
export class TimesheetsRootModule {}
