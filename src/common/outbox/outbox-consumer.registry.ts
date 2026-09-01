import { Injectable, Logger } from "@nestjs/common";
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

/**
 * Which consumers run for an event type.
 *
 * ## Why this is a list and not a single entry
 *
 * It was a `Map<string, OutboxEventConsumer>` and `register` overwrote. Two
 * consumers legitimately want `inventory.stock.low` — `InvStockLowConsumerService`
 * notifies the buyer, and `InventoryOutboxConsumer` enqueues the customer's
 * webhook — and both call `register` in their own `onModuleInit`. Whichever Nest
 * initialised second silently replaced the first, so exactly one of "the buyer
 * is told" and "the subscriber's webhook fires" happened, decided by module
 * ordering, with nothing anywhere saying so. The idempotency key above already
 * anticipated this ("so two consumers can legitimately act on one event") — the
 * registry just did not honour it.
 *
 * Fan-out is sequential and **fails the event if any consumer throws**. The
 * publisher retries the whole event, so a consumer that already succeeded will
 * see it again — which is exactly what `InboxConsumer.claim` and the effect key
 * above exist to absorb. Running the survivors and swallowing the failure would
 * be the other shape of the same bug this replaces: a lost effect nobody sees.
 */
@Injectable()
export class OutboxConsumerRegistry {
  private readonly logger = new Logger(OutboxConsumerRegistry.name);
  private readonly consumers = new Map<string, OutboxEventConsumer[]>();

  register(consumer: OutboxEventConsumer): void {
    const existing = this.consumers.get(consumer.eventType);
    if (!existing) {
      this.consumers.set(consumer.eventType, [consumer]);
      return;
    }
    // Re-registering the same instance is a double `onModuleInit` (test module
    // rebuilds do this) and must stay a no-op rather than fan out twice.
    if (existing.includes(consumer)) return;
    existing.push(consumer);
    this.logger.debug(
      `${consumer.eventType} now has ${existing.length} consumers; all of them run for each event`,
    );
  }

  /** Every consumer for this type, in registration order. Empty when none. */
  getAll(eventType: string): readonly OutboxEventConsumer[] {
    return this.consumers.get(eventType) ?? [];
  }

  /**
   * The first consumer for this type, kept for callers that only need to know
   * whether the type is handled at all. Prefer `getAll` when dispatching.
   */
  get(eventType: string): OutboxEventConsumer | undefined {
    return this.consumers.get(eventType)?.[0];
  }
}
