import { OutboxConsumerRegistry, type OutboxEventRow } from "./outbox-consumer.registry";

/**
 * The registry used to be a `Map<string, OutboxEventConsumer>` and `register`
 * overwrote. Two consumers legitimately want `inventory.stock.low` —
 * `InvStockLowConsumerService` notifies the buyer and `InventoryOutboxConsumer`
 * enqueues the customer's webhook — and both register in their own
 * `onModuleInit`. Whichever Nest initialised second silently replaced the first,
 * so exactly one of "the buyer is told" and "the subscriber's webhook fires"
 * happened, decided by module ordering, with nothing anywhere saying so.
 *
 * These are the properties that make that impossible to reintroduce.
 */
const event = { eventType: "inventory.stock.low", eventId: "evt-1" } as unknown as OutboxEventRow;

describe("OutboxConsumerRegistry — fan-out", () => {
  it("keeps both consumers registered for one event type", () => {
    const registry = new OutboxConsumerRegistry();
    const first = { eventType: event.eventType, handle: jest.fn() };
    const second = { eventType: event.eventType, handle: jest.fn() };
    registry.register(first);
    registry.register(second);
    expect(registry.getAll(event.eventType)).toEqual([first, second]);
  });

  it("does not register the same instance twice on a repeated onModuleInit", () => {
    const registry = new OutboxConsumerRegistry();
    const consumer = { eventType: event.eventType, handle: jest.fn() };
    registry.register(consumer);
    registry.register(consumer);
    expect(registry.getAll(event.eventType)).toHaveLength(1);
  });

  it("returns an empty list for an unregistered type, so the publisher can say so", () => {
    expect(new OutboxConsumerRegistry().getAll("inventory.nothing.here")).toEqual([]);
  });

  it("keeps different event types apart", () => {
    const registry = new OutboxConsumerRegistry();
    const low = { eventType: "inventory.stock.low", handle: jest.fn() };
    const out = { eventType: "inventory.stock.out", handle: jest.fn() };
    registry.register(low);
    registry.register(out);
    expect(registry.getAll("inventory.stock.low")).toEqual([low]);
    expect(registry.getAll("inventory.stock.out")).toEqual([out]);
  });

  it("still answers `get` with the first consumer, for callers that only ask whether the type is handled", () => {
    const registry = new OutboxConsumerRegistry();
    const first = { eventType: event.eventType, handle: jest.fn() };
    registry.register(first);
    registry.register({ eventType: event.eventType, handle: jest.fn() });
    expect(registry.get(event.eventType)).toBe(first);
  });
});
