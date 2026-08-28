import { randomUUID } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { PutawayService } from "src/modules/inventory/warehouses/putaway.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * INV-202 — location capacity, which the warehouse editor has always been able
 * to set and nothing has ever read.
 *
 * Two halves. The engine refuses a movement that would overfill a bin, because
 * a capacity nothing enforces is a note rather than a constraint. And putaway
 * suggests where the goods will actually fit, because an operator who walks to
 * a bin only to have the putaway refused has been sent on an errand by the
 * system that then declined it.
 */
const PERMISSIONS = [
  "inventory:warehouses:scope-all",
  "inventory:stock:read",
  "inventory:stock:adjust",
] as const;

interface Scene {
  orgId: string;
  userId: string;
  variantId: number;
  otherVariantId: number;
  warehouseId: number;
  smallBin: number;
  bigBin: number;
  unlimitedBin: number;
}

describe("[seeded-e2e] putaway and location capacity", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  const put = (locationId: number, qty: string, variantId?: number) =>
    asTenant(() =>
      app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
        idempotencyKey: `put-${randomUUID()}`,
        sourceType: "putaway-test",
        sourceId: "1",
        movements: [
          {
            transactionType: "PURCHASE",
            productVariantId: variantId ?? scene.variantId,
            locationId,
            quantityDelta: qty,
            unitCost: "1.0000",
          },
        ],
      }),
    );

  const suggest = (qty: string) =>
    asTenant(() =>
      app.app.get(PutawayService).suggest(scene.orgId, scene.userId, {
        warehouseId: scene.warehouseId,
        productVariantId: scene.variantId,
        quantity: qty,
      }),
    );

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
        VALUES (${seeded.orgId}, ${uom.id}, 'Bin goods', ${`PA-${tag}`}, ${userId}) RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`PA-${tag}-V`}) RETURNING id`);
      const other = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Other', ${`PA-${tag}-V2`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Main', ${`MN${tag}`}, ${userId}) RETURNING id`);

      const bin = async (code: string, capacity: string | null) =>
        (
          await one<{ id: number }>(sql`
            INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, capacity, is_receivable)
            VALUES (${seeded.orgId}, ${warehouse.id}, ${code}, ${`${code}${tag}`}, 'BIN', ${capacity}, true)
            RETURNING id`)
        ).id;

      return {
        orgId: seeded.orgId,
        userId,
        variantId: variant.id,
        otherVariantId: other.id,
        warehouseId: warehouse.id,
        smallBin: await bin("SMALL", "10.0000"),
        bigBin: await bin("BIG", "500.0000"),
        unlimitedBin: await bin("FREE", null),
      };
    });
  }, 240_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  describe("the engine enforces capacity", () => {
    it("accepts a quantity that fits exactly", async () => {
      // The boundary, and the control: every refusal below is only meaningful
      // because a bin can be filled to the brim.
      await expect(put(scene.smallBin, "10.0000")).resolves.toBeDefined();
    });

    it("refuses the unit that would overfill the bin", async () => {
      await expect(put(scene.smallBin, "0.0001")).rejects.toThrow(BadRequestException);
    });

    it("counts every variant in the bin, not just the one arriving", async () => {
      // Capacity is a property of the shelf, not of a SKU. A second product
      // must not get its own allowance for the same cubic metre.
      await expect(put(scene.smallBin, "1.0000", scene.otherVariantId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("leaves a location with no recorded capacity unlimited", async () => {
      // Most warehouses record capacity on few bins, so the unmeasured case is
      // the common one and must stay free.
      await expect(put(scene.unlimitedBin, "999999.0000")).resolves.toBeDefined();
    });
  });

  describe("putaway suggests where it will fit", () => {
    it("puts the bins the quantity fits in ahead of the ones it does not", async () => {
      const suggestions = await suggest("100.0000");
      const fits = suggestions.filter((s) => s.fits).map((s) => s.name);
      const doesNot = suggestions.filter((s) => !s.fits).map((s) => s.name);

      // SMALL is full from the probes above, so 100 cannot go there.
      expect(doesNot).toContain("SMALL");
      expect(fits).toEqual(expect.arrayContaining(["BIG", "FREE"]));
      // Ordering, not just membership: a suggestion list is read top-down.
      expect(suggestions.findIndex((s) => s.name === "SMALL")).toBeGreaterThan(
        suggestions.findIndex((s) => s.name === "BIG"),
      );
    });

    it("prefers a bin already holding the variant, so a SKU does not scatter", async () => {
      // BIG has none of this variant yet; give it some and it should rise above
      // the equally-capable empty bin.
      await put(scene.bigBin, "5.0000");
      const suggestions = await suggest("1.0000");
      const holder = suggestions.find((s) => s.holdsVariant);
      expect(holder?.name).toBe("BIG");
      expect(suggestions[0]!.name).toBe("BIG");
    });

    it("reports remaining room, and reports unlimited as unlimited", async () => {
      const suggestions = await suggest("1.0000");
      const small = suggestions.find((s) => s.name === "SMALL")!;
      const free = suggestions.find((s) => s.name === "FREE")!;

      expect(small.capacity).toBe("10.0000");
      expect(Number(small.remaining)).toBe(0);
      // Not "very large" -- absent, so an unmeasured bin cannot outrank every
      // measured one by accident.
      expect(free.capacity).toBeNull();
      expect(free.remaining).toBeNull();
    });
  });
});
