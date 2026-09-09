import { Injectable, Logger } from "@nestjs/common";
import type { TimesheetPayrollHandoffPort } from "./handoff.port";
import {
  payrollAckPayloadSchema,
  payrollHandoffPayloadSchema,
  type PayrollAckPayload,
  type PayrollHandoffPayload,
} from "./handoff.schemas";

/**
 * The adapter that ships when no payroll implementation is bound.
 *
 * It is deliberately not called a no-op, because it is not one and must not
 * behave like one. A silent no-op would make the whole seam untestable and
 * would report a successful handoff to an operator reading the outbox, for an
 * export that reached nothing. This adapter instead does the two things that
 * are honestly available without a downstream system:
 *
 *   1. validates the payload against the published contract, so a producer
 *      change that breaks the contract fails here and now rather than on the
 *      day payroll first implements the port;
 *   2. says plainly, in the log and once per export, that nothing consumed it.
 *
 * It returns rather than throws on purpose. Not having a payroll
 * implementation is the expected state of this branch, and throwing would
 * dead-letter every export for a condition that is not an error.
 */
@Injectable()
export class RecordingPayrollHandoffAdapter implements TimesheetPayrollHandoffPort {
  private readonly logger = new Logger(RecordingPayrollHandoffAdapter.name);

  async deliver(payload: PayrollHandoffPayload): Promise<void> {
    /**
     * Parsed, not trusted. The payload is built in this repository, so a
     * failure here is a contract regression rather than bad input — which is
     * exactly the thing worth failing on.
     */
    const parsed = payrollHandoffPayloadSchema.parse(payload);

    this.logger.log(
      `payroll handoff not delivered: no TimesheetPayrollHandoffPort implementation is bound. ` +
        `export=${parsed.exportId} org=${parsed.organizationId} ` +
        `window=${parsed.periodStart}..${parsed.periodEnd} ` +
        `workers=${parsed.rows.length} hours=${parsed.totalHours} ` +
        `idempotencyKey=${parsed.idempotencyKey}`,
    );
  }

  /**
   * Logged at `warn` when the payroll system says the data did not land, and
   * at `log` otherwise. With no implementation bound there is nothing to
   * reconcile against, so the honest thing is to make a rejection loud rather
   * than record it at the same volume as a success.
   */
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
