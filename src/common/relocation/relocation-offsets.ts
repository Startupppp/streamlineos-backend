export type OutboxDeliveryState =
  | "PENDING"
  | "IN_FLIGHT"
  | "DELIVERED"
  | "DEAD"
  | "SUPPRESSED";

export interface SourceEvent {
  readonly outboxEventId: number;
  readonly eventId: string;
  readonly deliveryState: OutboxDeliveryState;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly occurredAt: Date;
}

export interface TargetInboxEntry {
  readonly producerEventId: string;
  readonly consumerName: string;
  readonly processedAt: Date | null;
  readonly status: string;
}

export interface IndeterminateEvent {
  readonly eventId: string;
  readonly outboxEventId: number;
  readonly reason: string;
}

export type OffsetReconciliationResult =
  | {
      readonly ok: true;
      readonly toReplay: readonly SourceEvent[];
      readonly delivered: readonly string[];
      readonly suppressed: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: "INDETERMINATE";
      readonly indeterminate: readonly IndeterminateEvent[];
    };

export function reconcileOffsets(
  sourceEvents: readonly SourceEvent[],
  targetInbox: readonly TargetInboxEntry[],
  orgId: string,
): OffsetReconciliationResult {
  if (!orgId) throw new Error("orgId is required for offset reconciliation");

  const deliveredIds = new Set(
    targetInbox
      .filter((e) => e.processedAt !== null && e.status === "COMPLETED")
      .map((e) => e.producerEventId),
  );

  const inFlightIds = new Set(
    targetInbox
      .filter((e) => e.processedAt === null && e.status !== "FAILED")
      .map((e) => e.producerEventId),
  );

  const toReplay: SourceEvent[] = [];
  const delivered: string[] = [];
  const suppressed: string[] = [];
  const indeterminate: IndeterminateEvent[] = [];

  for (const event of sourceEvents) {
    const classification = classifyEvent(event, deliveredIds, inFlightIds);

    switch (classification) {
      case "delivered":
        delivered.push(event.eventId);
        break;
      case "suppressed":
        suppressed.push(event.eventId);
        break;
      case "replay":
        toReplay.push(event);
        break;
      case "indeterminate":
        indeterminate.push({
          eventId: event.eventId,
          outboxEventId: event.outboxEventId,
          reason: indeterminateReason(event),
        });
        break;
    }
  }

  if (indeterminate.length > 0)
    return { ok: false, reason: "INDETERMINATE", indeterminate };

  return { ok: true, toReplay, delivered, suppressed };
}

type EventClassification = "delivered" | "suppressed" | "replay" | "indeterminate";

function classifyEvent(
  event: SourceEvent,
  deliveredIds: ReadonlySet<string>,
  inFlightIds: ReadonlySet<string>,
): EventClassification {
  if (deliveredIds.has(event.eventId)) return "delivered";

  switch (event.deliveryState) {
    case "DELIVERED":
      if (inFlightIds.has(event.eventId)) return "indeterminate";
      return "delivered";
    case "SUPPRESSED":
      return "suppressed";
    case "DEAD":
      return "replay";
    case "PENDING":
    case "IN_FLIGHT":
      if (inFlightIds.has(event.eventId)) return "indeterminate";
      return "replay";
    default: {
      const exhaustive: never = event.deliveryState;
      throw new Error(`Unhandled delivery state: ${String(exhaustive)}`);
    }
  }
}

function indeterminateReason(event: SourceEvent): string {
  return (
    `Event ${event.eventId} (outbox_event_id=${event.outboxEventId}) ` +
    `has delivery_state="${event.deliveryState}" on source but appears in-flight on target. ` +
    `Cannot prove delivered or undelivered within the consumer idempotency window.`
  );
}

export function maxSourceOffset(events: readonly SourceEvent[]): number {
  if (events.length === 0) return 0;
  return events.reduce((max, e) => Math.max(max, e.outboxEventId), 0);
}

export function pendingEventCount(events: readonly SourceEvent[]): number {
  return events.filter(
    (e) => e.deliveryState === "PENDING" || e.deliveryState === "IN_FLIGHT",
  ).length;
}
