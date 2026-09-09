import { Module } from "@nestjs/common";
import { OutboxModule } from "../../../../common/outbox/outbox.module";
import { PayrollHandoffConsumer } from "./payroll-handoff.consumer";
import { PayrollAckConsumer } from "./payroll-ack.consumer";
import { RecordingPayrollHandoffAdapter } from "./recording-handoff.adapter";
import { TIMESHEET_PAYROLL_HANDOFF_PORT } from "./handoff.port";

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
    { provide: TIMESHEET_PAYROLL_HANDOFF_PORT, useClass: RecordingPayrollHandoffAdapter },
  ],
  exports: [TIMESHEET_PAYROLL_HANDOFF_PORT],
})
export class TimesheetsPayrollHandoffModule {}
