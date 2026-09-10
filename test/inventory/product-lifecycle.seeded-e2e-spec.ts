import { randomUUID } from "node:crypto";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { SoCoreService } from "src/modules/inventory/sales-orders/so-core.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * INV-107 — a product's lifecycle has to mean something to new demand.
 *
 * `DISCONTINUED` was accepted by the DTO, written to the row, and read by
 * nothing: the SKU stayed as sellable as any other. These probes hold the
 * catalogue to its own status, and -- just as importantly -- hold the line at
 * *new* demand, because retroactively invalidating orders already taken would
 * be a worse bug than the one being fixed.
 */
const PERMISSIONS = [
  "inventory:warehouses:scope-all",
  "inventory:products:read",
  "inventory:products:update",
  "inventory:sales-orders:read",
  "inventory:sales-orders:create",
] as const;

interface Scene {
  orgId: string;
  userId: string;
  productId: number;
  variantId: number;
  warehouseId: number;
}

describe("[seeded-e2e] product lifecycle and new demand", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let otherOrgVariantId: number;
  let teardown: () => Promise<void>;
  let teardownOther: () => Promise<void>;

  const so = () => app.app.get(SoCoreService);
  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  const newOrder = () =>
    asTenant(() =>
      so().createSo(scene.orgId, scene.userId, {
        orderDate: "2026-08-28",
        currency: "INR",
        warehouseId: scene.warehouseId,
        lines: [
          {
            productVariantId: scene.variantId,
            quantity: 1,
            unitPrice: "10.0000",
            taxRate: "0",
            lineOrder: 0,
          },
        ],
      }),
    );

  async function setProductStatus(status: string): Promise<void> {
    const db = app.app.get<Db>(DRIZZLE);
    await runInNewTenantTransaction(db, scene.orgId, async () => {
      await db.execute(sql`
        UPDATE inv_products SET status = ${status}::inv_product_status
         WHERE id = ${scene.productId} AND org_id = ${scene.orgId}`);
    });
  }

  async function setVariantActive(active: boolean): Promise<void> {
    const db = app.app.get<Db>(DRIZZLE);
    await runInNewTenantTransaction(db, scene.orgId, async () => {
      await db.execute(sql`
        UPDATE inv_product_variants SET is_active = ${active}
         WHERE id = ${scene.variantId} AND org_id = ${scene.orgId}`);
    });
  }

  async function seedCatalogue(orgId: string, userId: string) {
    const db = app.app.get<Db>(DRIZZLE);
    const tag = randomUUID().slice(0, 6);
    return runInNewTenantTransaction(db, orgId, async () => {
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db.execute<T>(q))[0]!;
      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
        VALUES (${orgId}, ${uom.id}, 'Lifecycle widget', ${`LC-${tag}`}, ${userId})
        RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${orgId}, ${product.id}, 'Default', ${`LC-${tag}-V1`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${orgId}, 'Main', ${`MN${tag}`}, ${userId}) RETURNING id`);
      return {
        productId: product.id,
        variantId: variant.id,
        warehouseId: warehouse.id,
      };
    });
  }

  beforeAll(async () => {
    app = await createSeededE2eApp();

    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("seller", { permissionKeys: PERMISSIONS })
      .build();
    teardown = () => seeded.teardown();
    const userId = seeded.members["seller"]!.userId;
    const catalogue = await seedCatalogue(seeded.orgId, userId);
    scene = { orgId: seeded.orgId, userId, ...catalogue };

    // A second tenant, so "belongs to another organisation" is a real row
    // rather than an id that simply does not exist anywhere.
    const other = await seedOrg(app.seedDb).onPlan("PAID").addMember("other").build();
    teardownOther = () => other.teardown();
    const otherCatalogue = await seedCatalogue(
      other.orgId,
      other.members["other"]!.userId,
    );
    otherOrgVariantId = otherCatalogue.variantId;
  }, 240_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await teardownOther?.().catch(() => undefined);
    await app.close();
  });

  it("accepts an order for an active product", async () => {
    // The control. Every refusal below is only meaningful because this passes
    // against the same fixture.
    await setProductStatus("ACTIVE");
    await setVariantActive(true);
    await expect(newOrder()).resolves.toBeDefined();
  });

  it("refuses new demand for a discontinued product", async () => {
    await setProductStatus("DISCONTINUED");
    await expect(newOrder()).rejects.toThrow(ConflictException);
  });

  it("refuses new demand for an inactive product", async () => {
    await setProductStatus("INACTIVE");
    await expect(newOrder()).rejects.toThrow(ConflictException);
  });

  it("refuses new demand for an inactive variant of an active product", async () => {
    // The variant carries its own lifecycle, so an active parent must not
    // launder a retired variant.
    await setProductStatus("ACTIVE");
    await setVariantActive(false);
    await expect(newOrder()).rejects.toThrow(ConflictException);
  });

  it("leaves orders already taken untouched when the product is discontinued", async () => {
    // The important half. Goods already promised still have to ship, and the
    // ledger still has to explain itself -- retroactive invalidation would be
    // a worse defect than the one this ticket fixes.
    await setProductStatus("ACTIVE");
    await setVariantActive(true);
    const existing = (await newOrder()) as { id: number };

    await setProductStatus("DISCONTINUED");

    const stillThere = await asTenant(() => so().getSo(scene.orgId, scene.userId, existing.id));
    expect(stillThere).toBeDefined();
    expect((stillThere as { id: number }).id).toBe(existing.id);
  });

  it("orders again once the product is reactivated", async () => {
    // Discontinuing is reversible, and the gate must not be one-way.
    await setProductStatus("ACTIVE");
    await setVariantActive(true);
    await expect(newOrder()).resolves.toBeDefined();
  });

  it("refuses a variant belonging to another organisation as not found", async () => {
    // This looked variants up by id alone, so another tenant's row resolved
    // and only RLS stood between it and an order line. 404 rather than 403:
    // a 403 on another tenant's id confirms the row exists.
    await expect(
      asTenant(() =>
        so().createSo(scene.orgId, scene.userId, {
          orderDate: "2026-08-28",
          currency: "INR",
          warehouseId: scene.warehouseId,
          lines: [
            {
              productVariantId: otherOrgVariantId,
              quantity: 1,
              unitPrice: "10.0000",
              taxRate: "0",
              lineOrder: 0,
            },
          ],
        }),
      ),
    ).rejects.toThrow(NotFoundException);
  });
});
