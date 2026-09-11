import { z } from "zod";
import { payrollMappingSchema } from "../dto/payroll.schemas";

/**
 * The contract timesheets offers payroll, owned by timesheets.
 *
 * The direction matters: payroll is a separate module with a separate owner,
 * and this package must never import from it. So this file is not a
 * description of what payroll wants — it is a description of what timesheets
 * is willing to promise, which payroll may implement against when it chooses
 * to. Everything here is derived from data timesheets already holds.
 */

/**
 * One worker's hours for the exported window.
 *
 * Hours, never money. The payroll export computes buckets and leave days; it
 * does not price them, and the pay code is a mapping label rather than a rate.
 * That is why there is no amount field to be wrong about.
 */
export const handoffWorkerRowSchema = z.object({
  userId: z.string().min(1),
  employeeName: z.string(),
  employeeEmail: z.string(),
  regularHours: z.number(),
  overtimeHours: z.number(),
  holidayHours: z.number(),
  weekendHours: z.number(),
  leaveDays: z.number(),
  billableHours: z.number(),
  nonBillableHours: z.number(),
  totalPayableHours: z.number(),
  entryCount: z.number().int().nonnegative(),
});

export const payrollHandoffPayloadSchema = z.object({
  organizationId: z.string().min(1),
  exportId: z.number().int().positive(),
  periodStart: z.string(),
  periodEnd: z.string(),
  /**
   * Hours-only handoffs carry no currency. The field exists so that a later
   * costed handoff has somewhere to put one rather than inventing a second
   * payload shape, and it is null today because nothing here is priced.
   * Reading a null as "the org's default" would be exactly the silent mixed
   * currency the PRD forbids.
   */
  currency: z.string().length(3).nullable(),
  entryCount: z.number().int().nonnegative(),
  totalHours: z.number(),
  /**
   * The org's payroll column mapping, echoed so a downstream system routes
   * hours without re-deriving it (TS-19).
   *
   * The ticket line asks for "pay codes" per worker. There are none to give:
   * `payrollMappingSchema` is `{ provider, columns[] }` — an organisation-level
   * mapping of bucket to column label, with no per-worker dimension anywhere
   * in the schema. A `payCode` field on each row could only have been the same
   * value repeated, or invented, so the mapping stays where it actually
   * lives — once, at the top.
   *
   * Typed, and never null. It was `z.unknown()`, which meant an implementer
   * had no contract to write against and `undefined` satisfied the schema — so
   * "the payload carries the mapping" was true only when the export happened
   * to have stored one. The consumer now runs the stored value through
   * `resolveMapping`, which answers `DEFAULT_PAYROLL_MAPPING` for an export
   * written before mappings existed, so every handoff carries a mapping that
   * says which provider and which columns, and an adapter can rely on it.
   */
  mapping: payrollMappingSchema,
  rows: z.array(handoffWorkerRowSchema),
  /**
   * Stable across every retry of one consumer for one export, so an adapter
   * that reaches an external payroll system can dedupe on it.
   */
  idempotencyKey: z.string().min(1),
  /** Where an implementer records that it took delivery. Relative to the API root. */
  ackPath: z.string().min(1),
  exportedAt: z.string(),
});

export type PayrollHandoffPayload = z.infer<typeof payrollHandoffPayloadSchema>;
export type HandoffWorkerRow = z.infer<typeof handoffWorkerRowSchema>;

/**
 * What rides in the outbox row, as opposed to what reaches the port.
 *
 * Deliberately not the worker rows. The pack's ticket line asks for them in
 * the event payload, and putting them there would be worse in two ways: the
 * outbox is a durable, replayable log, so every worker's name and email would
 * be duplicated into it for every export and kept for as long as the log is;
 * and the payload would grow without bound with headcount. The snapshot is
 * already stored on `timesheet_exports`, so the event carries the identifier
 * and the consumer loads the rows to build the full payload above. The port
 * still receives everything the ticket asks for.
 */
export const payrollExportReadyEventSchema = z.object({
  organization_id: z.string().min(1),
  export_id: z.number().int().positive(),
  period_start: z.string(),
  period_end: z.string(),
  entry_count: z.number().int().nonnegative(),
  worker_count: z.number().int().nonnegative(),
  total_hours: z.string(),
  format: z.string(),
  actor_user_id: z.string().min(1),
});

export type PayrollExportReadyEvent = z.infer<typeof payrollExportReadyEventSchema>;

/**
 * What an acknowledgement carries.
 *
 * The status is the point: an implementer that answers REJECTED or FAILED is
 * telling the organisation its payroll data did not land, and that has to be
 * distinguishable from silence. `ackAt` and `ackBy` say when and by whom.
 */
export const payrollAckPayloadSchema = z.object({
  organizationId: z.string().min(1),
  exportId: z.number().int().positive(),
  status: z.enum(["RECEIVED", "ACCEPTED", "REJECTED", "FAILED"]),
  note: z.string().nullable(),
  ackAt: z.string(),
  ackBy: z.string().min(1),
  idempotencyKey: z.string().min(1),
});

export type PayrollAckPayload = z.infer<typeof payrollAckPayloadSchema>;

export const payrollExportAckedEventSchema = z.object({
  organization_id: z.string().min(1),
  export_id: z.number().int().positive(),
  status: z.enum(["RECEIVED", "ACCEPTED", "REJECTED", "FAILED"]),
  note: z.string().nullable(),
  acked_at: z.string(),
  actor_user_id: z.string().min(1),
});

export type PayrollExportAckedEvent = z.infer<typeof payrollExportAckedEventSchema>;

/** Event names, in one place so a producer and a consumer cannot disagree. */
export const TIMESHEET_EVENTS = {
  payrollExportReady: "timesheets.payroll.export.ready",
  payrollExportAcked: "timesheets.payroll.export.acked",
} as const;
