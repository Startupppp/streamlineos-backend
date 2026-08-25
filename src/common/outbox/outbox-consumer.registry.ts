import { Injectable } from "@nestjs/common";
import { outboxEvents } from "../../db/schema";

export type OutboxEventRow = typeof outboxEvents.$inferSelect;

/**
 * Stable key for an effect that may be attempted again after a worker lease expires. Keep the
 * producer event and consumer in the key so two consumers can legitimately act on one event while
 * every retry of one consumer maps to the same downstream idempotency key.
 */
export function outboxEffectIdempotencyKey(
  event: Pick<OutboxEventRow, "organizationId" | "eventId">,
  consumerName: string,
): string {
  return `outbox:${event.organizationId}:${consumerName}:${event.eventId}`;
}

export interface OutboxEventConsumer {
  readonly eventType: string;
  handle(event: OutboxEventRow): Promise<void>;
}

@Injectable()
export class OutboxConsumerRegistry {
  private readonly consumers = new Map<string, OutboxEventConsumer>();

  register(consumer: OutboxEventConsumer): void {
    this.consumers.set(consumer.eventType, consumer);
  }

  get(eventType: string): OutboxEventConsumer | undefined {
    return this.consumers.get(eventType);
  }
}
