import { outboxEventInputSchema, type OutboxEventInput } from "./outbox-event-schema";
import { type outboxEvents } from "../../db/schema/outbox";

export type NewOutboxEvent = typeof outboxEvents.$inferInsert;

export const OUTBOX_RETRY_BASE_MS = 1_000;
export const OUTBOX_RETRY_MAX_MS = 60_000;
export const OUTBOX_MAX_RETRIES = 8;

const SUPPRESSED_LIFECYCLE_STATES: ReadonlySet<string> = new Set([
  "ARCHIVED",
  "PURGE_SCHEDULED",
  "PURGED",
]);

export function buildOutboxEvent(input: OutboxEventInput): NewOutboxEvent {
  const parsed = outboxEventInputSchema.parse(input);
  return {
    eventId: parsed.eventId,
    organizationId: parsed.organizationId,
    aggregateType: parsed.aggregateType,
    aggregateId: parsed.aggregateId,
    aggregateVersion: parsed.aggregateVersion,
    schemaVersion: parsed.schemaVersion,
    eventType: parsed.eventType,
    payload: parsed.payload,
    occurredAt: parsed.occurredAt,
    audience: parsed.audience,
    actorMembershipId: parsed.actorMembershipId,
    causationId: parsed.causationId,
    correlationId: parsed.correlationId,
    deliveryState: "PENDING",
    lifecycleState: "ACTIVE",
    retryCount: 0,
  };
}

export function nextRetryDelayMs(retryCount: number): number {
  if (retryCount <= 0) return OUTBOX_RETRY_BASE_MS;
  const delay = OUTBOX_RETRY_BASE_MS * 2 ** retryCount;
  return Math.min(delay, OUTBOX_RETRY_MAX_MS);
}

export function shouldDeadLetter(retryCount: number): boolean {
  return retryCount >= OUTBOX_MAX_RETRIES;
}

export function shouldSuppressForLifecycle(organizationStatus: string): boolean {
  return SUPPRESSED_LIFECYCLE_STATES.has(organizationStatus);
}
