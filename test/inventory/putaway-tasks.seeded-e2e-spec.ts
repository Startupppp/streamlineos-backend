import { randomUUID } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { PoService } from "src/modules/inventory/purchase-orders/po.service";
import { GrnService } from "src/modules/inventory/purchase-orders/grn.service";
import { PutawayTaskService } from "src/modules/inventory/putaway/putaway-task.service";
import { PutawayCompleteService } from "src/modules/inventory/putaway/putaway-complete.service";
import { subDec } from "src/modules/inventory/stock-engine/decimal";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * B3 — the walk between the receiving dock and the shelf.
 *
 * The "done when" of the unit, end to end against a real database: post a goods
 * receipt to a RECEIVING location, walk the putaway, and the stock is standing
 * at the storage bin with the receiving bin empty. A duplicate complete — the
 * same command retried under the same key, which is what a scanner on a bad
 * network produces — must change nothing.
 *
 * The rest of the file covers the two ways a putaway is not a plain relocation:
 * the destination has to be a bin that can take goods, and goods that failed
 * inspection go to quarantine whatever the operator scans.
 */
const PERMISSIONS = [
  "inventory:warehouses:scope-all",
  "inventory:purchase-orders:create",
  "inventory:purchase-orders:receive",
  "inventory:stock:read",
  "inventory:stock:transfer",
] as const;

interface Scene {
  orgId: string;
  userId: string;
  variantId: number;
  warehouseId: number;
  receivingId: number;
  storageId: number;
  otherStorageId: number;
  quarantineId: number;
  shippingId: number;
  otherWarehouseBinId: number;
  vendorId: number;
}

describe("[seeded-e2e] putaway tasks", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  const tasks = () => app.app.get(PutawayTaskService);
  const completion = () => app.app.get(PutawayCompleteService);

  /** A sent order, received in full at the receiving bin, and posted. */
  async function receiveAtDock(quantity: number): Promise<number> {
    const po = await asTenant(() =>
      app.app.get(PoService).createPo(scene.orgId, scene.userId, {
        vendorId: scene.vendorId,
        orderDate: "2026-08-01",
        warehouseId: scene.warehouseId,
        currency: "INR",
        lines: [
          {
            productVariantId: scene.variantId,
            quantity,
            unitCost: "10.0000",
            taxRate: "0",
            lineOrder: 0,
          },
        ],
      }),
    );
    await asTenant(() => app.app.get(PoService).sendPo(scene.orgId, po.id, scene.userId));
    const [line] = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{ id: number }>(sql`
        SELECT id FROM inv_po_lines WHERE org_id = ${scene.orgId} AND po_id = ${po.id}`),
    );
    const grn = await asTenant(() =>
      app.app.get(GrnService).receiveGoods(
        scene.orgId,
        po.id,
        scene.userId,
        `grn-${randomUUID()}`,
        {
          receivedDate: "2026-08-02",
          locationId: scene.receivingId,
          lines: [
            { poLineId: line!.id, quantityReceived: String(quantity), qualityStatus: "ACCEPTED" },
          ],
        } as never,
      ),
    );
    return (grn as { id: number }).id;
  }

  const onHandAt = async (locationId: number): Promise<string> => {
    const [row] = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{ on_hand: string }>(sql`
        SELECT COALESCE(SUM(on_hand), 0)::text AS on_hand
          FROM inv_stock_levels
         WHERE org_id = ${scene.orgId}
           AND product_variant_id = ${scene.variantId}
           AND location_id = ${locationId}`),
    );
    return row!.on_hand;
  };

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
        INSERT INTO inv_products (org_id, uom_id, name, sku, tracking_method, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Dock goods', ${`PT-${tag}`}, 'NONE', ${userId})
        RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`PT-${tag}-V`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Main', ${`MN${tag}`}, ${userId}) RETURNING id`);
      const otherWarehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Annexe', ${`AX${tag}`}, ${userId}) RETURNING id`);
      const vendor = await one<{ id: number }>(sql`
        INSERT INTO inv_vendors (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Dock vendor', ${`VN${tag}`}, ${userId}) RETURNING id`);

      const bin = async (
        warehouseId: number,
        code: string,
        type: string,
        flags: { receivable: boolean; pickable: boolean },
      ) =>
        (
          await one<{ id: number }>(sql`
            INSERT INTO inv_locations
              (org_id, warehouse_id, name, code, location_type, is_receivable, is_pickable)
            VALUES (${seeded.orgId}, ${warehouseId}, ${code}, ${`${code}${tag}`},
                    ${sql.raw(`'${type}'`)}, ${flags.receivable}, ${flags.pickable})
            RETURNING id`)
        ).id;

      return {
        orgId: seeded.orgId,
        userId,
        variantId: variant.id,
        warehouseId: warehouse.id,
        vendorId: vendor.id,
        receivingId: await bin(warehouse.id, "RECEIVING", "RECEIVING", { receivable: true, pickable: false }),
        storageId: await bin(warehouse.id, "AISLE1", "BIN", { receivable: true, pickable: true }),
        otherStorageId: await bin(warehouse.id, "AISLE2", "BIN", { receivable: true, pickable: true }),
        quarantineId: await bin(warehouse.id, "QUARANTINE", "QUARANTINE", { receivable: false, pickable: false }),
        shippingId: await bin(warehouse.id, "SHIPPING", "SHIPPING", { receivable: false, pickable: true }),
        otherWarehouseBinId: await bin(otherWarehouse.id, "FARBIN", "BIN", { receivable: true, pickable: true }),
      };
    });
  }, 240_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  describe("the done-when: a receipt walked to the shelf", () => {
    let grnId: number;
    let taskId: number;
    let lineId: number;

    it("raises a task from the posted receipt, at the receiving location", async () => {
      const dockBefore = await onHandAt(scene.receivingId);
      grnId = await receiveAtDock(24);
      expect(await onHandAt(scene.receivingId)).not.toBe(dockBefore);

      const created = await asTenant(() =>
        tasks().createFromReceipt(scene.orgId, scene.userId, { grnId }),
      );
      taskId = created.taskId;
      expect(created.lineCount).toBe(1);
      expect(created.quarantineLineCount).toBe(0);

      const detail = await asTenant(() => tasks().get(scene.orgId, scene.userId, taskId));
      expect(detail.task.fromLocationId).toBe(scene.receivingId);
      lineId = detail.lines[0]!.id;
      // Exact, as a decimal string. Item 4: a `numeric(18,4)` never becomes a
      // float on the way to a decision, and "remaining" is a decision.
      expect(detail.lines[0]!.quantity).toBe("24.0000");
      expect(detail.lines[0]!.remaining).toBe("24.0000");
      // The suggestion carries the room actually left in each bin, and an
      // unmeasured bin reports unlimited rather than "very large".
      expect(detail.lines[0]!.suggestions.length).toBeGreaterThan(0);
      expect(
        detail.lines[0]!.suggestions.every((s) => s.locationId !== scene.receivingId),
      ).toBe(true);
    });

    it("moves the stock to the storage bin and empties the receiving bin", async () => {
      const storageBefore = await onHandAt(scene.storageId);

      const result = await asTenant(() =>
        completion().complete(
          scene.orgId,
          scene.userId,
          taskId,
          { lines: [{ taskLineId: lineId, quantity: "24.0000", toLocationId: scene.storageId }] },
          `putaway-${randomUUID()}`,
        ),
      );

      expect(result.status).toBe("COMPLETED");
      expect(result.transactionIds.length).toBe(2);
      expect(await onHandAt(scene.receivingId)).toBe("0.0000");
      expect(await onHandAt(scene.storageId)).toBe(
        (Number(storageBefore) + 24).toFixed(4),
      );
    });

    it("carries the receipt's cost across rather than re-estimating it", async () => {
      // The arrival inherits what leaving the dock actually consumed. An
      // estimate agrees under weighted average and does not under FIFO, which
      // would restate inventory purely because the goods changed shelf.
      const rows = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ transaction_type: string; unit_cost: string | null }>(sql`
          SELECT transaction_type, unit_cost::text AS unit_cost
            FROM inv_stock_transactions
           WHERE org_id = ${scene.orgId}
             AND reference_type = 'inv_putaway_task'
             AND reference_id = ${String(taskId)}
           ORDER BY id`),
      );
      expect(rows.map((r) => r.transaction_type)).toEqual(["TRANSFER_OUT", "TRANSFER_IN"]);
      expect(rows[1]!.unit_cost).toBe(rows[0]!.unit_cost);
    });

    it("is a no-op when the same complete is retried under its key", async () => {
      const key = `putaway-replay-${randomUUID()}`;
      const secondGrn = await receiveAtDock(6);
      const second = await asTenant(() =>
        tasks().createFromReceipt(scene.orgId, scene.userId, { grnId: secondGrn }),
      );
      const detail = await asTenant(() => tasks().get(scene.orgId, scene.userId, second.taskId));
      const secondLine = detail.lines[0]!.id;

      const first = await asTenant(() =>
        completion().complete(
          scene.orgId,
          scene.userId,
          second.taskId,
          { lines: [{ taskLineId: secondLine, quantity: "6.0000", toLocationId: scene.storageId }] },
          key,
        ),
      );
      const afterFirst = await onHandAt(scene.storageId);

      const replay = await asTenant(() =>
        completion().complete(
          scene.orgId,
          scene.userId,
          second.taskId,
          { lines: [{ taskLineId: secondLine, quantity: "6.0000", toLocationId: scene.storageId }] },
          key,
        ),
      );

      // The stored result, not a second walk: the same ledger rows, the same
      // quantity moved, and no change on either shelf.
      expect(replay.transactionIds).toEqual(first.transactionIds);
      expect(replay.status).toBe("COMPLETED");
      expect(await onHandAt(scene.storageId)).toBe(afterFirst);
      expect(await onHandAt(scene.receivingId)).toBe("0.0000");
    });
  });

  describe("partial putaway", () => {
    it("leaves the task open and the remainder on the dock", async () => {
      const grnId = await receiveAtDock(10);
      const created = await asTenant(() =>
        tasks().createFromReceipt(scene.orgId, scene.userId, { grnId }),
      );
      const before = await asTenant(() => tasks().get(scene.orgId, scene.userId, created.taskId));
      const lineId = before.lines[0]!.id;

      const half = await asTenant(() =>
        completion().complete(
          scene.orgId,
          scene.userId,
          created.taskId,
          { lines: [{ taskLineId: lineId, quantity: "4.0000", toLocationId: scene.storageId }] },
          `putaway-${randomUUID()}`,
        ),
      );
      expect(half.status).toBe("IN_PROGRESS");

      const midway = await asTenant(() => tasks().get(scene.orgId, scene.userId, created.taskId));
      expect(midway.lines[0]!.remaining).toBe("6.0000");
      expect(await onHandAt(scene.receivingId)).toBe("6.0000");

      // The rest may go to a different bin — a pallet that did not fit is the
      // ordinary reason a putaway is partial in the first place.
      const rest = await asTenant(() =>
        completion().complete(
          scene.orgId,
          scene.userId,
          created.taskId,
          { lines: [{ taskLineId: lineId, quantity: "6.0000", toLocationId: scene.otherStorageId }] },
          `putaway-${randomUUID()}`,
        ),
      );
      expect(rest.status).toBe("COMPLETED");
      expect(await onHandAt(scene.receivingId)).toBe("0.0000");
      expect(await onHandAt(scene.otherStorageId)).toBe("6.0000");
    });

    it("refuses more than the line still owes", async () => {
      const grnId = await receiveAtDock(3);
      const created = await asTenant(() =>
        tasks().createFromReceipt(scene.orgId, scene.userId, { grnId }),
      );
      const detail = await asTenant(() => tasks().get(scene.orgId, scene.userId, created.taskId));

      await expect(
        asTenant(() =>
          completion().complete(
            scene.orgId,
            scene.userId,
            created.taskId,
            {
              lines: [
                { taskLineId: detail.lines[0]!.id, quantity: "4.0000", toLocationId: scene.storageId },
              ],
            },
            `putaway-${randomUUID()}`,
          ),
        ),
      ).rejects.toThrow(BadRequestException);

      // Nothing moved: the refusal is before the engine, and the transaction
      // that would have carried it rolled back.
      expect(await onHandAt(scene.receivingId)).toBe("3.0000");
    });
  });

  describe("capability checks on the destination", () => {
    let taskId: number;
    let lineId: number;

    beforeAll(async () => {
      const grnId = await receiveAtDock(2);
      const created = await asTenant(() =>
        tasks().createFromReceipt(scene.orgId, scene.userId, { grnId }),
      );
      taskId = created.taskId;
      lineId = (await asTenant(() => tasks().get(scene.orgId, scene.userId, taskId))).lines[0]!.id;
    });

    const putTo = (locationId: number) =>
      asTenant(() =>
        completion().complete(
          scene.orgId,
          scene.userId,
          taskId,
          { lines: [{ taskLineId: lineId, quantity: "1.0000", toLocationId: locationId }] },
          `putaway-${randomUUID()}`,
        ),
      );

    it("refuses a bin that does not accept goods", async () => {
      await expect(putTo(scene.shippingId)).rejects.toThrow(BadRequestException);
    });

    it("refuses a bin in another warehouse", async () => {
      // A "putaway" across buildings is a transfer, which has its own document,
      // its own transit location and its own reservation semantics.
      await expect(putTo(scene.otherWarehouseBinId)).rejects.toThrow(BadRequestException);
    });

    it("refuses putting the goods back where they already are", async () => {
      await expect(putTo(scene.receivingId)).rejects.toThrow(BadRequestException);
    });
  });

  describe("quarantine routing", () => {
    it("sends a receipt whose inspection failed to the quarantine bin, and nowhere else", async () => {
      const grnId = await receiveAtDock(5);
      // A delta rather than an absolute: the refusal cases above deliberately
      // leave their goods on the dock, so "the receiving bin is empty" is only
      // true of the first receipt in the file.
      const dockAfterReceipt = await onHandAt(scene.receivingId);

      // What `inspectionOnReceipt` raises, moved to the state a failed
      // inspection leaves it in. No lines: the setting inspects the delivery,
      // not a grain, so a line-less failure quarantines the whole receipt.
      await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute(sql`
          INSERT INTO inv_quality_inspections
            (org_id, inspection_number, source_type, source_id, status, created_by)
          VALUES (${scene.orgId}, ${`QI-${randomUUID().slice(0, 8)}`}, 'inv_grn',
                  ${String(grnId)}, 'DISPOSITION_REQUIRED', ${scene.userId})`),
      );

      const created = await asTenant(() =>
        tasks().createFromReceipt(scene.orgId, scene.userId, { grnId }),
      );
      expect(created.quarantineLineCount).toBe(1);

      const detail = await asTenant(() => tasks().get(scene.orgId, scene.userId, created.taskId));
      const line = detail.lines[0]!;
      expect(line.disposition).toBe("QUARANTINE");
      expect(line.to_location_id).toBe(scene.quarantineId);

      // The operator cannot scan it onto a storage shelf instead: quarantine is
      // a fact about the goods, not a preference expressed at the bin.
      await expect(
        asTenant(() =>
          completion().complete(
            scene.orgId,
            scene.userId,
            created.taskId,
            { lines: [{ taskLineId: line.id, quantity: "5.0000", toLocationId: scene.storageId }] },
            `putaway-${randomUUID()}`,
          ),
        ),
      ).rejects.toThrow(BadRequestException);

      const done = await asTenant(() =>
        completion().complete(
          scene.orgId,
          scene.userId,
          created.taskId,
          { lines: [{ taskLineId: line.id, quantity: "5.0000" }] },
          `putaway-${randomUUID()}`,
        ),
      );
      expect(done.status).toBe("COMPLETED");
      expect(await onHandAt(scene.quarantineId)).toBe("5.0000");
      expect(await onHandAt(scene.receivingId)).toBe(subDec(dockAfterReceipt, "5.0000"));
    });
  });

  describe("the queue", () => {
    it("raises one live task per receipt and lists it warehouse-scoped", async () => {
      const grnId = await receiveAtDock(1);
      const created = await asTenant(() =>
        tasks().createFromReceipt(scene.orgId, scene.userId, { grnId }),
      );

      await expect(
        asTenant(() => tasks().createFromReceipt(scene.orgId, scene.userId, { grnId })),
      ).rejects.toThrow();

      const queue = await asTenant(() =>
        tasks().list(scene.orgId, scene.userId, {
          page: 1,
          limit: 25,
          assignment: "ANY",
          warehouseId: scene.warehouseId,
        }),
      );
      const row = queue.items.find((item) => item.id === created.taskId);
      expect(row?.grnId).toBe(grnId);
      expect(row?.fromLocationId).toBe(scene.receivingId);
      expect(row?.lineCount).toBe(1);

      const claimed = await asTenant(() => tasks().claim(scene.orgId, scene.userId, created.taskId));
      expect(claimed.claimed).toBe(true);
      const mine = await asTenant(() =>
        tasks().list(scene.orgId, scene.userId, { page: 1, limit: 25, assignment: "MINE" }),
      );
      expect(mine.items.some((item) => item.id === created.taskId)).toBe(true);
    });
  });
});
