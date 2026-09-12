import { Global, Module } from "@nestjs/common";
import { PAYROLL_TIMESHEET_HANDOFF_ADAPTER } from "../../timesheets/payroll/handoff/handoff.port";
import { PayrollTimesheetHandoffAdapter } from "./payroll-timesheet-handoff.adapter";

/**
 * Global so TimesheetsPayrollHandoffModule can optionally inject the adapter
 * without importing payroll — the dependency stays payroll → timesheets.
 */
@Global()
@Module({
  providers: [
    PayrollTimesheetHandoffAdapter,
    {
      provide: PAYROLL_TIMESHEET_HANDOFF_ADAPTER,
      useExisting: PayrollTimesheetHandoffAdapter,
    },
  ],
  exports: [PayrollTimesheetHandoffAdapter, PAYROLL_TIMESHEET_HANDOFF_ADAPTER],
})
export class PayrollTimesheetHandoffModule {}
