import { BadRequestException, NotFoundException } from "@nestjs/common";
import { type Db } from "../../../../db/drizzle.module";
import type { InventoryAuditService } from "../../stock-engine/inventory-audit.service";
import type { WebhookTransportService } from "../webhook-transport.service";
import { listEvents, retryEvent, type WebhookEventDeps } from "../lib/webhook-events";

/**
 * Two refusals in `lib/webhook-events.ts` that nothing asserted.
 *
 * Both were found by mutation when the file was split out of
 * `webhooks.service.ts`: deleting the `!webhook.isActive` throw and deleting
 * the `!webhookCheck[0]` throw each left the whole inventory suite green
 * (170 suites, 1765 tests). `webhooks-tenant-isolation.spec.ts` drives
 * `retryEvent` but only inspects the org predicate on the UPDATE statements —
 * it stubs the webhook row as active and never reaches either branch.
 *
 * The disabled-subscription refusal is the one that matters. A disable is
 * either an admin's decision or this module's auto-disable after three
 * undeliverable events, and honouring a manual retry through it sends traffic
 * to the exact endpoint the disable exists to stop sending to. Without a test,
 * deleting the branch is a silent behaviour change that looks like a cleanup.
 */

const ORG = "org-owner";
const USER = "user-1";

const EVENT_ROW = {
  id: 4213,
  orgId: ORG,
  webhookId: 7,
  eventType: "inventory.stock.changed",
  payload: { sku: "X-1" },
  status: "FAILED",
  attempts: 3,
  deliveredAt: null,
  dedupeKey: null,
  nextAttemptAt: null,
  leaseExpiresAt: null,
  lastAttemptAt: null,
  lastError: "http:503",
  deadLetteredAt: new Date("2026-09-01T00:00:00.000Z"),
  createdAt: new Date("2026-08-28T00:00:00.000Z"),
};

const DISABLED_WEBHOOK = {
  id: 7,
  orgId: ORG,
  url: "https://hooks.example.com/inv",
  secret: "s".repeat(64),
  isActive: false,
  disabledReason: "auto-disabled after 3 undeliverable events (http:503)",
};

/**
 * A db double that answers each `select()` from a queue, in call order.
 * Deliberately not a self-referential `const chain = { from: () => chain }`:
 * that shape typechecks under jest and fails `tsc --noEmit`.
 */
function makeDb(results: unknown[][]): {
  db: Db;
  deliver: jest.Mock<Promise<{ ok: boolean }>, unknown[]>;
} {
  let call = 0;
  const deliver = jest.fn<Promise<{ ok: boolean }>, unknown[]>(async () => ({ ok: true }));
  const db = {
    select: jest.fn(() => {
      const rows = results[call++] ?? [];
      // `.limit()` is terminal on the single-row lookups and takes a further
      // `.offset()` on the paged one, so it awaits AND chains.
      const limited = () => Object.assign(Promise.resolve(rows), { offset: () => Promise.resolve(rows) });
      const terminal = {
        limit: jest.fn(limited),
        offset: jest.fn(() => Promise.resolve(rows)),
        orderBy: jest.fn(() => terminal),
      };
      return { from: jest.fn(() => ({ where: jest.fn(() => terminal) })) };
    }),
    update: jest.fn(() => ({
      set: jest.fn(() => ({
        where: jest.fn(() => ({ returning: jest.fn(async () => [EVENT_ROW]) })),
      })),
    })),
  } as unknown as Db;
  return { db, deliver };
}

function depsFor(db: Db, deliver: jest.Mock<Promise<{ ok: boolean }>, unknown[]>): WebhookEventDeps {
  return {
    db,
    audit: { insert: jest.fn(async () => undefined) } as unknown as InventoryAuditService,
    transport: { deliver } as unknown as WebhookTransportService,
    isProd: false,
  };
}

describe("retryEvent — a disabled subscription refuses redelivery", () => {
  it("throws BadRequestException and never reaches the transport", async () => {
    const { db, deliver } = makeDb([[EVENT_ROW], [DISABLED_WEBHOOK]]);

    await expect(retryEvent(depsFor(db, deliver), ORG, USER, EVENT_ROW.id)).rejects.toThrow(
      BadRequestException,
    );
    // The refusal is the point: nothing may be sent to the endpoint the
    // disable exists to stop sending to.
    expect(deliver).not.toHaveBeenCalled();
  });

  it("names the disable reason so the operator knows why the button did nothing", async () => {
    const { db, deliver } = makeDb([[EVENT_ROW], [DISABLED_WEBHOOK]]);

    await expect(retryEvent(depsFor(db, deliver), ORG, USER, EVENT_ROW.id)).rejects.toThrow(
      /auto-disabled after 3 undeliverable events/,
    );
  });

  it("falls back to the bare message when the row carries no reason", async () => {
    const { db, deliver } = makeDb([
      [EVENT_ROW],
      [{ ...DISABLED_WEBHOOK, disabledReason: null }],
    ]);

    await expect(retryEvent(depsFor(db, deliver), ORG, USER, EVENT_ROW.id)).rejects.toThrow(
      "Webhook is disabled; re-enable it before retrying",
    );
  });

  it("delivers when the subscription is active (control)", async () => {
    const { db, deliver } = makeDb([[EVENT_ROW], [{ ...DISABLED_WEBHOOK, isActive: true }]]);

    await expect(
      retryEvent(depsFor(db, deliver), ORG, USER, EVENT_ROW.id),
    ).resolves.toMatchObject({ id: EVENT_ROW.id });
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});

describe("listEvents — an unknown or foreign webhook is 404, not an empty page", () => {
  it("throws NotFoundException when the (id, org) pair matches no webhook", async () => {
    const { db, deliver } = makeDb([[]]);

    await expect(
      listEvents(depsFor(db, deliver), "org-attacker", 7, { page: 1, limit: 20 }),
    ).rejects.toThrow(NotFoundException);
    // The page query must not run at all — an empty 200 would report a foreign
    // webhook as one that exists and has no events.
    expect((db.select as jest.Mock).mock.calls).toHaveLength(1);
  });

  it("pages the events when the webhook belongs to the caller's org (control)", async () => {
    const { db, deliver } = makeDb([[{ id: 7 }], [{ ...EVENT_ROW, windowTotal: "1" }]]);

    const page = await listEvents(depsFor(db, deliver), ORG, 7, { page: 1, limit: 20 });
    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
  });
});
