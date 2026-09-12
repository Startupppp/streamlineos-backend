import { OutboxConsumerRegistry, type OutboxEventRow } from "../../../../common/outbox/outbox-consumer.registry";
import { InventoryOutboxConsumer, INVENTORY_WEBHOOK_ROUTES } from "../inventory-outbox-consumer";
import { InvWebhooksModule } from "../inv-webhooks.module";
import type { InventoryWebhookEmitter } from "../webhook-emitter.service";

/**
 * A5 — the bridge from the outbox to a customer's webhook.
 *
 * `InventoryWebhookEmitter.emit` was exported by its module and called from
 * nowhere, so a registered inventory webhook could never fire however many
 * events the system produced. These assert the two things that must be true
 * now: the consumer is registered for every routed type, and a delivered event
 * arrives under the name the subscriber holds rather than the producer's.
 */
function row(eventType: string, payload: Record<string, unknown> = {}): OutboxEventRow {
  return {
    eventType,
    organizationId: "org_1",
    eventId: "11111111-1111-4111-8111-111111111111",
    payload,
  } as OutboxEventRow;
}

describe("InventoryOutboxConsumer", () => {
  const makeEmitter = () => ({ emit: jest.fn().mockResolvedValue(undefined) });

  const wire = (emitter: { emit: jest.Mock }) => {
    const registry = new OutboxConsumerRegistry();
    const consumer = new InventoryOutboxConsumer(
      registry,
      emitter as unknown as InventoryWebhookEmitter,
    );
    consumer.onModuleInit();
    return registry;
  };

  it("registers a consumer for every routed event type", () => {
    const registry = wire(makeEmitter());
    const unregistered = Object.keys(INVENTORY_WEBHOOK_ROUTES).filter(
      (type) => registry.get(type) === undefined,
    );
    expect(unregistered).toEqual([]);
  });

  it("delivers under the name the subscriber holds, not the producer's", async () => {
    // The two vocabularies drifted: the engine emits
    // `inventory.stock.movement.posted`, and what a customer subscribed to is
    // `inventory.stock.changed`. Renaming either side would break the other.
    const emitter = makeEmitter();
    const registry = wire(emitter);

    await registry.get("inventory.stock.movement.posted")!.handle(
      row("inventory.stock.movement.posted", { idempotencyKey: "k1" }),
    );

    expect(emitter.emit).toHaveBeenCalledTimes(1);
    const [orgId, webhookType, payload] = emitter.emit.mock.calls[0]!;
    expect(orgId).toBe("org_1");
    expect(webhookType).toBe("inventory.stock.changed");
    expect(payload).toMatchObject({
      idempotencyKey: "k1",
      outboxEventType: "inventory.stock.movement.posted",
    });
  });

  it("acknowledges an event with no subscriber-facing name instead of failing it", async () => {
    // An unrouted type is not ignored by the publisher — it throws, retries and
    // dead-letters. Routing to null is how "nobody subscribes to this" is said
    // out loud.
    const emitter = makeEmitter();
    const registry = wire(emitter);

    await expect(
      registry.get("inventory.scan.captured")!.handle(row("inventory.scan.captured")),
    ).resolves.toBeUndefined();
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  /**
   * The six `check:outbox-consumers` reported as orphaned.
   *
   * They were never orphaned: all six are registered here, by the loop over
   * `INVENTORY_WEBHOOK_ROUTES`. The gate could not read that shape — the
   * property is ES shorthand, so no event-type literal ever appears beside an
   * `eventType:` key — and reported six live, delivering types as unconsumed.
   *
   * The test above proves the *table* is fully registered, which stays true if
   * somebody deletes a row from the table. These name the six out loud, and
   * pin the routing decision each one carries, so withdrawing any of them is a
   * deliberate edit to a test rather than a silent narrowing.
   */
  const PREVIOUSLY_REPORTED_ORPHANED: ReadonlyArray<readonly [string, string | null]> = [
    // Scans are high-volume and internal; a webhook per barcode beep is noise.
    ["inventory.scan.captured", null],
    ["inventory.purchase_order.received", "inventory.po.received"],
    ["inventory.sales_order.fulfilled", "inventory.so.shipped"],
    // Same parcel as its sales order's fulfilment — routing both would deliver
    // two webhooks for one event.
    ["inventory.shipment.dispatched", null],
    ["inventory.stock.adjusted", "inventory.adjustment.posted"],
    // A batch of offline scans replaying is a sync detail, not a stock fact; the
    // movements it produces announce themselves.
    ["inventory.sync.offline_batch_applied", null],
  ];

  it.each(PREVIOUSLY_REPORTED_ORPHANED)(
    "%s has a registered consumer",
    (producer) => {
      const registry = wire(makeEmitter());
      // `getAll`, not `get`: `OutboxPublisher.deliver` throws when this is empty,
      // which is the failure the gate was reporting.
      expect(registry.getAll(producer).length).toBeGreaterThan(0);
      // `toHaveProperty` reads a dotted string as a path, so it can never see a
      // key that is itself dotted.
      expect(Object.keys(INVENTORY_WEBHOOK_ROUTES)).toContain(producer);
    },
  );

  it.each(PREVIOUSLY_REPORTED_ORPHANED)(
    "%s handles an event without throwing, routing it to %s",
    async (producer, subscriberName) => {
      const emitter = makeEmitter();
      const registry = wire(emitter);

      await expect(
        registry.getAll(producer)[0]!.handle(row(producer, { some: "payload" })),
      ).resolves.toBeUndefined();

      if (subscriberName === null) {
        expect(emitter.emit).not.toHaveBeenCalled();
        return;
      }

      expect(emitter.emit).toHaveBeenCalledTimes(1);
      const [orgId, webhookType, payload, options] = emitter.emit.mock.calls[0]!;
      expect(orgId).toBe("org_1");
      expect(webhookType).toBe(subscriberName);
      expect(payload).toMatchObject({ some: "payload", outboxEventType: producer });
      // Dispatch is at-least-once; the producer's event id is what stops a replay
      // sending the subscriber a second copy.
      expect(options).toEqual({ dedupeKey: "11111111-1111-4111-8111-111111111111" });
    },
  );

  it("is a provider of the module the app actually loads", () => {
    // The registration above only runs if Nest instantiates this class, and it
    // only does that for a provider of a module in the graph. A consumer that
    // exists but is never constructed dead-letters every event while looking
    // implemented — which is the shape of bug the gate is meant to catch.
    const providers = Reflect.getMetadata("providers", InvWebhooksModule) as unknown[];
    expect(providers).toContain(InventoryOutboxConsumer);
  });
});
