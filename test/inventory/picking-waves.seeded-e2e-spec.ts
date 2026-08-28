import { randomUUID } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { SoCoreService } from "src/modules/inventory/sales-orders/so-core.service";
import { SoLifecycleService } from "src/modules/inventory/sales-orders/so-lifecycle.service";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { PickWaveService } from "src/modules/inventory/picking/pick-wave.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * INV-204 — picking waves.
 *
 * The existing pick path records what was picked, one order at a time, after
 * the fact. A picker walking the same aisle four times because four orders each
 * wanted one item from it is the cost this ticket removes.
 *
 * This suite also proves the new module boots. A service whose module never
 * imported the provider it injects type-checks perfectly and fails only at
 * runtime, which this repository has shipped before.
 */
const PERMISSIONS = [
  "inventory:warehouses:scope-all",
  "inventory:stock:read",
  "inventory:stock:adjust",
  "inventory:sales-orders:create",
  "inventory:sales-orders:read",
  "inventory:sales-orders:confirm",
  "inventory:sales-orders:ship",
] as const;

interface Scene {
  orgId: string;
  userId: string;
  variantId: number;
  variantSku: string;
  substituteVariantId: number;
  retiredProductId: number;
  retiredVariantId: number;
  warehouseId: number;
  locationId: number;
}

describe("[seeded-e2e] picking waves", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  async function confirmedOrder(qty: number): Promise<number> {
    const so = await asTenant(() =>
      app.app.get(SoCoreService).createSo(scene.orgId, scene.userId, {
        orderDate: "2026-08-28",
        currency: "INR",
        warehouseId: scene.warehouseId,
        lines: [
          {
            productVariantId: scene.variantId,
            quantity: qty,
            unitPrice: "10.0000",
            taxRate: "0",
            lineOrder: 0,
          },
        ],
      }),
    );
    const id = (so as { id: number }).id;
    await asTenant(() =>
      app.app.get(SoLifecycleService).confirmSo(scene.orgId, id, scene.userId),
    );
    return id;
  }

  const waves = () => app.app.get(PickWaveService);

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("picker", { permissionKeys: PERMISSIONS })
      .build();
    teardown = () => seeded.teardown();

    const tag = randomUUID().slice(0, 6);
    const db = app.app.get<Db>(DRIZZLE);
    scene = await runInNewTenantTransaction(db, seeded.orgId, async () => {
      const userId = seeded.members["picker"]!.userId;
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db.execute<T>(q))[0]!;
      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Picked goods', ${`PK-${tag}`}, ${userId})
        RETURNING id`);
      const sku = `PK-${tag}-V`;
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${sku}) RETURNING id`);
      const substitute = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Substitute', ${`${sku}-SUB`}) RETURNING id`);
      const retiredProduct = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, status, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Retired goods', ${`PK-${tag}-R`}, 'DISCONTINUED', ${userId})
        RETURNING id`);
      const retiredVariant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${retiredProduct.id}, 'Retired', ${`PK-${tag}-RV`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Main', ${`MN${tag}`}, ${userId}) RETURNING id`);
      const location = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Bin', ${`B1${tag}`}, 'BIN') RETURNING id`);
      return {
        orgId: seeded.orgId,
        userId,
        variantId: variant.id,
        variantSku: sku,
        substituteVariantId: substitute.id,
        retiredProductId: retiredProduct.id,
        retiredVariantId: retiredVariant.id,
        warehouseId: warehouse.id,
        locationId: location.id,
      };
    });

    // Stock to pick against.
    await asTenant(() =>
      app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
        idempotencyKey: `wave-seed-${tag}`,
        sourceType: "wave-fixture",
        sourceId: tag,
        movements: [
          {
            transactionType: "PURCHASE",
            productVariantId: scene.variantId,
            locationId: scene.locationId,
            quantityDelta: "500.0000",
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

  it("gathers several orders into one pick list", async () => {
    const a = await confirmedOrder(3);
    const b = await confirmedOrder(4);

    const wave = await asTenant(() =>
      waves().createWave(scene.orgId, scene.userId, {
        warehouseId: scene.warehouseId,
        soIds: [a, b],
      }),
    );

    expect(wave.orderCount).toBe(2);
    expect(wave.lineCount).toBe(2);

    const detail = await asTenant(() =>
      waves().getWave(scene.orgId, scene.userId, wave.pickListId),
    );
    // Null soId on the header is what distinguishes a wave from a single-order
    // pick; each line still knows which order it belongs to, so packing can
    // split the goods back.
    expect(detail.soId).toBeNull();
    expect(detail.lines).toHaveLength(2);
    expect(detail.lines.every((l) => l.so_line_id !== null)).toBe(true);
    expect(detail.status).toBe("PENDING");
  });

  it("refuses a wave containing an order that is not ready", async () => {
    const ready = await confirmedOrder(1);
    const draft = await asTenant(() =>
      app.app.get(SoCoreService).createSo(scene.orgId, scene.userId, {
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

    await expect(
      asTenant(() =>
        waves().createWave(scene.orgId, scene.userId, {
          warehouseId: scene.warehouseId,
          soIds: [ready, (draft as { id: number }).id],
        }),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("confirms a line when the scan matches, and completes the wave", async () => {
    const a = await confirmedOrder(2);
    const wave = await asTenant(() =>
      waves().createWave(scene.orgId, scene.userId, {
        warehouseId: scene.warehouseId,
        soIds: [a],
      }),
    );
    const detail = await asTenant(() =>
      waves().getWave(scene.orgId, scene.userId, wave.pickListId),
    );
    const line = detail.lines[0]!;

    const result = await asTenant(() =>
      waves().confirmPick(scene.orgId, scene.userId, wave.pickListId, {
        pickLineId: line.id,
        quantityPicked: "2.0000",
        locationId: scene.locationId,
        scannedPayload: scene.variantSku,
      }),
    );

    expect(result.quantityPicked).toBe("2.0000");
    expect(result.waveComplete).toBe(true);
  });

  it("refuses a confirmation whose scan is a different product", async () => {
    // The reason this check lives on the server: the screen is showing the
    // task, so it agrees with itself whatever is actually in the picker's hand.
    const a = await confirmedOrder(1);
    const wave = await asTenant(() =>
      waves().createWave(scene.orgId, scene.userId, {
        warehouseId: scene.warehouseId,
        soIds: [a],
      }),
    );
    const detail = await asTenant(() =>
      waves().getWave(scene.orgId, scene.userId, wave.pickListId),
    );

    await expect(
      asTenant(() =>
        waves().confirmPick(scene.orgId, scene.userId, wave.pickListId, {
          pickLineId: detail.lines[0]!.id,
          quantityPicked: "1.0000",
          scannedPayload: "SOME-OTHER-SKU-THAT-IS-NOT-THIS",
        }),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("refuses picking more than the line asks for", async () => {
    const a = await confirmedOrder(1);
    const wave = await asTenant(() =>
      waves().createWave(scene.orgId, scene.userId, {
        warehouseId: scene.warehouseId,
        soIds: [a],
      }),
    );
    const detail = await asTenant(() =>
      waves().getWave(scene.orgId, scene.userId, wave.pickListId),
    );

    await expect(
      asTenant(() =>
        waves().confirmPick(scene.orgId, scene.userId, wave.pickListId, {
          pickLineId: detail.lines[0]!.id,
          quantityPicked: "2.0000",
        }),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("accumulates partial picks exactly rather than by float", async () => {
    // Three thirds of one unit must close the line, and must not overshoot it.
    const a = await confirmedOrder(1);
    const wave = await asTenant(() =>
      waves().createWave(scene.orgId, scene.userId, {
        warehouseId: scene.warehouseId,
        soIds: [a],
      }),
    );
    const detail = await asTenant(() =>
      waves().getWave(scene.orgId, scene.userId, wave.pickListId),
    );
    const lineId = detail.lines[0]!.id;

    for (const part of ["0.3333", "0.3333", "0.3334"]) {
      await asTenant(() =>
        waves().confirmPick(scene.orgId, scene.userId, wave.pickListId, {
          pickLineId: lineId,
          quantityPicked: part,
        }),
      );
    }

    const after = await asTenant(() =>
      waves().getWave(scene.orgId, scene.userId, wave.pickListId),
    );
    expect(after.lines[0]!.quantity_picked).toBe("1.0000");
    expect(after.status).toBe("COMPLETED");
  });

  describe("INV-205 exceptions and substitution", () => {
    async function oneLineWave() {
      const so = await confirmedOrder(5);
      const wave = await asTenant(() =>
        waves().createWave(scene.orgId, scene.userId, {
          warehouseId: scene.warehouseId,
          soIds: [so],
        }),
      );
      const detail = await asTenant(() =>
        waves().getWave(scene.orgId, scene.userId, wave.pickListId),
      );
      return { pickListId: wave.pickListId, lineId: detail.lines[0]!.id };
    }

    it("lets a short-picked wave finish once the shortfall is explained", async () => {
      // Without this a picker holding a tote the system will not let them close
      // is stuck, which is exactly what an exception exists to resolve.
      const { pickListId, lineId } = await oneLineWave();
      await asTenant(() =>
        waves().confirmPick(scene.orgId, scene.userId, pickListId, {
          pickLineId: lineId,
          quantityPicked: "2.0000",
        }),
      );

      const open = await asTenant(() =>
        waves().getWave(scene.orgId, scene.userId, pickListId),
      );
      expect(open.status).toBe("IN_PROGRESS");

      const result = await asTenant(() =>
        waves().reportException(scene.orgId, scene.userId, pickListId, {
          pickLineId: lineId,
          reason: "SHORT",
          notes: "Only two on the shelf",
        }),
      );
      expect(result.waveComplete).toBe(true);
    });

    it("keeps why apart from how much", async () => {
      // A line short because the shelf was empty and a line short because the
      // picker moved on carry the same quantity and different meanings.
      const { pickListId, lineId } = await oneLineWave();
      await asTenant(() =>
        waves().reportException(scene.orgId, scene.userId, pickListId, {
          pickLineId: lineId,
          reason: "NOT_FOUND",
          notes: "Bin empty",
        }),
      );

      const detail = await asTenant(() =>
        waves().getWave(scene.orgId, scene.userId, pickListId),
      );
      const [row] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ exception_reason: string; exception_notes: string }>(sql`
          SELECT exception_reason, exception_notes FROM inv_pick_list_lines
          WHERE org_id = ${scene.orgId} AND id = ${lineId}`),
      );
      expect(row!.exception_reason).toBe("NOT_FOUND");
      expect(row!.exception_notes).toBe("Bin empty");
      expect(detail.status).toBe("COMPLETED");
    });

    it("records what actually went in the tote on a substitution", async () => {
      const { pickListId, lineId } = await oneLineWave();
      const result = await asTenant(() =>
        waves().reportException(scene.orgId, scene.userId, pickListId, {
          pickLineId: lineId,
          reason: "SUBSTITUTED",
          substituteVariantId: scene.substituteVariantId,
          quantityPicked: "5.0000",
        }),
      );
      expect(result.substituteVariantId).toBe(scene.substituteVariantId);
      expect(result.quantityPicked).toBe("5.0000");
    });

    it("refuses to substitute in a discontinued product", async () => {
      // Swapping at the shelf must not route around the catalogue gate a sales
      // order line is held to.
      const { pickListId, lineId } = await oneLineWave();
      await expect(
        asTenant(() =>
          waves().reportException(scene.orgId, scene.userId, pickListId, {
            pickLineId: lineId,
            reason: "SUBSTITUTED",
            substituteVariantId: scene.retiredVariantId,
            quantityPicked: "1.0000",
          }),
        ),
      ).rejects.toThrow();
    });

    it("refuses a substitution that names the same product", async () => {
      const { pickListId, lineId } = await oneLineWave();
      await expect(
        asTenant(() =>
          waves().reportException(scene.orgId, scene.userId, pickListId, {
            pickLineId: lineId,
            reason: "SUBSTITUTED",
            substituteVariantId: scene.variantId,
            quantityPicked: "1.0000",
          }),
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
