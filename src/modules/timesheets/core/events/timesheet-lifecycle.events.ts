import { randomUUID } from "node:crypto";
import { z } from "zod";
import { OutboxWriter } from "../../../../common/outbox/outbox-writer";
import { timesheetPeriodStatusSchema } from "../dto/status.schemas";
import type { DbOrTx } from "../../../../common/rbac/access-invalidate";

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

export const periodLifecycleEventSchema = z.object({
  organization_id: z.string().min(1),
  period_id: z.number().int().positive(),
  user_id: z.string().min(1),
  period_start: z.string(),
  period_end: z.string(),
  status: timesheetPeriodStatusSchema,
  total_hours: z.string(),
  billable_hours: z.string(),
  non_billable_hours: z.string(),
  actor_user_id: z.string().min(1),
  reason: z.string().nullable(),
  occurred_at: z.string(),
});

export type PeriodLifecycleEvent = z.infer<typeof periodLifecycleEventSchema>;

export interface EmitPeriodLifecycleInput {
  eventType: TimesheetLifecycleEventType;
  orgId: string;
  periodId: number;
  eventSeq: number;
  payload: PeriodLifecycleEvent;
  occurredAt: Date;
}

export async function emitPeriodLifecycleEvent(
  tx: DbOrTx,
  input: EmitPeriodLifecycleInput,
): Promise<void> {
  await OutboxWriter.emit(tx, toOutboxInput(input));
}

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
