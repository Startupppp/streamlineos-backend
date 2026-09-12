import { Module } from "@nestjs/common";
import { OutboxModule } from "../../../../common/outbox/outbox.module";
import { PayrollHandoffConsumer } from "./payroll-handoff.consumer";
import { PayrollAckConsumer } from "./payroll-ack.consumer";
import { RecordingPayrollHandoffAdapter } from "./recording-handoff.adapter";
import {
  PAYROLL_TIMESHEET_HANDOFF_ADAPTER,
  TIMESHEET_PAYROLL_HANDOFF_PORT,
  type TimesheetPayrollHandoffPort,
} from "./handoff.port";

/**
 * The handoff seam, bound to the adapter that ships when payroll has not
 * implemented the port.
 *
 * Replacing the binding is the whole extension point: an implementation
 * provides `TIMESHEET_PAYROLL_HANDOFF_PORT` and nothing else in timesheets
 * changes. Note which way the dependency runs — payroll may depend on this
 * contract; this module may not depend on payroll, and
 * `check:timesheets-payroll-boundary` fails if that reverses.
 */
@Module({
  imports: [OutboxModule],
  providers: [
    PayrollHandoffConsumer,
    PayrollAckConsumer,
    RecordingPayrollHandoffAdapter,
    {
      provide: TIMESHEET_PAYROLL_HANDOFF_PORT,
      useFactory: (
        payroll: TimesheetPayrollHandoffPort | undefined,
        recording: RecordingPayrollHandoffAdapter,
      ) => payroll ?? recording,
      inject: [
        { token: PAYROLL_TIMESHEET_HANDOFF_ADAPTER, optional: true },
        RecordingPayrollHandoffAdapter,
      ],
    },
  ],
  exports: [TIMESHEET_PAYROLL_HANDOFF_PORT],
})
export class TimesheetsPayrollHandoffModule {}
