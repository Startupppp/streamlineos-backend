import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { StockProjectionService } from "src/modules/inventory/stock-engine/stock-projection.service";
import { InvStockService } from "src/modules/inventory/stock/inv-stock.service";
import { PoService } from "src/modules/inventory/purchase-orders/po.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * A1 — availability is one formula over one projection.
 *
 * There were six copies of this arithmetic, none of which subtracted
 * `outgoing_qty`, and the bucket itself had no writer — so stock standing on
 * the packing bench was offered to the next customer. These probes hold the
 * whole chain: the term is subtracted, the bucket is maintained, and goods on
 * order are visible without being promisable.
 */
interface Scene {
  orgId: string;
  userId: string;
  variantId: number;
  warehouseId: number;
  locationId: number;
  vendorId: number;
}

describe("[seeded-e2e] available to promise", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  /** Availability the way the stock list reports it. */
  const availability = async () => {
    const result = await asTenant(() =>
      app.app
        .get(InvStockService)
        .getAvailability(scene.orgId, scene.userId, {
          variantId: scene.variantId,
        } as never),
    );
    const typed = result as { onHand: unknown; available: unknown };
    // The service returns decimal strings for on_hand and a number for
    // available; normalise here so the assertions are about the arithmetic
    // rather than about representation.
    return { onHand: Number(typed.onHand), available: Number(typed.available) };
  };

  const buckets = async () => {
    const [row] = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{
        committed: string;
        outgoing_qty: string;
        on_order: string;
      }>(sql`
        SELECT COALESCE(SUM(committed), 0)::text AS committed,
               COALESCE(SUM(COALESCE(outgoing_qty, 0)), 0)::text AS outgoing_qty,
               COALESCE(SUM(COALESCE(on_order, 0)), 0)::text AS on_order
        FROM inv_stock_levels
        WHERE org_id = ${scene.orgId} AND product_variant_id = ${scene.variantId}`),
    );
    return row!;
  };

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("keeper", {
        permissionKeys: [
          "inventory:warehouses:scope-all",
          "inventory:stock:read",
          "inventory:stock:adjust",
          "inventory:purchase-orders:create",
        ],
      })
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
        VALUES (${seeded.orgId}, ${uom.id}, 'Promised goods', ${`AT-${tag}`}, ${userId})
        RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`AT-${tag}-V`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Main', ${`MN${tag}`}, ${userId}) RETURNING id`);
      const location = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Bin', ${`B${tag}`}, 'BIN', true) RETURNING id`);
      const vendor = await one<{ id: number }>(sql`
        INSERT INTO inv_vendors (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Supplier', ${`VN${tag}`}, ${userId}) RETURNING id`);
      return {
        orgId: seeded.orgId,
        userId,
        variantId: variant.id,
        warehouseId: warehouse.id,
        locationId: location.id,
        vendorId: vendor.id,
      };
    });

    await asTenant(() =>
      app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
        idempotencyKey: `atp-seed-${tag}`,
        sourceType: "atp-fixture",
        sourceId: tag,
        movements: [
          {
            transactionType: "PURCHASE",
            productVariantId: scene.variantId,
            locationId: scene.locationId,
            quantityDelta: "100.0000",
            unitCost: "1.0000",
          },
        ],
      }),
    );
  }, 300_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  it("starts with everything available", async () => {
    // The control: every reduction below is only meaningful against this.
    const { onHand, available } = await availability();
    expect(onHand).toBe(100);
    expect(available).toBe(100);
  });

  it("stops promising stock that has been picked but not shipped", async () => {
    // The defect this unit exists to close. `outgoing_qty` was in the formula
    // in one place and in no query, and nothing ever wrote it -- so goods on
    // the packing bench were offered to the next customer. Nothing is reserved
    // on this fixture, so the whole pick is uncovered and lands in the bucket.
    await asTenant(() =>
      app.app
        .get(StockProjectionService)
        .recordPicked(
          app.app.get<Db>(DRIZZLE) as never,
          scene.orgId,
          scene.variantId,
          scene.locationId,
          "30.0000",
        ),
    );

    const after = await buckets();
    expect(Number(after.outgoing_qty)).toBe(30);

    const { onHand, available } = await availability();
    // The goods are still physically here...
    expect(onHand).toBe(100);
    // ...and no longer promisable.
    expect(available).toBe(70);
  });

  it("gives the stock back when it ships", async () => {
    await asTenant(() =>
      app.app
        .get(StockProjectionService)
        .shipOutgoing(
          app.app.get<Db>(DRIZZLE) as never,
          scene.orgId,
          scene.variantId,
          scene.locationId,
          "30.0000",
        ),
    );
    expect(Number((await buckets()).outgoing_qty)).toBe(0);
    expect((await availability()).available).toBe(100);
  });

  it("counts a sent purchase order as on order without promising it", async () => {
    // Goods on order are not in the building. Replenishment must see them --
    // otherwise it orders the same shortfall every week -- but availability
    // must not.
    const po = await asTenant(() =>
      app.app.get(PoService).createPo(scene.orgId, scene.userId, {
        vendorId: scene.vendorId,
        orderDate: "2026-08-28",
        warehouseId: scene.warehouseId,
        currency: "INR",
        lines: [
          {
            productVariantId: scene.variantId,
            quantity: 25,
            unitCost: "1.0000",
            taxRate: "0",
            lineOrder: 0,
          },
        ],
      }),
    );
    await asTenant(() =>
      app.app.get(PoService).sendPo(scene.orgId, (po as { id: number }).id, scene.userId),
    );

    expect(Number((await buckets()).on_order)).toBe(25);
    // Unchanged: on_order is not one of availability's terms.
    expect((await availability()).available).toBe(100);
  });
});
