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
  // G3's three notification triggers. Routed to null deliberately: each is a
  // real event with a real internal consumer (the notifier), and none has a
  // subscriber-facing name in `WEBHOOK_EVENTS`. Giving them one is a change to a
  // customer-facing contract, not a routing decision, so it is left to whoever
  // owns that contract — but they must appear here, because the publisher treats
  // an unregistered type as an error and retries it to DEAD rather than ignoring
  // it. That is what this table is for.
  "inventory.lot.expiring": null,
  "inventory.recall.opened": null,
  "inventory.adjustment.approval_requested": null,

  // E5's statutory events. Routed to null for the same reason as G3's: each is a
  // real event, and none has a subscriber-facing name in `WEBHOOK_EVENTS`.
  // Giving a customer a webhook that fires when an IRN is issued is a contract
  // decision, and one that must not be made while the only adapter is a stub —
  // a subscriber cannot tell a rehearsal from a filing by the event alone.
  "inventory.einvoice.registered": null,
  "inventory.einvoice.cancelled": null,
  "inventory.ewaybill.generated": null,

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
  // B3. These six had producers and nowhere to go. `WEBHOOK_EVENTS` now
  // carries a name for each, so the routing that said "deliberately nowhere"
  // has become a route. `inventory.stock.transfer.reserved` stays null: a
  // transfer holding its own source stock is an internal step of a transfer a
  // subscriber already hears about at creation and dispatch, and announcing it
  // separately delivers three webhooks for one movement of goods.
  "inventory.reservation.created": "inventory.stock.reserved",
  "inventory.reservation.released": "inventory.stock.released",
  "inventory.reservation.consumed": "inventory.reservation.fulfilled",
  "inventory.stock.transfer.reserved": null,
  "inventory.stock.transfer.dispatched": "inventory.transfer.dispatched",
  // Its own name rather than `inventory.po.received`: that one already carries
  // `inventory.purchase_order.received` (the order is closed), and this is the
  // physical receipt of goods into a bin. Mapping both to one name would deliver
  // two identical webhooks for one delivery and lose the distinction.
  "inventory.receiving.posted": "inventory.stock.received",
  "inventory.return.posted": "inventory.return.received",
  "inventory.quality.hold.created": "inventory.quality.hold.created",
  "inventory.quality.hold.released": "inventory.quality.hold.released",
  "inventory.count.posted": "inventory.count.posted",
  "inventory.pick.completed": "inventory.picklist.completed",
  // B3. On-hand reaching zero, emitted beside `inventory.stock.low` by the
  // costing service. A separate name because the two are different jobs: low
  // is "start buying", out is "we are refusing orders now".
  "inventory.stock.out": "inventory.stock.out",
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

    await this.emitter.emit(
      event.organizationId,
      webhookType,
      {
        ...payload,
        // The producer's own name, so a subscriber can tell which command raised a
        // shared subscription type without guessing from the payload's shape.
        outboxEventType: event.eventType,
      },
      // E7. Dispatch is at-least-once: `OutboxPublisher` marks the producing row
      // DELIVERED in a transaction separate from the one that ran this handler, so
      // a crash between the two replays it. Carrying the producer's event id makes
      // that replay re-enqueue nothing instead of sending the subscriber a second
      // copy of an event that already went out.
      { dedupeKey: event.eventId },
    );
  }
}
