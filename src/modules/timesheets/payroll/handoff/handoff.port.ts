import type { PayrollHandoffPayload } from "./handoff.schemas";

/**
 * The seam payroll may implement, and which timesheets calls.
 *
 * Nothing in this directory may import from `modules/payroll`; the dependency
 * points the other way or not at all. `check:timesheets-payroll-boundary`
 * enforces that, because an import added here would compile fine and quietly
 * couple two modules with different owners.
 */
export interface TimesheetPayrollHandoffPort {
  /**
   * Called once per export, from the outbox consumer, inside the exporting
   * organisation's tenant transaction.
   *
   * Implementations must be idempotent on `payload.idempotencyKey`: the
   * publisher retries on a lease expiry or a thrown error, so a handoff can
   * legitimately be attempted more than once for one export.
   *
   * Throwing is meaningful — it sends the event back through the publisher's
   * retry and dead-letter path. An implementation that cannot deliver should
   * throw rather than return, so the failure is visible in the outbox rather
   * than lost.
   */
  deliver(payload: PayrollHandoffPayload): Promise<void>;
}

export const TIMESHEET_PAYROLL_HANDOFF_PORT = Symbol("TimesheetPayrollHandoffPort");
