import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import {
  OutboxConsumerRegistry,
  type OutboxEventRow,
} from "../../../common/outbox/outbox-consumer.registry";
import { InventoryWebhookEmitter } from "./webhook-emitter.service";
import type { WebhookEventType } from "./dto/webhooks.schemas";

/**
 * A5 — the missing half of the event contract.
 *
 * Inventory wrote domain events to the outbox and customers could register
 * webhooks for them, and the two had never been connected. `OutboxPublisher`
 * dispatches through `OutboxConsumerRegistry`, inventory registered no consumer
 * at all, and `InventoryWebhookEmitter.emit` — the thing that actually delivers
 * to a subscriber — was exported by its module and called from nowhere in the
 * codebase. So **every inventory webhook anyone has ever registered has never
 * fired**, and any inventory event the publisher did pick up threw "no dispatch
 * handler" and retried its way to DEAD.
 *
 * The two vocabularies had also drifted apart. What a customer may subscribe to
 * and what the system emits overlapped on exactly one name (`inventory.stock.low`):
 * eight subscribable events were never produced, and six produced events could
 * not be subscribed to. Rather than rename either side — a registered webhook
 * naming a type that stops existing is the silent death this unit is meant to
 * prevent — the map below translates between them.
 *
 * Every event type inventory emits must appear here, including the ones with no
 * subscriber-facing name, because an unregistered type is not ignored by the
 * publisher: it is an error, retried and dead-lettered. `null` means "delivered
 * nowhere, deliberately" and is acknowledged rather than failed.
 * `inventory-outbox-coverage.spec.ts` fails if an emitted type is missing here.
 */
export const INVENTORY_WEBHOOK_ROUTES: Readonly<Record<string, WebhookEventType | null>> = {
  // The engine's own movement event is the general "stock changed" signal, which
  // is the name subscribers already hold.
  "inventory.stock.movement.posted": "inventory.stock.changed",
  "inventory.stock.adjusted": "inventory.adjustment.posted",
  "inventory.stock.low": "inventory.stock.low",
  "inventory.purchase_order.received": "inventory.po.received",
  "inventory.sales_order.fulfilled": "inventory.so.shipped",
  // Deliberately not routed to `inventory.so.shipped` as well: a shipment
  // dispatch and its sales order's fulfilment are the same parcel, and mapping
  // both would deliver two webhooks for one event.
  "inventory.shipment.dispatched": null,
  "inventory.scan.captured": null,
  "inventory.sync.offline_batch_applied": null,

  /*
   * A5, item 3 — the events that belong to a command rather than to the engine.
   *
   * `inventory.transfer.completed` is one of the subscribable names nothing has
   * ever produced, and a completed transfer is exactly what it describes, so it
   * finally has a producer.
   *
   * The rest route nowhere on purpose. Giving a reservation, a quality hold, a
   * count or a return a subscriber-facing name means adding to `WEBHOOK_EVENTS`,
   * which changes what a customer may register for — a contract decision, not a
   * side effect of adding a producer. Routed explicitly rather than left out:
   * an unrouted type is not ignored by the publisher, it is retried and
   * dead-lettered, so "no subscriber yet" has to be written down.
   */
  "inventory.stock.transfer.completed": "inventory.transfer.completed",
  "inventory.reservation.created": null,
  "inventory.reservation.released": null,
  "inventory.reservation.consumed": null,
  "inventory.stock.transfer.reserved": null,
  "inventory.stock.transfer.dispatched": null,
  // Not routed to `inventory.po.received` as well: that name already carries
  // `inventory.purchase_order.received`, and mapping both would deliver two
  // webhooks for one delivery.
  "inventory.receiving.posted": null,
  "inventory.return.posted": null,
  "inventory.quality.hold.created": null,
  "inventory.quality.hold.released": null,
  "inventory.count.posted": null,
};

@Injectable()
export class InventoryOutboxConsumer implements OnModuleInit {
  private readonly logger = new Logger(InventoryOutboxConsumer.name);

  constructor(
    private readonly registry: OutboxConsumerRegistry,
    private readonly emitter: InventoryWebhookEmitter,
  ) {}

  onModuleInit(): void {
    for (const [eventType, webhookType] of Object.entries(INVENTORY_WEBHOOK_ROUTES)) {
      this.registry.register({
        eventType,
        handle: (event: OutboxEventRow) => this.deliver(event, webhookType),
      });
    }
  }

  private async deliver(
    event: OutboxEventRow,
    webhookType: WebhookEventType | null,
  ): Promise<void> {
    if (webhookType === null) {
      this.logger.debug(
        `${event.eventType} has no subscriber-facing name; acknowledged without delivery`,
      );
      return;
    }

    const payload =
      typeof event.payload === "object" && event.payload !== null
        ? (event.payload as Record<string, unknown>)
        : {};

    await this.emitter.emit(event.organizationId, webhookType, {
      ...payload,
      // The producer's own name, so a subscriber can tell which command raised a
      // shared subscription type without guessing from the payload's shape.
      outboxEventType: event.eventType,
    });
  }
}
