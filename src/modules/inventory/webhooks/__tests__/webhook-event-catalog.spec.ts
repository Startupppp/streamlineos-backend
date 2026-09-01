import { INVENTORY_WEBHOOK_ROUTES } from "../inventory-outbox-consumer";
import { createWebhookSchema } from "../dto/webhooks.schemas";
import { INVENTORY_COMMAND_EVENTS } from "../../stock-engine/command-events";

/**
 * B3 — what a customer may subscribe to, and whether anything produces it.
 *
 * The original nine names are a published contract: a name that disappears is a
 * webhook somebody registered that silently stops firing, which is the exact
 * failure this module exists to prevent. The second group are producers that
 * existed and were routed to `null` — "delivered nowhere, deliberately" — until
 * B3 gave each a subscriber-facing name.
 */
const ORIGINAL_NINE = [
  "inventory.product.created",
  "inventory.stock.changed",
  "inventory.stock.low",
  "inventory.po.created",
  "inventory.po.received",
  "inventory.so.reserved",
  "inventory.so.shipped",
  "inventory.transfer.completed",
  "inventory.adjustment.posted",
];

function subscribable(name: string): boolean {
  return createWebhookSchema.safeParse({ url: "https://example.test/hook", events: [name] }).success;
}

describe("the subscribable event catalogue", () => {
  it.each(ORIGINAL_NINE)("still accepts %s — removing one silently kills a live webhook", (name) => {
    expect(subscribable(name)).toBe(true);
  });

  it("rejects a name nobody publishes", () => {
    expect(subscribable("inventory.invented.name")).toBe(false);
  });

  it("requires at least one event on a subscription", () => {
    expect(createWebhookSchema.safeParse({ url: "https://example.test/h", events: [] }).success).toBe(false);
  });

  it("requires a real URL", () => {
    expect(createWebhookSchema.safeParse({ url: "not-a-url", events: ["inventory.stock.low"] }).success).toBe(false);
  });
});

describe("B3 — the names added for materials operations", () => {
  const added: [string, string][] = [
    ["inventory.receiving.posted", "inventory.stock.received"],
    ["inventory.reservation.created", "inventory.stock.reserved"],
    ["inventory.reservation.released", "inventory.stock.released"],
    ["inventory.reservation.consumed", "inventory.reservation.fulfilled"],
    ["inventory.stock.transfer.dispatched", "inventory.transfer.dispatched"],
    ["inventory.pick.completed", "inventory.picklist.completed"],
    ["inventory.return.posted", "inventory.return.received"],
    ["inventory.stock.out", "inventory.stock.out"],
  ];

  it.each(added)("%s is routed to the subscribable name %s", (producer, subscriber) => {
    expect(INVENTORY_WEBHOOK_ROUTES[producer]).toBe(subscriber);
    expect(subscribable(subscriber)).toBe(true);
  });

  it("routes a transfer's own internal hold nowhere, so one movement is not three webhooks", () => {
    expect(INVENTORY_WEBHOOK_ROUTES["inventory.stock.transfer.reserved"]).toBeNull();
  });
});

describe("stock.low and stock.out", () => {
  it("are two different names, because they are two different jobs", () => {
    expect(INVENTORY_COMMAND_EVENTS.STOCK_LOW).not.toBe(INVENTORY_COMMAND_EVENTS.STOCK_OUT);
  });

  it("are both routed and both subscribable", () => {
    for (const name of [INVENTORY_COMMAND_EVENTS.STOCK_LOW, INVENTORY_COMMAND_EVENTS.STOCK_OUT]) {
      expect(INVENTORY_WEBHOOK_ROUTES[name]).toBe(name);
      expect(subscribable(name)).toBe(true);
    }
  });
});
