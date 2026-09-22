import { Injectable, Logger } from "@nestjs/common";
import type { TimesheetPayrollHandoffPort } from "./handoff.port";
import {
  payrollAckPayloadSchema,
  payrollHandoffPayloadSchema,
  type PayrollAckPayload,
  type PayrollHandoffPayload,
} from "./handoff.schemas";

@Injectable()
export class RecordingPayrollHandoffAdapter implements TimesheetPayrollHandoffPort {
  private readonly logger = new Logger(RecordingPayrollHandoffAdapter.name);

  async deliver(payload: PayrollHandoffPayload): Promise<void> {
    const parsed = payrollHandoffPayloadSchema.parse(payload);

    this.logger.log(
      `payroll handoff not delivered: no TimesheetPayrollHandoffPort implementation is bound. ` +
        `export=${parsed.exportId} org=${parsed.organizationId} ` +
        `window=${parsed.periodStart}..${parsed.periodEnd} ` +
        `workers=${parsed.rows.length} hours=${parsed.totalHours} ` +
        `idempotencyKey=${parsed.idempotencyKey}`,
    );
  }

  async acknowledged(payload: PayrollAckPayload): Promise<void> {
    const parsed = payrollAckPayloadSchema.parse(payload);
    const line =
      `payroll export ${parsed.exportId} acknowledged ${parsed.status} ` +
      `by ${parsed.ackBy} at ${parsed.ackAt}` +
      (parsed.note ? ` — ${parsed.note}` : "");

    if (parsed.status === "REJECTED" || parsed.status === "FAILED") this.logger.warn(line);
    else this.logger.log(line);
  }
}
