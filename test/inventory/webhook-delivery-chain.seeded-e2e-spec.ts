import { createHmac } from "node:crypto";
import request from "supertest";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { WebhooksService as InvWebhooksService } from "src/modules/inventory/webhooks/webhooks.service";
import {
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from "src/modules/inventory/webhooks/webhook-signature";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";
import { buildInventoryFixture, type InventoryFixture } from "test/helpers/inventory-fixture";

/**
 * INV-29 — a movement, all the way to somebody else's server.
 *
 * `stock-events` proves the engine writes the outbox row. The webhook unit
 * suites prove the emitter dedupes and the transport signs. Nothing joined
 * them, and the join is four separate hand-offs: the outbox publisher has to
 * dispatch to a registered consumer, the consumer has to map
 * `inventory.stock.movement.posted` onto the subscriber-facing
 * `inventory.stock.changed`, the emitter has to enqueue against a subscription,
 * and the delivery worker — driven by a cron route with no session — has to
 * find the queued row and send it.
 *
 * Each of those is a place where the chain can be broken while every unit test
 * passes. Inventory has already had this exact failure: it emitted seven event
 * types that reached nobody because no consumer was registered at all, and the
 * only symptom was silence.
 *
 * The network is the one substitute. `fetch` is replaced for this suite's own
 * target only — a blanket stub also swallows Redis and breaks the guard chain
 * in ways that read as webhook failures — and the target is 198.18.0.1, RFC
 * 2544 benchmark space, which routes nowhere even if the stub failed.
 *
 *   pnpm test:e2e:seeded --testPathPattern=webhook-delivery-chain
 */

const SINK = "http://198.18.0.1/inventory-hook";
const PERMISSIONS = [
  "inventory:warehouses:scope-all",
  "inventory:stock:read",
  "inventory:stock:adjust",
];

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
}

describe("[seeded-e2e] INV-29 — a posted movement reaches a subscriber", () => {
  let seededApp: SeededE2eApp;
  let db: Db;
  let orgId: string;
  let userId: string;
  let fixture: InventoryFixture;
  let secret: string;
  let captured: Captured[];
  let realFetch: typeof globalThis.fetch;
  const teardowns: Array<() => Promise<void>> = [];

  const cronSecret = process.env.CRON_SECRET;

  beforeAll(async () => {
    if (!cronSecret)
      throw new Error(
        "CRON_SECRET must be set: both the outbox publisher and the webhook delivery worker " +
          "are driven by cron routes, and advancing them any other way would stop this being " +
          "an end-to-end test.",
      );

    seededApp = await createSeededE2eApp();
    db = seededApp.app.get<Db>(DRIZZLE);

    const seeded = await seedOrg(seededApp.seedDb)
      .addMember("keeper", { permissionKeys: PERMISSIONS })
      .build();
    teardowns.push(() => seeded.teardown());
    orgId = seeded.orgId;
    userId = seeded.members["keeper"]!.userId;
    fixture = await buildInventoryFixture(seededApp.app, orgId, userId, "inv29");

    const webhook = await runInNewTenantTransaction(db, orgId, () =>
      seededApp.app.get(InvWebhooksService).create(orgId, userId, {
        url: SINK,
        events: ["inventory.stock.changed"],
        isActive: true,
      } as never),
    );
    secret = (webhook as unknown as { secret: string }).secret;

    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("http://198.18.0.1")) return realFetch(input as RequestInfo, init);
      captured.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: String(init?.body ?? ""),
      });
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;
  }, 600_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    for (const teardown of teardowns.reverse()) await teardown().catch(() => undefined);
    if (seededApp) await seededApp.close();
  }, 120_000);

  beforeEach(() => {
    captured = [];
  });

  /**
   * The real drivers, over HTTP, exactly as the scheduler calls them.
   *
   * A 200 is not evidence the sweep ran. Both routes take a cron lease and
   * answer `{ success: true, skipped: true }` when another holder has it — the
   * outbox lease is 120 seconds — so a suite that asserted only the status code
   * would drive nothing, find nothing, and report the chain broken. That is how
   * this test failed the first time it was run beside another seeded suite.
   *
   * So the skip is waited out rather than tolerated.
   */
  const cron = async (route: string): Promise<void> => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const res = await request(seededApp.app.getHttpServer())
        .post(`/cron/${route}`)
        .set("Authorization", `Bearer ${cronSecret ?? ""}`);
      expect(res.status).toBe(200);

      const body = res.body as { skipped?: boolean };
      if (body.skipped !== true) return;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    throw new Error(
      `/cron/${route} answered "already running" for 150s — another sweep holds the lease, ` +
        `so this suite cannot drive the chain it is testing.`,
    );
  };

  /**
   * Only the deliveries for this test's own movement.
   *
   * The fixture builder posts eight movements of its own before the test does,
   * and each is a real stock change that a subscriber to
   * `inventory.stock.changed` genuinely wants. Counting every row in the
   * organisation would make this file assert the fixture's shape rather than
   * the chain's behaviour, and it would have to be edited every time the
   * fixture gained a movement.
   */
  const MINE = "inv29-move";

  const queued = () =>
    runInNewTenantTransaction(db, orgId, (tx) =>
      tx.execute<{ id: number; event_type: string; status: string; dedupe_key: string | null }>(sql`
        SELECT id, event_type, status, dedupe_key
          FROM inv_webhook_events
         -- sourceId sits at the top of the STORED payload; the data wrapper
         -- in the delivered body is added by the transport.
         WHERE org_id = ${orgId} AND payload ->> 'sourceId' = ${MINE}
         ORDER BY id
      `),
    );

  /** Captures aimed at this test's movement, by the same rule. */
  const capturedMine = () =>
    captured.filter((c) => {
      try {
        const body = JSON.parse(c.body) as { data?: { sourceId?: string } };
        return body.data?.sourceId === MINE;
      } catch {
        return false;
      }
    });

  /**
   * Each hop, named.
   *
   * A single "no rows queued" assertion tells you the chain is broken and
   * nothing about where, and this chain has four hand-offs. These read the
   * state between them so a failure says which one.
   */
  const chainState = () =>
    runInNewTenantTransaction(db, orgId, async (tx) => {
      const one = async (query: ReturnType<typeof sql>): Promise<number> => {
        const rows = await tx.execute<{ n: number }>(query);
        return rows[0]?.n ?? -1;
      };
      return {
        webhooks: await one(sql`SELECT count(*)::int AS n FROM inv_webhooks WHERE org_id = ${orgId}`),
        subscriptions: await one(
          sql`SELECT count(*)::int AS n FROM inv_webhook_event_subscriptions WHERE org_id = ${orgId}`,
        ),
        movementEvents: await one(sql`
          SELECT count(*)::int AS n FROM outbox_events
           WHERE organization_id = ${orgId} AND event_type = 'inventory.stock.movement.posted'
        `),
        publishedEvents: await one(sql`
          SELECT count(*)::int AS n FROM outbox_events
           WHERE organization_id = ${orgId} AND event_type = 'inventory.stock.movement.posted'
             AND published_at IS NOT NULL
        `),
        states: (
          await tx.execute<{ delivery_state: string; n: number }>(sql`
            SELECT delivery_state, count(*)::int AS n FROM outbox_events
             WHERE organization_id = ${orgId} GROUP BY delivery_state
          `)
        )
          .map((r) => `${r.delivery_state}=${r.n}`)
          .join(","),
        lastError: (
          await tx.execute<{ last_error: string | null }>(sql`
            SELECT last_error FROM outbox_events
             WHERE organization_id = ${orgId} AND last_error IS NOT NULL LIMIT 1
          `)
        )[0]?.last_error ?? null,
      };
    });

  it(
    "registered the webhook and its subscription",
    async () => {
      const state = await chainState();
      expect({ webhooks: state.webhooks, subscriptions: state.subscriptions }).toEqual({
        webhooks: 1,
        subscriptions: 1,
      });
    },
    120_000,
  );

  it(
    "posts a movement, publishes it, and queues exactly one webhook for it",
    async () => {
      expect(await queued()).toHaveLength(0);

      await runInNewTenantTransaction(db, orgId, (tx) =>
        seededApp.app.get(StockEngineService).executeInTx(tx, orgId, userId, {
          idempotencyKey: "inv29-move",
          sourceType: "TEST",
          sourceId: "inv29-move",
          reason: "webhook chain",
          postingDate: "2026-06-02",
          movements: [
            {
              transactionType: "PURCHASE",
              productVariantId: fixture.variants.widget.variantId,
              locationId: fixture.locations.mainBin,
              quantityDelta: "7.0000",
              unitCost: "1.2500",
            },
          ],
        }),
      );

      // The outbox publisher is what dispatches to the inventory consumer.
      // Ticked more than once because a run claims a batch and the chain has
      // two hops in it.
      for (let pass = 0; pass < 4 && (await queued()).length === 0; pass += 1)
        await cron("outbox-events-worker");

      const rows = await queued();
      // If nothing was queued, say which hop stopped rather than only that one did.
      if (rows.length === 0) expect(await chainState()).toEqual("a queued webhook");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.event_type).toBe("inventory.stock.changed");
      // The dedupe key is the outbox event id, which is what makes a replayed
      // dispatch free rather than a second delivery.
      expect(rows[0]?.dedupe_key).toEqual(expect.any(String));
    },
    600_000,
  );

  it(
    "delivers it once, signed over timestamp and body",
    async () => {
      await cron("inventory-webhook-delivery");

      const mine = capturedMine();
      expect(mine).toHaveLength(1);
      const call = mine[0];
      if (!call) throw new Error("nothing was delivered");

      /**
       * Verified the way a subscriber would, by hand, from the wire.
       *
       * The header is `t=<unix seconds>,v1=<hex>` and the preimage is
       * `"<unix seconds>.<raw body>"` — the timestamp is in the signed material
       * rather than beside it, which is what stops a captured (body, signature)
       * pair being replayed forever. Recomputing it here rather than calling
       * the module's own verifier is the point: a verifier checking itself
       * would agree with any scheme, including a broken one.
       */
      const header = call.headers[WEBHOOK_SIGNATURE_HEADER];
      expect(header).toEqual(expect.stringMatching(/^t=\d+,v1=[0-9a-f]{64}$/));

      const parts = Object.fromEntries(
        String(header)
          .split(",")
          .map((part) => {
            const eq = part.indexOf("=");
            return [part.slice(0, eq).trim(), part.slice(eq + 1).trim()];
          }),
      );

      const expected = createHmac("sha256", secret)
        .update(`${parts["t"]}.${call.body}`)
        .digest("hex");
      expect(parts["v1"]).toBe(expected);

      // The standalone timestamp header carries the same value, so a subscriber
      // that reads either one gets the same answer.
      expect(call.headers[WEBHOOK_TIMESTAMP_HEADER]).toBe(parts["t"]);

      const rows = await queued();
      expect(rows[0]?.status).toBe("DELIVERED");
    },
    600_000,
  );

  it(
    "does not deliver a second time on the next sweep",
    async () => {
      await cron("inventory-webhook-delivery");

      expect(capturedMine()).toEqual([]);
      expect(await queued()).toHaveLength(1);
    },
    600_000,
  );

  /**
   * The dedupe, from the direction it actually fails. A retried command is
   * replayed by the engine and emits nothing new, so the outbox has one event
   * and the queue must still hold one row — not two identical deliveries to a
   * customer's endpoint.
   */
  it(
    "queues nothing more when the same command is retried",
    async () => {
      await runInNewTenantTransaction(db, orgId, (tx) =>
        seededApp.app.get(StockEngineService).executeInTx(tx, orgId, userId, {
          idempotencyKey: "inv29-move",
          sourceType: "TEST",
          sourceId: "inv29-move",
          reason: "webhook chain",
          postingDate: "2026-06-02",
          movements: [
            {
              transactionType: "PURCHASE",
              productVariantId: fixture.variants.widget.variantId,
              locationId: fixture.locations.mainBin,
              quantityDelta: "7.0000",
              unitCost: "1.2500",
            },
          ],
        }),
      );

      for (let pass = 0; pass < 3; pass += 1) await cron("outbox-events-worker");
      await cron("inventory-webhook-delivery");

      expect(await queued()).toHaveLength(1);
      expect(capturedMine()).toEqual([]);
    },
    600_000,
  );
});
