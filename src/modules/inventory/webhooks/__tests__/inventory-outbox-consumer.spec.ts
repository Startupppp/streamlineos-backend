import { OutboxConsumerRegistry, type OutboxEventRow } from "../../../../common/outbox/outbox-consumer.registry";
import { InventoryOutboxConsumer, INVENTORY_WEBHOOK_ROUTES } from "../inventory-outbox-consumer";
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
});
