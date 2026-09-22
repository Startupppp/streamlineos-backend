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
