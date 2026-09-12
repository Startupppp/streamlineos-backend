import type { Db } from "../../../../db/drizzle.module";
import { InventoryWebhookEmitter } from "../webhook-emitter.service";

interface Captured {
  inserted: Record<string, unknown>[][];
}

function makeDb(
  subscribers: { id: number }[],
  inserted: { id: number }[] | Error,
  captured: Captured,
) {
  const selectChain: Record<string, unknown> = {
    from: () => selectChain,
    innerJoin: () => selectChain,
    where: () => Promise.resolve(subscribers),
  };

  const insertChain: Record<string, unknown> = {
    values: (rows: Record<string, unknown>[]) => {
      captured.inserted.push(rows);
      return insertChain;
    },
    onConflictDoNothing: () => insertChain,
    returning: () => (inserted instanceof Error ? Promise.reject(inserted) : Promise.resolve(inserted)),
  };

  return {
    select: () => selectChain,
    insert: () => insertChain,
  } as unknown as Db;
}

/**
 * E7. The emitter used to resolve DNS, sign, `fetch` and record an outcome inline,
 * inside the tenant transaction `OutboxPublisher` opened for the consumer, with
 * every failure caught and logged. These assert what replaced that: a durable
 * record of what is owed, no network, and no swallowing.
 */
describe("InventoryWebhookEmitter", () => {
  const fetchSpy = jest.spyOn(globalThis, "fetch");

  afterEach(() => {
    fetchSpy.mockClear();
  });

  afterAll(() => {
    fetchSpy.mockRestore();
  });

  it("enqueues one due delivery per subscribed webhook and sends nothing itself", async () => {
    const captured: Captured = { inserted: [] };
    const emitter = new InventoryWebhookEmitter(
      makeDb([{ id: 1 }, { id: 2 }], [{ id: 10 }, { id: 11 }], captured),
    );

    const result = await emitter.emit("org-1", "inventory.stock.changed", { sku: "X-1" });

    expect(result).toEqual({ enqueued: 2 });
    expect(fetchSpy).not.toHaveBeenCalled();

    const rows = captured.inserted[0]!;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        orgId: "org-1",
        eventType: "inventory.stock.changed",
        status: "PENDING",
        attempts: 0,
      });
      // Due now: the worker's next tick is attempt 1. A null schedule here is an
      // event no worker will ever claim.
      expect(row.nextAttemptAt).toBeInstanceOf(Date);
    }
  });

  it("carries the producing outbox event id so a replayed dispatch enqueues nothing", async () => {
    const captured: Captured = { inserted: [] };
    const emitter = new InventoryWebhookEmitter(makeDb([{ id: 1 }], [{ id: 10 }], captured));

    await emitter.emit("org-1", "inventory.stock.changed", {}, { dedupeKey: "evt-abc" });

    expect(captured.inserted[0]![0]).toMatchObject({ dedupeKey: "evt-abc" });
  });

  it("writes nothing when no active webhook subscribes to the event", async () => {
    const captured: Captured = { inserted: [] };
    const emitter = new InventoryWebhookEmitter(makeDb([], [], captured));

    expect(await emitter.emit("org-1", "inventory.stock.low", {})).toEqual({ enqueued: 0 });
    expect(captured.inserted).toEqual([]);
  });

  it("lets an enqueue failure reach the publisher instead of swallowing it", async () => {
    // backend/CLAUDE.md §4: never swallow a deferred failure. The old emitter
    // caught this and returned, so `OutboxPublisher` marked the producing event
    // DELIVERED — the webhook was owed, no row said so, and nothing raised.
    const captured: Captured = { inserted: [] };
    const emitter = new InventoryWebhookEmitter(
      makeDb([{ id: 1 }], new Error("42501: permission denied for table inv_webhook_events"), captured),
    );

    await expect(emitter.emit("org-1", "inventory.stock.changed", {})).rejects.toThrow("42501");
  });
});
