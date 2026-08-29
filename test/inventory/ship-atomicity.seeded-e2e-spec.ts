import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { SoCoreService } from "src/modules/inventory/sales-orders/so-core.service";
import { SoLifecycleService } from "src/modules/inventory/sales-orders/so-lifecycle.service";
import { SoFulfillmentService } from "src/modules/inventory/sales-orders/so-fulfillment.service";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { PickWaveService } from "src/modules/inventory/picking/pick-wave.service";
import { PickConfirmService } from "src/modules/inventory/picking/pick-confirm.service";
import { PickExceptionReportService } from "src/modules/inventory/picking/pick-exception-report.service";
import { CarrierStatusService } from "src/modules/inventory/shipments/carrier-status.service";
import { InvReconciliationService } from "src/modules/inventory/reconciliation/inv-reconciliation.service";
import { INVENTORY_COMMAND_EVENTS } from "src/modules/inventory/stock-engine/command-events";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { outboxEventsFor } from "test/helpers/outbox-events";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * B7 — shipment posting is atomic, and it consumes what the picker actually
 * took.
 *
 * Two facts, each of which nothing else in the suite could catch:
 *
 *   **One `Idempotency-Key` ships once.** The key used to reach only
 *   `engine.executeInTx`, which claims it for the ledger. Everything else — the
 *   shipment row, its lines, `quantity_shipped`, the serial flips, both outbox
 *   events, the COGS journal — sat outside any claim. So a retry after a network
 *   timeout replayed the stock posting (correctly, as a no-op) and then wrapped
 *   it in a *second* shipment, a second dispatch event and a second set of
 *   shipped quantities. Nothing threw; the order simply had two shipments and
 *   twice its own quantity marked shipped.
 *
 *   **A substituted line ships.** B5 split `quantity_picked` from
 *   `substitute_quantity` deliberately, and shipping read only the first. In a
 *   mixed order — some lines picked, one substituted — the swapped line
 *   contributed no movement, so the order went out PARTIALLY_SHIPPED with the
 *   substitute still on the shelf and still `outgoing`. Correct-looking at every
 *   status and unbalanced nowhere: only arithmetic on `inv_stock_levels` and the
 *   order's own final status show it.
 *
 *   pnpm test:e2e:seeded --testPathPattern=ship-atomicity
 */
const PERMISSIONS = [
  "inventory:warehouses:scope-all",
  "inventory:stock:read",
  "inventory:stock:adjust",
  "inventory:stock:reconcile",
  "inventory:sales-orders:create",
  "inventory:sales-orders:read",
  "inventory:sales-orders:confirm",
  "inventory:sales-orders:ship",
  "inventory:picking:substitute",
  "inventory:shipments:manage",
] as const;

interface Scene {
  orgId: string;
  userId: string;
  variantId: number;
  otherVariantId: number;
  substituteVariantId: number;
  warehouseId: number;
  locationId: number;
}

interface Buckets {
  onHand: number;
  committed: number;
  outgoing: number;
}

describe("[seeded-e2e] shipment posting is atomic", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  const ship = () => app.app.get(SoFulfillmentService);
  const waves = () => app.app.get(PickWaveService);
  const picks = () => app.app.get(PickConfirmService);
  const exceptions = () => app.app.get(PickExceptionReportService);

  async function buckets(variantId: number): Promise<Buckets> {
    const rows = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{
        on_hand: string;
        committed: string;
        outgoing: string;
      }>(sql`
        SELECT COALESCE(SUM(on_hand::numeric), 0)::text  AS on_hand,
               COALESCE(SUM(committed::numeric), 0)::text AS committed,
               COALESCE(SUM(outgoing_qty::numeric), 0)::text AS outgoing
          FROM inv_stock_levels
         WHERE org_id = ${scene.orgId} AND product_variant_id = ${variantId}
      `),
    );
    const row = rows[0]!;
    return {
      onHand: Number(row.on_hand),
      committed: Number(row.committed),
      outgoing: Number(row.outgoing),
    };
  }

  /** The projection still follows from the movements. */
  async function expectReconciled() {
    const report = await asTenant(() =>
      app.app.get(InvReconciliationService).report(scene.orgId, scene.userId, { limit: 100 }),
    );
    expect(report.drift).toEqual([]);
  }

  async function shipmentsFor(soId: number) {
    return asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{ id: number; status: string; tracking_number: string | null }>(sql`
        SELECT id, status, tracking_number FROM inv_shipments
         WHERE org_id = ${scene.orgId} AND so_id = ${soId} ORDER BY id`),
    );
  }

  async function shipmentLinesFor(soId: number) {
    return asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{ product_variant_id: number; quantity: string }>(sql`
        SELECT sl.product_variant_id, sl.quantity
          FROM inv_shipment_lines sl
          JOIN inv_shipments s ON s.org_id = sl.org_id AND s.id = sl.shipment_id
         WHERE sl.org_id = ${scene.orgId} AND s.so_id = ${soId}
         ORDER BY sl.product_variant_id`),
    );
  }

  async function soRow(soId: number) {
    const rows = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{ status: string }>(sql`
        SELECT status FROM inv_sales_orders WHERE org_id = ${scene.orgId} AND id = ${soId}`),
    );
    return rows[0]!;
  }

  async function soLines(soId: number) {
    return asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{
        id: number;
        product_variant_id: number;
        quantity: string;
        quantity_shipped: string;
      }>(sql`
        SELECT id, product_variant_id, quantity, quantity_shipped
          FROM inv_so_lines WHERE org_id = ${scene.orgId} AND so_id = ${soId}
         ORDER BY line_order, id`),
    );
  }

  async function reservationStates(soId: number) {
    const rows = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{ status: string }>(sql`
        SELECT status FROM inv_stock_reservations
         WHERE org_id = ${scene.orgId}
           AND source_type = 'inv_sales_order' AND source_id = ${String(soId)}
         ORDER BY id`),
    );
    return rows.map((r) => r.status);
  }

  async function createOrder(
    lines: Array<{ productVariantId: number; quantity: number }>,
  ): Promise<number> {
    const so = await asTenant(() =>
      app.app.get(SoCoreService).createSo(scene.orgId, scene.userId, {
        orderDate: "2026-08-29",
        currency: "INR",
        warehouseId: scene.warehouseId,
        lines: lines.map((line, index) => ({
          productVariantId: line.productVariantId,
          quantity: line.quantity,
          unitPrice: "10.0000",
          taxRate: "0",
          lineOrder: index,
        })),
      }),
    );
    const soId = (so as { id: number }).id;
    await asTenant(() =>
      app.app.get(SoLifecycleService).confirmSo(scene.orgId, soId, scene.userId, `b7-confirm-${soId}`),
    );
    return soId;
  }

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("keeper", { permissionKeys: PERMISSIONS })
      .build();
    teardown = () => seeded.teardown();

    const tag = randomUUID().slice(0, 6);
    const db = app.app.get<Db>(DRIZZLE);
    scene = await runInNewTenantTransaction(db, seeded.orgId, async () => {
      const userId = seeded.members["keeper"]!.userId;
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db.execute<T>(q))[0]!;
      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Ship goods', ${`B7-${tag}`}, ${userId}) RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Ordered', ${`B7-${tag}-V`}) RETURNING id`);
      const other = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Second', ${`B7-${tag}-O`}) RETURNING id`);
      const substitute = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Substitute', ${`B7-${tag}-S`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Main', ${`B7M${tag}`}, ${userId}) RETURNING id`);
      const location = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Bin', ${`B7B${tag}`}, 'BIN') RETURNING id`);
      return {
        orgId: seeded.orgId,
        userId,
        variantId: variant.id,
        otherVariantId: other.id,
        substituteVariantId: substitute.id,
        warehouseId: warehouse.id,
        locationId: location.id,
      };
    });

    await asTenant(() =>
      app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
        idempotencyKey: `b7-seed-${tag}`,
        sourceType: "b7-fixture",
        sourceId: tag,
        movements: [scene.variantId, scene.otherVariantId, scene.substituteVariantId].map(
          (productVariantId) => ({
            transactionType: "PURCHASE",
            productVariantId,
            locationId: scene.locationId,
            quantityDelta: "1000.0000",
            unitCost: "1.0000",
          }),
        ),
      }),
    );
  }, 300_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  describe("one Idempotency-Key ship call", () => {
    it("moves stock exactly once and marks shipment and order shipped", async () => {
      const soId = await createOrder([{ productVariantId: scene.variantId, quantity: 12 }]);
      const [line] = await soLines(soId);
      await asTenant(() =>
        ship().pickSo(
          scene.orgId,
          soId,
          scene.userId,
          { lines: [{ soLineId: line!.id, locationId: scene.locationId, quantityPicked: "12.0000" }] },
          `b7-pick-${soId}`,
        ),
      );

      const before = await buckets(scene.variantId);
      expect(before.committed).toBe(12);
      // Zero, and correctly so: `EXPECTED_OUTGOING` is the picked part a
      // reservation does *not* already cover, and this order's reservation still
      // covers all of it. `pickSo` does not consume reservations — only the wave
      // confirm path and shipping do — so the units are held once, not twice.
      expect(before.outgoing).toBe(0);

      const key = `b7-ship-${soId}`;
      const first = await asTenant(() =>
        ship().shipSo(scene.orgId, soId, scene.userId, key, { shipDate: "2026-08-29" }),
      );

      const afterFirst = await buckets(scene.variantId);
      expect(afterFirst.onHand).toBe(before.onHand - 12);
      // The tote empties and the hold is released together: nothing that shipped
      // is still standing on a bench or promised to anybody.
      expect(afterFirst.outgoing).toBe(0);
      expect(afterFirst.committed).toBe(before.committed - 12);
      expect((await soRow(soId)).status).toBe("SHIPPED");
      expect(await reservationStates(soId)).toEqual(["CONSUMED"]);
      await expectReconciled();

      // The retry. Same key, same request — a client that never saw the first
      // response, which is the one case idempotency exists for.
      const second = await asTenant(() =>
        ship().shipSo(scene.orgId, soId, scene.userId, key, { shipDate: "2026-08-29" }),
      );

      expect(second).toEqual(first);
      expect(await buckets(scene.variantId)).toEqual(afterFirst);
      // One shipment, one set of lines, one shipped quantity. Each of these was a
      // separate way the old code duplicated the dispatch.
      expect(await shipmentsFor(soId)).toHaveLength(1);
      expect(await shipmentLinesFor(soId)).toHaveLength(1);
      const [lineAfter] = await soLines(soId);
      expect(Number(lineAfter!.quantity_shipped)).toBe(12);
      await expectReconciled();
    }, 300_000);

    it("announces the dispatch once across the retry", async () => {
      const soId = await createOrder([{ productVariantId: scene.variantId, quantity: 3 }]);
      const [line] = await soLines(soId);
      await asTenant(() =>
        ship().pickSo(
          scene.orgId,
          soId,
          scene.userId,
          { lines: [{ soLineId: line!.id, locationId: scene.locationId, quantityPicked: "3.0000" }] },
          `b7-pick-evt-${soId}`,
        ),
      );

      const key = `b7-ship-evt-${soId}`;
      const shipOnce = () =>
        asTenant(() => ship().shipSo(scene.orgId, soId, scene.userId, key, { shipDate: "2026-08-29" }));
      const result = await shipOnce();
      await shipOnce();

      const dispatched = await asTenant(() =>
        outboxEventsFor(
          app.app.get<Db>(DRIZZLE),
          scene.orgId,
          INVENTORY_COMMAND_EVENTS.SHIPMENT_DISPATCHED,
          String(result.shipmentId),
        ),
      );
      expect(dispatched).toHaveLength(1);

      const fulfilled = await asTenant(() =>
        outboxEventsFor(
          app.app.get<Db>(DRIZZLE),
          scene.orgId,
          "inventory.sales_order.fulfilled",
          String(soId),
        ),
      );
      expect(fulfilled).toHaveLength(1);

      // Consuming a reservation is announced once per command, keyed on the
      // command's key — so a replay cannot claim to have consumed it again.
      const consumed = await asTenant(() =>
        outboxEventsFor(
          app.app.get<Db>(DRIZZLE),
          scene.orgId,
          INVENTORY_COMMAND_EVENTS.RESERVATION_CONSUMED,
          key,
        ),
      );
      expect(consumed).toHaveLength(1);
    }, 300_000);

    it("refuses the same key used for a different order", async () => {
      const soId = await createOrder([{ productVariantId: scene.variantId, quantity: 2 }]);
      const [line] = await soLines(soId);
      await asTenant(() =>
        ship().pickSo(
          scene.orgId,
          soId,
          scene.userId,
          { lines: [{ soLineId: line!.id, locationId: scene.locationId, quantityPicked: "2.0000" }] },
          `b7-pick-mix-${soId}`,
        ),
      );
      const key = `b7-ship-mix-${soId}`;
      await asTenant(() =>
        ship().shipSo(scene.orgId, soId, scene.userId, key, { shipDate: "2026-08-29" }),
      );

      const otherSo = await createOrder([{ productVariantId: scene.variantId, quantity: 2 }]);
      // A key is a promise about one request. Reusing it for another order is a
      // client bug, and answering the first order's result would be worse than
      // refusing.
      await expect(
        asTenant(() =>
          ship().shipSo(scene.orgId, otherSo, scene.userId, key, { shipDate: "2026-08-29" }),
        ),
      ).rejects.toThrow();
    }, 300_000);
  });

  describe("a mixed order — some lines picked, one substituted", () => {
    it("ships completely rather than going out PARTIALLY_SHIPPED", async () => {
      const soId = await createOrder([
        { productVariantId: scene.variantId, quantity: 4 },
        { productVariantId: scene.otherVariantId, quantity: 6 },
      ]);
      const lines = await soLines(soId);
      const orderedLine = lines.find((l) => Number(l.product_variant_id) === scene.variantId)!;
      const swappedLine = lines.find((l) => Number(l.product_variant_id) === scene.otherVariantId)!;

      const wave = await asTenant(() =>
        waves().createWave(scene.orgId, scene.userId, {
          warehouseId: scene.warehouseId,
          soIds: [soId],
        }),
      );
      const detail = await asTenant(() =>
        waves().getWave(scene.orgId, scene.userId, wave.pickListId),
      );
      const pickedTask = detail.lines.find(
        (l) => Number(l.so_line_id) === Number(orderedLine.id),
      )!;
      const swappedTask = detail.lines.find(
        (l) => Number(l.so_line_id) === Number(swappedLine.id),
      )!;

      await asTenant(() =>
        picks().confirmPick(
          scene.orgId,
          scene.userId,
          wave.pickListId,
          { pickLineId: Number(pickedTask.id), quantityPicked: "4.0000" },
          `b7-sub-pick-${soId}`,
        ),
      );
      await asTenant(() =>
        exceptions().reportException(
          scene.orgId,
          scene.userId,
          wave.pickListId,
          {
            pickLineId: Number(swappedTask.id),
            reason: "SUBSTITUTED",
            substituteVariantId: scene.substituteVariantId,
            quantityPicked: "6.0000",
          },
          `b7-sub-exc-${soId}`,
        ),
      );

      // B5 leaves `quantity_picked` at zero on a substituted line on purpose:
      // that column means how much of *this line's own* variant was picked, and
      // none of it was. The units in the tote are on the substitute columns.
      const beforeOrdered = await buckets(scene.variantId);
      const beforeOriginal = await buckets(scene.otherVariantId);
      const beforeSubstitute = await buckets(scene.substituteVariantId);
      // The substitution moved the promise: the original's reservation was
      // released and one for the substitute stands in its place, at the bin the
      // swapped units actually came off.
      expect(beforeSubstitute.committed).toBe(6);
      expect(beforeOriginal.committed).toBe(0);

      const result = await asTenant(() =>
        ship().shipSo(scene.orgId, soId, scene.userId, `b7-sub-ship-${soId}`, {
          shipDate: "2026-08-29",
        }),
      );

      // The whole order left the building, so the order says so. This is the
      // gap B5 handed over: the swapped line contributed no movement at all and
      // the order went out PARTIALLY_SHIPPED with the substitute still on the
      // shelf.
      expect(result.isPartial).toBe(false);
      expect(result.status).toBe("SHIPPED");
      expect((await soRow(soId)).status).toBe("SHIPPED");

      const afterOrdered = await buckets(scene.variantId);
      const afterOriginal = await buckets(scene.otherVariantId);
      const afterSubstitute = await buckets(scene.substituteVariantId);

      expect(afterOrdered.onHand).toBe(beforeOrdered.onHand - 4);
      // What actually went in the tote is what leaves the building.
      expect(afterSubstitute.onHand).toBe(beforeSubstitute.onHand - 6);
      // And the SKU the customer originally asked for is untouched: the
      // substitution rewrote the demand, it did not issue both.
      expect(afterOriginal.onHand).toBe(beforeOriginal.onHand);

      // The bucket empties at the substitute's grain. The old recompute walked
      // the *original* variant at the substitute's bin — a stock row that does
      // not exist — so these units stayed outgoing for ever.
      expect(afterSubstitute.outgoing).toBe(0);
      expect(afterOrdered.outgoing).toBe(0);
      expect(afterSubstitute.committed).toBe(beforeSubstitute.committed - 6);

      const shipped = await shipmentLinesFor(soId);
      expect(shipped).toHaveLength(2);
      expect(shipped.map((l) => Number(l.product_variant_id)).sort((a, b) => a - b)).toEqual(
        [scene.variantId, scene.substituteVariantId].sort((a, b) => a - b),
      );

      const finalLines = await soLines(soId);
      for (const line of finalLines)
        expect(Number(line.quantity_shipped)).toBe(Number(line.quantity));

      expect(await reservationStates(soId)).toEqual(
        expect.arrayContaining(["CONSUMED"]),
      );
      expect(await reservationStates(soId)).not.toContain("ACTIVE");
      await expectReconciled();
    }, 300_000);
  });

  describe("the carrier contract on a shipment this path raised", () => {
    let shipmentId: number;
    let tracking: string;

    beforeAll(async () => {
      const soId = await createOrder([{ productVariantId: scene.variantId, quantity: 5 }]);
      const [line] = await soLines(soId);
      await asTenant(() =>
        ship().pickSo(
          scene.orgId,
          soId,
          scene.userId,
          { lines: [{ soLineId: line!.id, locationId: scene.locationId, quantityPicked: "5.0000" }] },
          `b7-pick-carrier-${soId}`,
        ),
      );
      tracking = `B7-TRK-${randomUUID().slice(0, 8)}`;
      const result = await asTenant(() =>
        ship().shipSo(scene.orgId, soId, scene.userId, `b7-ship-carrier-${soId}`, {
          shipDate: "2026-08-29",
          trackingNumber: tracking,
        }),
      );
      shipmentId = result.shipmentId;
    }, 300_000);

    it("treats a duplicate carrier event id as a no-op", async () => {
      const event = {
        trackingNumber: tracking,
        status: "DELIVERED" as const,
        occurredAt: "2026-08-30T09:00:00.000Z",
        carrierEventId: `b7-evt-${shipmentId}`,
      };
      const first = await asTenant(() =>
        app.app.get(CarrierStatusService).recordEvent(scene.orgId, scene.userId, event),
      );
      expect(first).toEqual({ recorded: true, advanced: true, status: "DELIVERED" });

      // The same scan arriving twice is routine, not an error.
      const second = await asTenant(() =>
        app.app.get(CarrierStatusService).recordEvent(scene.orgId, scene.userId, event),
      );
      expect(second).toEqual({ recorded: false, advanced: false, status: "DELIVERED" });

      const timeline = await asTenant(() =>
        app.app.get(CarrierStatusService).timeline(scene.orgId, shipmentId),
      );
      expect(timeline.events).toHaveLength(1);
      expect(timeline.shipment.status).toBe("DELIVERED");
    }, 120_000);

    it("says there is nobody to ask rather than pretending to poll", async () => {
      // The manual adapter is the registered implementation, and this is the
      // truthful answer it gives — the one the shipment sheet renders instead of
      // "carrier integrations coming soon".
      const refreshed = await asTenant(() =>
        app.app.get(CarrierStatusService).refreshTracking(scene.orgId, scene.userId, shipmentId),
      );
      expect(refreshed).toEqual({
        shipmentId,
        carrier: "manual",
        polled: false,
        recorded: 0,
        status: "DELIVERED",
        deadLettered: false,
      });
    }, 120_000);
  });
});
