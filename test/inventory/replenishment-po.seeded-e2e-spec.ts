import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { InvReplenishmentService } from "src/modules/inventory/replenishment/inv-replenishment.service";
import { generatePoSchema } from "src/modules/inventory/replenishment/dto/replenishment.schemas";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * C2 — the server decides how much to order.
 *
 * `generatePo` took the quantity straight from the request body, so a modified
 * payload produced a purchase order for any amount, and no supplier minimum or
 * pack size was applied — the numbers vendors received were frequently ones they
 * would reject. The client now names *which* variants; it does not name how many.
 *
 * This is the unit's "Done when", asserted rather than asserted-about: changing
 * the client payload quantity cannot change the resulting PO quantity.
 */
interface Scene {
  orgId: string;
  userId: string;
  variantId: number;
  warehouseId: number;
  locationId: number;
  vendorId: number;
  productId: number;
}

describe("[seeded-e2e] the server owns the purchase-order quantity", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  const db = () => app.app.get<Db>(DRIZZLE);

  /**
   * The client's payload, through the endpoint's own schema.
   *
   * C2 made "the quantity is ignored" structural rather than remembered:
   * `generatePoSchema` drops `suggestedQty`, so the service is handed a value
   * that has no such field. Parsing here rather than hand-building the input is
   * what makes this a test of the real boundary instead of a test of a
   * convention the service could quietly stop honouring.
   */
  const generate = (suggestedQty: number) =>
    asTenant(() =>
      app.app.get(InvReplenishmentService).generatePo(
        scene.orgId,
        scene.userId,
        generatePoSchema.parse({
          vendorId: scene.vendorId,
          warehouseId: scene.warehouseId,
          suggestions: [
            { productVariantId: scene.variantId, suggestedQty, unitCost: 10 },
          ],
        }),
        `genpo-${randomUUID().slice(0, 8)}`,
      ),
    );

  const lineQtyFor = async (poId: number) => {
    const [row] = await asTenant(() =>
      db().execute<{ quantity: string }>(sql`
        SELECT quantity::text FROM inv_po_lines
        WHERE org_id = ${scene.orgId} AND po_id = ${poId}`),
    );
    return Number(row!.quantity);
  };

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("planner", {
        permissionKeys: [
          "inventory:warehouses:scope-all",
          "inventory:stock:read",
          "inventory:stock:adjust",
          "inventory:products:read",
          "inventory:purchase-orders:create",
          "inventory:replenishment:manage",
        ],
      })
      .build();
    teardown = () => seeded.teardown();

    const tag = randomUUID().slice(0, 6);
    scene = await runInNewTenantTransaction(db(), seeded.orgId, async () => {
      const userId = seeded.members["planner"]!.userId;
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db().execute<T>(q))[0]!;
      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      // A reorder point well above stock, so the engine always has a shortfall
      // to propose — the case where the client's number could be believed.
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, reorder_point, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Replenishable', ${`RP-${tag}`}, 100, ${userId})
        RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`RP-${tag}-V`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Main', ${`PW${tag}`}, ${userId}) RETURNING id`);
      const location = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Bin', ${`PB${tag}`}, 'BIN', true) RETURNING id`);
      const vendor = await one<{ id: number }>(sql`
        INSERT INTO inv_vendors (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Supplier', ${`PV${tag}`}, ${userId}) RETURNING id`);
      // The suggestion engine reads `inv_reorder_rules`, not the product's own
      // reorder point — a min/max policy per (variant, warehouse). Without a
      // rule there is no proposal to compare a client's number against.
      await db().execute(sql`
        INSERT INTO inv_reorder_rules
          (org_id, product_variant_id, warehouse_id, min_qty, max_qty, reorder_qty, vendor_id, is_active)
        VALUES (${seeded.orgId}, ${variant.id}, ${warehouse.id}, 100, 200, 50, ${vendor.id}, true)`);
      return {
        orgId: seeded.orgId,
        userId,
        variantId: variant.id,
        warehouseId: warehouse.id,
        locationId: location.id,
        vendorId: vendor.id,
        productId: product.id,
      };
    });

    await asTenant(() =>
      app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
        idempotencyKey: `rp-seed-${tag}`,
        sourceType: "replenishment-fixture",
        sourceId: tag,
        movements: [
          {
            transactionType: "PURCHASE",
            productVariantId: scene.variantId,
            locationId: scene.locationId,
            quantityDelta: "10.0000",
            unitCost: "5.0000",
          },
        ],
      }),
    );
  }, 300_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app?.close();
  }, 120_000);

  it("orders the same quantity however much the client asks for", async () => {
    // Two requests, identical but for the quantity the client claims it wants.
    // Before C2 these produced two different purchase orders.
    const honest = await generate(90);
    const tampered = await generate(999_999);

    const honestQty = await lineQtyFor((honest as { id: number }).id);
    const tamperedQty = await lineQtyFor((tampered as { id: number }).id);

    expect(tamperedQty).toBe(honestQty);
    // And it is the engine's own answer, not either client's.
    expect(honestQty).toBeGreaterThan(0);
  });

  it("applies the supplier's pack size to the server's own number", async () => {
    // A vendor who ships in cases of 12 is sent a multiple of 12, whatever the
    // shortfall works out to and whatever the client asked for.
    await asTenant(() =>
      db().execute(sql`
        UPDATE inv_products SET order_multiple = 12, min_order_qty = 24
        WHERE org_id = ${scene.orgId} AND id = ${scene.productId}`),
    );

    const po = await generate(1);
    const qty = await lineQtyFor((po as { id: number }).id);

    expect(qty % 12).toBe(0);
    expect(qty).toBeGreaterThanOrEqual(24);
  });

  it("refuses to order a variant whose shortfall has already been met", async () => {
    // Fill the shelf well past the reorder point. The engine has nothing to
    // propose, and a client insisting otherwise is not a reason to buy stock.
    await asTenant(() =>
      app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
        idempotencyKey: `rp-fill-${randomUUID().slice(0, 8)}`,
        sourceType: "replenishment-fixture",
        sourceId: "fill",
        movements: [
          {
            transactionType: "PURCHASE",
            productVariantId: scene.variantId,
            locationId: scene.locationId,
            quantityDelta: "5000.0000",
            unitCost: "5.0000",
          },
        ],
      }),
    );

    await expect(generate(500)).rejects.toThrow(/still need ordering|already been met/i);
  });
});
