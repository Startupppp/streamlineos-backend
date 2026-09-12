import type { PayrollAckPayload, PayrollHandoffPayload } from "./handoff.schemas";

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

  /**
   * Called once per acknowledgement, from the outbox consumer, on the same
   * terms as `deliver`.
   *
   * Required rather than optional on purpose. An acknowledgement is how an
   * export stops being in flight, and a REJECTED or FAILED status is how an
   * organisation learns its payroll data did not land. An implementer who has
   * not thought about that should fail to compile rather than silently
   * discard it — the same reason the CRM ingress seam takes a required tenant
   * runner.
   *
   * An export can be acknowledged more than once as its status moves, so this
   * is not once-per-export; `payload.idempotencyKey` is stable per
   * acknowledgement, not per export.
   */
  acknowledged(payload: PayrollAckPayload): Promise<void>;
}

export const TIMESHEET_PAYROLL_HANDOFF_PORT = Symbol("TimesheetPayrollHandoffPort");

/**
 * Optional binding payroll registers globally. Timesheets falls back to the
 * recording adapter when this token is absent, so the module still boots in
 * isolation and the dependency still points payroll → timesheets.
 */
export const PAYROLL_TIMESHEET_HANDOFF_ADAPTER = Symbol("PayrollTimesheetHandoffAdapter");
