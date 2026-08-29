import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { STOCK_MOVEMENT_POSTED } from "src/modules/inventory/stock-engine/stock-events";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * A5 — the engine tells the rest of the system that stock moved.
 *
 * Every movement was written to `inv_stock_transactions` and to an audit row,
 * and neither is an event: an audit row is a private record of who did what,
 * and nothing subscribes to a table. So the PRD's event contract existed on
 * paper while webhooks and integrations saw nothing at all.
 *
 * The two properties that matter are counted, not eyeballed: exactly one event
 * per *accepted* command — a transfer's two legs are one fact about the world —
 * and none at all for a replay, which falls out of the engine returning the
 * stored result before it reaches the emit.
 */
interface Scene {
  orgId: string;
  userId: string;
  variantId: number;
  sku: string;
  warehouseId: number;
  locationId: number;
  otherLocationId: number;
}

interface MovementFact {
  transactionId: number;
  sku: string | null;
  warehouseId: number | null;
  quantityChange: string;
  quantityBucket: string;
  quantityAfter: string;
}

describe("[seeded-e2e] the engine emits a movement event", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  const db = () => app.app.get<Db>(DRIZZLE);

  /** Movement events for one idempotency key, newest last. */
  const eventsFor = async (key: string) => {
    const rows = await asTenant(() =>
      db().execute<{ payload: unknown }>(sql`
        SELECT payload FROM outbox_events
        WHERE organization_id = ${scene.orgId}
          AND event_type = ${STOCK_MOVEMENT_POSTED}
          AND aggregate_id = ${key}
        ORDER BY outbox_event_id`),
    );
    return rows.map((r) => r.payload as Record<string, unknown>);
  };

  const post = (key: string, movements: ReadonlyArray<Record<string, unknown>>) =>
    asTenant(() =>
      app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
        idempotencyKey: key,
        sourceType: "stock-events-fixture",
        sourceId: key,
        movements: movements as never,
      }),
    );

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("keeper", {
        permissionKeys: [
          "inventory:warehouses:scope-all",
          "inventory:stock:read",
          "inventory:stock:adjust",
        ],
      })
      .build();
    teardown = () => seeded.teardown();

    const tag = randomUUID().slice(0, 6);
    scene = await runInNewTenantTransaction(db(), seeded.orgId, async () => {
      const userId = seeded.members["keeper"]!.userId;
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db().execute<T>(q))[0]!;
      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const sku = `EV-${tag}`;
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Event goods', ${sku}, ${userId}) RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`${sku}-V`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Main', ${`EW${tag}`}, ${userId}) RETURNING id`);
      const location = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Bin', ${`EB${tag}`}, 'BIN', true) RETURNING id`);
      const other = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Bin2', ${`EC${tag}`}, 'BIN', true) RETURNING id`);
      return {
        orgId: seeded.orgId,
        userId,
        variantId: variant.id,
        sku: `${sku}-V`,
        warehouseId: warehouse.id,
        locationId: location.id,
        otherLocationId: other.id,
      };
    });
  }, 300_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app?.close();
  }, 120_000);

  it("emits exactly one event for an accepted command, carrying what moved", async () => {
    const key = `ev-one-${randomUUID().slice(0, 8)}`;
    const result = await post(key, [
      {
        transactionType: "PURCHASE",
        productVariantId: scene.variantId,
        locationId: scene.locationId,
        quantityDelta: "40.0000",
        unitCost: "2.0000",
      },
    ]);

    const events = await eventsFor(key);
    expect(events).toHaveLength(1);

    const payload = events[0]!;
    expect(payload.idempotencyKey).toBe(key);
    expect(payload.actorUserId).toBe(scene.userId);
    expect(payload.sourceType).toBe("stock-events-fixture");

    const movements = payload.movements as MovementFact[];
    expect(movements).toHaveLength(1);
    // The SKU and warehouse are on the event on purpose: a consumer holding only
    // a variant id has to join two tables to learn what moved.
    expect(movements[0]!.sku).toBe(scene.sku);
    expect(movements[0]!.warehouseId).toBe(scene.warehouseId);
    expect(movements[0]!.transactionId).toBe(result.transactionIds[0]);
    expect(Number(movements[0]!.quantityChange)).toBe(40);
    expect(movements[0]!.quantityBucket).toBe("ON_HAND");
    expect(Number(movements[0]!.quantityAfter)).toBe(40);
  });

  it("emits one event for a two-movement command, not two", async () => {
    // A transfer's legs are one fact about the world. A consumer that saw the
    // issue without the receipt would conclude stock had been destroyed.
    const key = `ev-pair-${randomUUID().slice(0, 8)}`;
    await post(key, [
      {
        transactionType: "TRANSFER_OUT",
        productVariantId: scene.variantId,
        locationId: scene.locationId,
        quantityDelta: "-10.0000",
      },
      {
        transactionType: "TRANSFER_IN",
        productVariantId: scene.variantId,
        locationId: scene.otherLocationId,
        quantityDelta: "10.0000",
        costFromMovementIndex: 0,
      },
    ]);

    const events = await eventsFor(key);
    expect(events).toHaveLength(1);
    expect(events[0]!.movements as MovementFact[]).toHaveLength(2);
  });

  it("emits nothing extra when the same command is retried", async () => {
    const key = `ev-replay-${randomUUID().slice(0, 8)}`;
    const movements = [
      {
        transactionType: "PURCHASE",
        productVariantId: scene.variantId,
        locationId: scene.locationId,
        quantityDelta: "5.0000",
        unitCost: "2.0000",
      },
    ];

    const first = await post(key, movements);
    expect(await eventsFor(key)).toHaveLength(1);

    // A retry replays the stored result and never reaches the emit — the same
    // property that stops it posting the stock twice.
    const second = await post(key, movements);
    expect(second.transactionIds).toEqual(first.transactionIds);
    expect(await eventsFor(key)).toHaveLength(1);
  });

  it("emits no event for a command the engine refused", async () => {
    const key = `ev-refused-${randomUUID().slice(0, 8)}`;
    await expect(
      post(key, [
        {
          transactionType: "SALE",
          productVariantId: scene.variantId,
          locationId: scene.locationId,
          quantityDelta: "-99999.0000",
        },
      ]),
    ).rejects.toThrow();

    // The emit shares the movement's transaction, so a rolled-back command
    // leaves no event behind. Publishing one would have every consumer acting
    // on stock that does not exist.
    expect(await eventsFor(key)).toHaveLength(0);
  });
});
