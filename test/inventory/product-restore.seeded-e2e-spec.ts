import { randomUUID } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { InvProductCrudService } from "src/modules/inventory/products/inv-product-crud.service";
import { PoService } from "src/modules/inventory/purchase-orders/po.service";
import { InvStockTransfersService } from "src/modules/inventory/stock/inv-stock-transfers.service";
import { InvStockAdjustmentsService } from "src/modules/inventory/stock/inv-stock-adjustments.service";
import { InvStockReservationsService } from "src/modules/inventory/stock/inv-stock-reservations.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * A4 — a product can come back, and a retired one cannot be ordered.
 *
 * Two defects. `restoreProduct` loaded its row with `deleted_at IS NULL`, so the
 * one state it could not find was the deleted one: the endpoint whose only
 * purpose is to undo a soft delete answered 404 to every soft-deleted product.
 * And the lifecycle gate that stops a discontinued SKU being *sold* was wired to
 * sales orders alone, so the same SKU could be purchased from a supplier, moved
 * between warehouses, or reserved by hand without complaint.
 *
 * The gate is deliberately two policies rather than one. Correcting the record —
 * an adjustment, an opening balance — must keep working on a discontinued SKU,
 * because writing off retired stock is the main thing anyone does with it.
 */
interface Scene {
  orgId: string;
  userId: string;
  productId: number;
  variantId: number;
  sku: string;
  warehouseId: number;
  locationId: number;
  otherLocationId: number;
  vendorId: number;
}

describe("[seeded-e2e] product restore and retired-SKU demand", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;
  let tag: string;

  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  const products = () => app.app.get(InvProductCrudService);
  const db = () => app.app.get<Db>(DRIZZLE);

  const productRow = async (productId: number) => {
    const [row] = await asTenant(() =>
      db().execute<{ status: string; deleted_at: string | null; live_variants: string }>(sql`
        SELECT p.status, p.deleted_at::text AS deleted_at,
               (SELECT count(*)::text FROM inv_product_variants v
                 WHERE v.product_id = p.id AND v.deleted_at IS NULL) AS live_variants
        FROM inv_products p WHERE p.org_id = ${scene.orgId} AND p.id = ${productId}`),
    );
    return row!;
  };

  const setStatus = (status: string) =>
    asTenant(() =>
      db().execute(sql`
        UPDATE inv_products SET status = ${status}::inv_product_status
        WHERE org_id = ${scene.orgId} AND id = ${scene.productId}`),
    );

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("keeper", {
        permissionKeys: [
          "inventory:warehouses:scope-all",
          "inventory:products:read",
          "inventory:products:update",
          "inventory:products:delete",
          "inventory:stock:read",
          "inventory:stock:adjust",
          "inventory:stock:reserve",
          "inventory:stock:transfer",
          "inventory:purchase-orders:create",
        ],
      })
      .build();
    teardown = () => seeded.teardown();

    tag = randomUUID().slice(0, 6);
    scene = await runInNewTenantTransaction(db(), seeded.orgId, async () => {
      const userId = seeded.members["keeper"]!.userId;
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db().execute<T>(q))[0]!;
      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const sku = `RS-${tag}`;
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Retirable goods', ${sku}, ${userId}) RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`${sku}-V`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Main', ${`RW${tag}`}, ${userId}) RETURNING id`);
      const location = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Bin', ${`RB${tag}`}, 'BIN', true) RETURNING id`);
      const other = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Bin2', ${`RC${tag}`}, 'BIN', true) RETURNING id`);
      const vendor = await one<{ id: number }>(sql`
        INSERT INTO inv_vendors (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Supplier', ${`RV${tag}`}, ${userId}) RETURNING id`);
      return {
        orgId: seeded.orgId,
        userId,
        productId: product.id,
        variantId: variant.id,
        sku,
        warehouseId: warehouse.id,
        locationId: location.id,
        otherLocationId: other.id,
        vendorId: vendor.id,
      };
    });
  }, 300_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app?.close();
  }, 120_000);

  afterEach(async () => {
    // Every case starts from a live product, whatever the last one did to it.
    await asTenant(() =>
      db().execute(sql`
        UPDATE inv_products SET status = 'ACTIVE', deleted_at = NULL
        WHERE org_id = ${scene.orgId} AND id = ${scene.productId}`),
    );
    await asTenant(() =>
      db().execute(sql`
        UPDATE inv_product_variants SET deleted_at = NULL
        WHERE org_id = ${scene.orgId} AND product_id = ${scene.productId}`),
    );
  });

  it("deletes a product with no stock, then brings it and its variants back", async () => {
    await asTenant(() => products().deleteProduct(scene.orgId, scene.productId, scene.userId));

    const deleted = await productRow(scene.productId);
    expect(deleted.deleted_at).not.toBeNull();
    expect(Number(deleted.live_variants)).toBe(0);

    // Before A4 this answered 404: restore looked for a row with no deleted_at.
    await asTenant(() => products().restoreProduct(scene.orgId, scene.productId, scene.userId));

    const restored = await productRow(scene.productId);
    expect(restored.deleted_at).toBeNull();
    expect(restored.status).toBe("ACTIVE");
    // A product whose variants are still deleted is a catalogue entry nobody
    // can order, which is a restore in name only.
    expect(Number(restored.live_variants)).toBe(1);
  });

  it("refuses to restore onto a SKU somebody else has taken", async () => {
    await asTenant(() => products().deleteProduct(scene.orgId, scene.productId, scene.userId));

    // SKU uniqueness is a partial index over live rows, so the deleted SKU is
    // free — and reusing it is the normal reason a product was deleted.
    const squatter = await asTenant(async () => {
      const [uom] = await db().execute<{ uom_id: number }>(sql`
        SELECT uom_id FROM inv_products WHERE org_id = ${scene.orgId} AND id = ${scene.productId}`);
      const [row] = await db().execute<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
        VALUES (${scene.orgId}, ${uom!.uom_id}, 'Replacement', ${scene.sku}, ${scene.userId})
        RETURNING id`);
      return row!.id;
    });

    await expect(
      asTenant(() => products().restoreProduct(scene.orgId, scene.productId, scene.userId)),
    ).rejects.toThrow(/now belongs to another product/i);

    // And it said so rather than failing on the index.
    await expect(
      asTenant(() => products().restoreProduct(scene.orgId, scene.productId, scene.userId)),
    ).rejects.toBeInstanceOf(ConflictException);

    await asTenant(() =>
      db().execute(sql`DELETE FROM inv_products WHERE org_id = ${scene.orgId} AND id = ${squatter}`),
    );
  });

  it("refuses a discontinued SKU on every path that creates new demand", async () => {
    await setStatus("DISCONTINUED");
    const key = () => `retired-${randomUUID().slice(0, 8)}`;

    // Buying more of something you have retired.
    await expect(
      asTenant(() =>
        app.app.get(PoService).createPo(scene.orgId, scene.userId, {
          vendorId: scene.vendorId,
          orderDate: "2026-08-01",
          warehouseId: scene.warehouseId,
          currency: "INR",
          lines: [{ productVariantId: scene.variantId, quantity: 5, unitCost: "10.0000", taxRate: "0", lineOrder: 0 }],
        } as never),
      ),
    ).rejects.toThrow(/can no longer be ordered/i);

    // Moving it across the estate is new work on it too.
    await expect(
      asTenant(() =>
        app.app.get(InvStockTransfersService).createTransfer(scene.orgId, scene.userId, {
          fromLocationId: scene.locationId,
          toLocationId: scene.otherLocationId,
          lines: [{ productVariantId: scene.variantId, quantity: 1 }],
        } as never),
      ),
    ).rejects.toThrow(/can no longer be ordered/i);

    // Promising it to somebody by hand.
    await expect(
      asTenant(() =>
        app.app.get(InvStockReservationsService).createReservation(
          scene.orgId,
          scene.userId,
          {
            sourceType: "manual",
            sourceId: "retired",
            productVariantId: scene.variantId,
            locationId: scene.locationId,
            qty: "1.0000",
          } as never,
          key(),
        ),
      ),
    ).rejects.toThrow(/can no longer be ordered/i);
  });

  it("still lets a discontinued SKU be written off, because that is what retiring means", async () => {
    // There has to be something on the shelf to write off; the point of the
    // case is that retiring the product does not make those units unwritable.
    await asTenant(() =>
      app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
        idempotencyKey: `writeoff-seed-${randomUUID().slice(0, 8)}`,
        sourceType: "restore-fixture",
        sourceId: tag,
        movements: [
          {
            transactionType: "PURCHASE",
            productVariantId: scene.variantId,
            locationId: scene.locationId,
            quantityDelta: "5.0000",
            unitCost: "1.0000",
          },
        ],
      }),
    );

    await setStatus("DISCONTINUED");

    // The correction gate, not the demand gate. Refusing this would leave the
    // record permanently unable to describe a shelf that still holds stock.
    await expect(
      asTenant(() =>
        app.app.get(InvStockAdjustmentsService).createAdjustment(
          scene.orgId,
          scene.userId,
          {
            reason: "DAMAGE",
            lines: [
              { productVariantId: scene.variantId, locationId: scene.locationId, quantityChange: -1 },
            ],
          } as never,
          `writeoff-${randomUUID().slice(0, 8)}`,
        ),
      ),
    ).resolves.toBeDefined();
  });

  it("refuses to adjust a product that has been deleted from the catalogue", async () => {
    // Its own product: `deleteProduct` refuses while any stock or open document
    // exists, and the write-off case above leaves both behind on the shared one.
    const throwaway = await asTenant(async () => {
      const suffix = randomUUID().slice(0, 6);
      const [uom] = await db().execute<{ uom_id: number }>(sql`
        SELECT uom_id FROM inv_products WHERE org_id = ${scene.orgId} AND id = ${scene.productId}`);
      const [product] = await db().execute<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
        VALUES (${scene.orgId}, ${uom!.uom_id}, 'Throwaway', ${`TW-${suffix}`}, ${scene.userId})
        RETURNING id`);
      const [variant] = await db().execute<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${scene.orgId}, ${product!.id}, 'Default', ${`TW-${suffix}-V`}) RETURNING id`);
      return { productId: product!.id, variantId: variant!.id };
    });

    await asTenant(() => products().deleteProduct(scene.orgId, throwaway.productId, scene.userId));

    await expect(
      asTenant(() =>
        app.app.get(InvStockAdjustmentsService).createAdjustment(
          scene.orgId,
          scene.userId,
          {
            reason: "DAMAGE",
            lines: [
              { productVariantId: throwaway.variantId, locationId: scene.locationId, quantityChange: 1 },
            ],
          } as never,
          `deleted-adj-${randomUUID().slice(0, 8)}`,
        ),
      ),
    ).rejects.toThrow(/No such product variant|can no longer be adjusted/i);
  });
});
