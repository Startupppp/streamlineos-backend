import type { PayrollAckPayload, PayrollHandoffPayload } from "./handoff.schemas";

export interface TimesheetPayrollHandoffPort {
  deliver(payload: PayrollHandoffPayload): Promise<void>;

  acknowledged(payload: PayrollAckPayload): Promise<void>;
}

export const TIMESHEET_PAYROLL_HANDOFF_PORT = Symbol("TimesheetPayrollHandoffPort");

export const PAYROLL_TIMESHEET_HANDOFF_ADAPTER = Symbol("PayrollTimesheetHandoffAdapter");
