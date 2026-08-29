import { randomUUID } from "node:crypto";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { InventorySettingsService } from "src/modules/inventory/stock-engine/inventory-settings.service";
import { InvStockAdjustmentsService } from "src/modules/inventory/stock/inv-stock-adjustments.service";
import { InvStockAdjustmentsController } from "src/modules/inventory/stock/inv-stock-adjustments.controller";
import { REQUIRE_PERMISSION } from "src/modules/access/require-permission.decorator";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * D8 — the write-off, against Postgres.
 *
 * The unit's "done when" is three sentences, and each is a describe block
 * below: below the threshold a write-off posts on the adjust permission alone;
 * above it, it cannot reach the ledger until somebody else approves it; and the
 * same idempotency key twice raises one document, not two.
 *
 * The fourth block is the one that cannot be faked by a mock. A write-off's
 * value is the cost of the layers the issue actually consumed, and the whole
 * reason to post a movement rather than record a note is that the ledger works
 * that number out from real layers. A FIFO variant with two receipts at
 * different prices makes the difference visible: the honest answer, the
 * list-price estimate and the latest-cost estimate are three different numbers,
 * and only one of them is reproducible from `inv_valuation_consumptions`.
 *
 *   pnpm test:e2e:seeded --testPathPattern=write-off
 */

const KEEPER = ["inventory:warehouses:scope-all", "inventory:stock:read", "inventory:stock:adjust"] as const;
const CONTROLLER = [
  "inventory:warehouses:scope-all",
  "inventory:stock:read",
  "inventory:adjustments:approve",
  "inventory:adjustments:post",
  "inventory:valuation:read",
] as const;

interface Scene {
  orgId: string;
  keeperId: string;
  controllerId: string;
  warehouseId: number;
  binId: number;
  scrapBinId: number;
  otherWarehouseBinId: number;
  /** FIFO, two layers at 4.00 and 9.00, list cost price a misleading 1.00. */
  fifoVariantId: number;
  /** Weighted average, 100 units at 50.00 — few units, large value. */
  costlyVariantId: number;
}

describe("[seeded-e2e] writing stock off", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  const adjustments = () => app.app.get(InvStockAdjustmentsService);

  const setThresholds = (quantity: string | null, value: string | null) =>
    asTenant(() =>
      app.app.get(InventorySettingsService).update(
        scene.orgId,
        { adjustmentApprovalThreshold: quantity, adjustmentApprovalValueThreshold: value },
        scene.keeperId,
      ),
    );

  const documentRow = async (adjustmentId: number) => {
    const [row] = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{
        status: string;
        reason: string;
        scrap_location_id: number | null;
        written_off_value: string | null;
      }>(sql`
        SELECT status, reason, scrap_location_id, written_off_value
        FROM inv_stock_adjustments
        WHERE org_id = ${scene.orgId} AND id = ${adjustmentId}`),
    );
    return row!;
  };

  const movementsFor = async (adjustmentId: number) =>
    asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{
        id: number;
        transaction_type: string;
        quantity_change: string;
        total_cost: string | null;
      }>(sql`
        SELECT id, transaction_type, quantity_change, total_cost
        FROM inv_stock_transactions
        WHERE org_id = ${scene.orgId}
          AND reference_type = 'inv_adjustment'
          AND reference_id = ${String(adjustmentId)}
        ORDER BY id`),
    );

  const documentCount = async (note: string) => {
    const [row] = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM inv_stock_adjustments
        WHERE org_id = ${scene.orgId} AND notes = ${note}`),
    );
    return row!.n;
  };

  const writeOff = (
    variantId: number,
    quantity: number,
    key: string,
    extra: { notes?: string; reason?: string; scrapLocationId?: number } = {},
  ) =>
    asTenant(() =>
      adjustments().createAdjustment(
        scene.orgId,
        scene.keeperId,
        {
          reason: extra.reason ?? "SCRAP",
          notes: extra.notes,
          scrapLocationId: extra.scrapLocationId,
          lines: [{ productVariantId: variantId, locationId: scene.binId, quantityChange: -quantity }],
        } as never,
        key,
      ),
    );

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("keeper", { permissionKeys: KEEPER })
      .addMember("controller", { permissionKeys: CONTROLLER })
      .build();
    teardown = () => seeded.teardown();

    const tag = randomUUID().slice(0, 6);
    const db = app.app.get<Db>(DRIZZLE);
    const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
      (await db.execute<T>(q))[0]!;

    scene = await runInNewTenantTransaction(db, seeded.orgId, async () => {
      const orgId = seeded.orgId;
      const keeperId = seeded.members.keeper!.userId;
      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);

      const variant = async (alias: string, method: string, costPrice: string) => {
        const product = await one<{ id: number }>(sql`
          INSERT INTO inv_products (org_id, uom_id, name, sku, costing_method, created_by)
          VALUES (${orgId}, ${uom.id}, ${alias}, ${`${alias}-${tag}`}, ${sql.raw(`'${method}'`)}, ${keeperId})
          RETURNING id`);
        const row = await one<{ id: number }>(sql`
          INSERT INTO inv_product_variants (org_id, product_id, name, sku, cost_price)
          VALUES (${orgId}, ${product.id}, 'Default', ${`${alias}-${tag}-V1`}, ${costPrice}) RETURNING id`);
        return row.id;
      };

      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${orgId}, ${`Scrapyard ${tag}`}, ${`SY${tag}`}, ${keeperId}) RETURNING id`);
      const otherWarehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${orgId}, ${`Annexe ${tag}`}, ${`AX${tag}`}, ${keeperId}) RETURNING id`);
      const location = async (warehouseId: number, name: string, code: string, type: string) =>
        (await one<{ id: number }>(sql`
          INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
          VALUES (${orgId}, ${warehouseId}, ${name}, ${code}, ${sql.raw(`'${type}'`)}) RETURNING id`)).id;

      return {
        orgId,
        keeperId,
        controllerId: seeded.members.controller!.userId,
        warehouseId: warehouse.id,
        binId: await location(warehouse.id, "Bin", `SB${tag}`, "BIN"),
        scrapBinId: await location(warehouse.id, "Scrap", `SC${tag}`, "SCRAP"),
        otherWarehouseBinId: await location(otherWarehouse.id, "Bin", `AB${tag}`, "BIN"),
        fifoVariantId: await variant("FIFOWIDGET", "FIFO", "1.0000"),
        costlyVariantId: await variant("TURBINE", "WEIGHTED_AVERAGE", "0.0100"),
      };
    });

    // Two FIFO layers at different prices, and one large weighted-average
    // receipt. Posted through the real engine so the layers are the layers an
    // issue will actually find.
    const engine = app.app.get(StockEngineService);
    const receive = (name: string, variantId: number, qty: string, unitCost: string) =>
      runInNewTenantTransaction(db, scene.orgId, () =>
        engine.execute(scene.orgId, scene.keeperId, {
          idempotencyKey: `wo-seed-${tag}-${name}`,
          sourceType: "write-off-fixture",
          sourceId: `${tag}:${name}`,
          movements: [
            {
              transactionType: "PURCHASE",
              productVariantId: variantId,
              locationId: scene.binId,
              quantityDelta: qty,
              unitCost,
            },
          ],
        }),
      );
    await receive("fifo-cheap", scene.fifoVariantId, "100.0000", "4.0000");
    await receive("fifo-dear", scene.fifoVariantId, "100.0000", "9.0000");
    await receive("costly", scene.costlyVariantId, "100.0000", "50.0000");
  }, 300_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  describe("below the threshold, a write-off posts on the adjust permission alone", () => {
    it("posts immediately and issues the stock as SCRAP", async () => {
      await setThresholds(null, null);
      const created = await writeOff(scene.costlyVariantId, 2, `wo-below-${randomUUID()}`);

      const row = await documentRow(created!.id);
      expect(row.status).toBe("POSTED");
      // The creator holds `inventory:stock:adjust` and nothing else that could
      // move stock — no approval was asked for and none was recorded.
      expect(row.written_off_value).not.toBeNull();

      const movements = await movementsFor(created!.id);
      expect(movements).toHaveLength(1);
      // SCRAP rather than ADJUSTMENT_OUT: the movement history has to be able
      // to tell shrinkage from a recount.
      expect(movements[0]!.transaction_type).toBe("SCRAP");
      expect(Number(movements[0]!.quantity_change)).toBe(-2);
    });

    it("records the warehouse's own scrap bin without being told which it is", async () => {
      await setThresholds(null, null);
      const created = await writeOff(scene.costlyVariantId, 1, `wo-bin-${randomUUID()}`);
      expect((await documentRow(created!.id)).scrap_location_id).toBe(scene.scrapBinId);
    });

    it("refuses a scrap location that is not a scrap bin", async () => {
      await setThresholds(null, null);
      await expect(
        writeOff(scene.costlyVariantId, 1, `wo-badbin-${randomUUID()}`, { scrapLocationId: scene.binId }),
      ).rejects.toThrow(BadRequestException);
    });

    it("refuses a scrap location in a different building from the goods", async () => {
      await setThresholds(null, null);
      await expect(
        writeOff(scene.costlyVariantId, 1, `wo-farbin-${randomUUID()}`, {
          scrapLocationId: scene.otherWarehouseBinId,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("refuses a write-off that adds stock", async () => {
      await setThresholds(null, null);
      await expect(writeOff(scene.costlyVariantId, -3, `wo-add-${randomUUID()}`)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe("above the threshold, it needs somebody else's approval", () => {
    it("routes on value where the quantity threshold sees nothing wrong", async () => {
      // Three units is nothing; three turbines is 150.00 of stock. This is the
      // whole reason the value threshold exists beside the quantity one.
      await setThresholds("1000", "100");
      const created = await writeOff(scene.costlyVariantId, 3, `wo-value-${randomUUID()}`);

      expect((await documentRow(created!.id)).status).toBe("PENDING_APPROVAL");
      expect(await movementsFor(created!.id)).toEqual([]);
    });

    it("cannot post while unapproved, cannot be approved by the person who raised it, and posts once it is", async () => {
      await setThresholds("1000", "100");
      const created = await writeOff(scene.costlyVariantId, 4, `wo-ladder-${randomUUID()}`);
      const id = created!.id;

      await expect(
        asTenant(() => adjustments().postAdjustment(scene.orgId, scene.controllerId, id, randomUUID())),
      ).rejects.toThrow(BadRequestException);
      expect(await movementsFor(id)).toEqual([]);

      // Maker-checker: writing off stock is how theft is concealed.
      await expect(
        asTenant(() => adjustments().approveAdjustment(scene.orgId, scene.keeperId, id, randomUUID())),
      ).rejects.toThrow(ForbiddenException);
      expect((await documentRow(id)).status).toBe("PENDING_APPROVAL");

      await asTenant(() =>
        adjustments().approveAdjustment(scene.orgId, scene.controllerId, id, randomUUID()),
      );
      expect((await documentRow(id)).status).toBe("APPROVED");

      await asTenant(() =>
        adjustments().postAdjustment(scene.orgId, scene.controllerId, id, randomUUID()),
      );
      const posted = await documentRow(id);
      expect(posted.status).toBe("POSTED");
      expect(Number(posted.written_off_value)).toBeGreaterThan(0);
      expect(await movementsFor(id)).toHaveLength(1);
    });

    it("gates the two rungs on the keys the routes declare", () => {
      // The ladder above is enforced in the service; which permission opens each
      // rung is enforced by the controller, and a rung whose key drifted would
      // let the adjust permission approve its own document.
      const keyOf = (method: keyof InvStockAdjustmentsController) =>
        Reflect.getMetadata(REQUIRE_PERMISSION, InvStockAdjustmentsController.prototype[method]) as string;
      expect(keyOf("createAdjustment")).toBe("inventory:stock:adjust");
      expect(keyOf("approveAdjustment")).toBe("inventory:adjustments:approve");
      expect(keyOf("postAdjustment")).toBe("inventory:adjustments:post");
    });
  });

  describe("the same idempotency key twice", () => {
    it("raises one document on the branch that waits for approval", async () => {
      await setThresholds("1000", "100");
      const key = `wo-dup-pending-${randomUUID()}`;
      const note = key;
      const first = await writeOff(scene.costlyVariantId, 5, key, { notes: note });
      const second = await writeOff(scene.costlyVariantId, 5, key, { notes: note });

      expect(second!.id).toBe(first!.id);
      expect(await documentCount(note)).toBe(1);
      expect(await movementsFor(first!.id)).toEqual([]);
    });

    it("raises one document and moves stock once on the branch that posts", async () => {
      await setThresholds(null, null);
      const key = `wo-dup-posted-${randomUUID()}`;
      const note = key;
      const first = await writeOff(scene.costlyVariantId, 6, key, { notes: note });
      const second = await writeOff(scene.costlyVariantId, 6, key, { notes: note });

      expect(second!.id).toBe(first!.id);
      expect(await documentCount(note)).toBe(1);
      expect(await movementsFor(first!.id)).toHaveLength(1);
    });
  });

  describe("what the write-off cost", () => {
    it("is the cost the layers actually carried, not an estimate of it", async () => {
      await setThresholds(null, null);
      // 150 units against layers of 100 at 4.00 and 100 at 9.00. FIFO empties
      // the cheap layer first: 100 × 4.00 + 50 × 9.00 = 850.00.
      const created = await writeOff(scene.fifoVariantId, 150, `wo-cost-${randomUUID()}`);
      const id = created!.id;

      const posted = await documentRow(id);
      expect(posted.status).toBe("POSTED");
      expect(posted.written_off_value).toBe("850.0000");

      // The two estimates this is not. The variant's list cost price would have
      // said 150.00; the most recent receipt would have said 1350.00. Both are
      // defensible-looking numbers and both are wrong.
      expect(Number(posted.written_off_value)).not.toBe(150);
      expect(Number(posted.written_off_value)).not.toBe(1350);

      // And it is reproducible from the layer draws rather than being a second
      // opinion about them.
      const movements = await movementsFor(id);
      expect(movements).toHaveLength(1);
      const [consumed] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ drawn: string; layers: number }>(sql`
          SELECT COALESCE(SUM(total_cost), 0)::text AS drawn, count(*)::int AS layers
          FROM inv_valuation_consumptions
          WHERE org_id = ${scene.orgId} AND stock_transaction_id = ${movements[0]!.id}`),
      );
      expect(consumed!.layers).toBe(2);
      expect(consumed!.drawn).toBe("850.0000");
      expect(movements[0]!.total_cost).toBe("850.0000");
    });

    it("is withheld from a caller who may not see cost", async () => {
      await setThresholds(null, null);
      const created = await writeOff(scene.costlyVariantId, 1, `wo-visibility-${randomUUID()}`);

      // The keeper raised it and may not see what stock is worth; supplier cost
      // is commercially sensitive and must not be in the payload at all.
      const asKeeper = await asTenant(() =>
        adjustments().getAdjustment(scene.orgId, created!.id, scene.keeperId),
      );
      expect("writtenOffValue" in asKeeper).toBe(false);

      const asController = await asTenant(() =>
        adjustments().getAdjustment(scene.orgId, created!.id, scene.controllerId),
      );
      expect("writtenOffValue" in asController).toBe(true);
    });
  });
});
