import { randomUUID } from "node:crypto";
import { z } from "zod";
import { OutboxWriter } from "../../../../common/outbox/outbox-writer";
import { timesheetPeriodStatusSchema } from "../dto/status.schemas";
import type { DbOrTx } from "../../../../common/rbac/access-invalidate";

/**
 * The lifecycle a timesheet period announces, and the only place its event
 * names and payload shape are written down.
 *
 * Producer and consumer both import from here rather than repeating a string
 * literal. That is not tidiness: `OutboxPublisherService` throws on an event
 * type it has no registered consumer for, and the throw goes down the retry and
 * dead-letter path — so a producer and a consumer that disagree about a name by
 * one character dead-letter every event of that type, silently, in a background
 * sweep.
 */
export const TIMESHEET_PERIOD_AGGREGATE = "timesheet_period";

export const TIMESHEET_LIFECYCLE_EVENTS = {
  submitted: "timesheets.period.submitted",
  approved: "timesheets.period.approved",
  rejected: "timesheets.period.rejected",
  locked: "timesheets.period.locked",
} as const;

export type TimesheetLifecycleEventType =
  (typeof TIMESHEET_LIFECYCLE_EVENTS)[keyof typeof TIMESHEET_LIFECYCLE_EVENTS];

export const TIMESHEET_LIFECYCLE_EVENT_TYPES: readonly TimesheetLifecycleEventType[] =
  Object.values(TIMESHEET_LIFECYCLE_EVENTS);

/**
 * What rides in the outbox row.
 *
 * Snake_case because that is what every other event payload in this repository
 * uses, and an outbound webhook consumer reads these keys verbatim.
 *
 * Hours are strings, not numbers, because that is what the `decimal` columns
 * return. Converting here would either round or hand a consumer a float that
 * disagrees with the number the API serves for the same period.
 *
 * Deliberately *not* the entries. A period can hold hundreds, the outbox is a
 * durable replayable log, and a consumer that needs them has a period id and an
 * API. What belongs in an event is the fact that the transition happened.
 */
export const periodLifecycleEventSchema = z.object({
  organization_id: z.string().min(1),
  period_id: z.number().int().positive(),
  /** The person whose timesheet this is — not necessarily the actor. */
  user_id: z.string().min(1),
  period_start: z.string(),
  period_end: z.string(),
  status: timesheetPeriodStatusSchema,
  total_hours: z.string(),
  billable_hours: z.string(),
  non_billable_hours: z.string(),
  /** Whoever performed the transition: the worker on submit, the approver otherwise. */
  actor_user_id: z.string().min(1),
  /** A rejection reason, or null. Present on every event so the shape does not vary. */
  reason: z.string().nullable(),
  occurred_at: z.string(),
});

export type PeriodLifecycleEvent = z.infer<typeof periodLifecycleEventSchema>;

export interface EmitPeriodLifecycleInput {
  eventType: TimesheetLifecycleEventType;
  orgId: string;
  periodId: number;
  /**
   * The value of `timesheet_periods.event_seq` **after** the transition's own
   * UPDATE incremented it.
   *
   * It is a required argument rather than something this helper reads back,
   * because reading it separately would open a window in which another
   * transition claims the same number. The caller already has it from
   * `.returning({ eventSeq })` on the UPDATE it just ran.
   */
  eventSeq: number;
  payload: PeriodLifecycleEvent;
  occurredAt: Date;
}

/**
 * Writes one lifecycle event into the caller's transaction.
 *
 * `tx`, never `db`. The whole point of the outbox is that the event and the
 * state change it describes commit together: a period that is approved with no
 * approval event, or an approval event for a rollback, are both worse than
 * either failing.
 */
export async function emitPeriodLifecycleEvent(
  tx: DbOrTx,
  input: EmitPeriodLifecycleInput,
): Promise<void> {
  await OutboxWriter.emit(tx, toOutboxInput(input));
}

/**
 * Writes a batch transition's lifecycle events into the caller's transaction
 * as one multi-row INSERT (chunked by `OutboxWriter.emitMany`).
 *
 * Only the round trip is shared. Each event is still its own row, for its own
 * period, on the `aggregate_version` its own UPDATE claimed — a bulk approval
 * is N separate things that happened to N separate people, and the payroll
 * handoff waits on each period's own `timesheets.period.locked`.
 */
export async function emitPeriodLifecycleEvents(
  tx: DbOrTx,
  inputs: readonly EmitPeriodLifecycleInput[],
): Promise<void> {
  await OutboxWriter.emitMany(tx, inputs.map(toOutboxInput));
}

function toOutboxInput(input: EmitPeriodLifecycleInput) {
  return {
    eventId: randomUUID(),
    organizationId: input.orgId,
    aggregateType: TIMESHEET_PERIOD_AGGREGATE,
    aggregateId: String(input.periodId),
    aggregateVersion: input.eventSeq,
    eventType: input.eventType,
    payload: periodLifecycleEventSchema.parse(input.payload),
    occurredAt: input.occurredAt,
  };
}
