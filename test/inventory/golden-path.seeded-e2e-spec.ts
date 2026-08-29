import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { availableQtySumSql } from "src/modules/inventory/stock-engine/available-sql";
import { PoService } from "src/modules/inventory/purchase-orders/po.service";
import { GrnService } from "src/modules/inventory/purchase-orders/grn.service";
import { InvStockService } from "src/modules/inventory/stock/inv-stock.service";
import { PutawayTaskService } from "src/modules/inventory/putaway/putaway-task.service";
import { PutawayCompleteService } from "src/modules/inventory/putaway/putaway-complete.service";
import { SoCoreService } from "src/modules/inventory/sales-orders/so-core.service";
import { SoLifecycleService } from "src/modules/inventory/sales-orders/so-lifecycle.service";
import { SoFulfillmentService } from "src/modules/inventory/sales-orders/so-fulfillment.service";
import { PickWaveService } from "src/modules/inventory/picking/pick-wave.service";
import { PickConfirmService } from "src/modules/inventory/picking/pick-confirm.service";
import { CustomerReturnsService } from "src/modules/inventory/returns/customer-returns.service";
import { RecallSimulationService } from "src/modules/inventory/quality/recall-simulation.service";
import { RecallsService } from "src/modules/inventory/quality/quality-recalls.service";
import { InvReconciliationService } from "src/modules/inventory/reconciliation/inv-reconciliation.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * G7 — the whole warehouse, once, in the order a warehouse works in.
 *
 * Every other seeded spec proves one unit. This one exists because two Claude
 * sessions built this module in parallel across ~40 work units, and a chain can
 * be broken at a seam while every link passes its own test: `packSo` looked up
 * pick lists by a column that is null for a wave, `shipSo` did the same, and
 * both had green unit suites. Only walking the whole path finds that.
 *
 * The observables are deliberately the ones a business cares about — what is
 * promisable, and whether the ledger still explains the projection — not the
 * columns underneath them. A step that silently does nothing shows up as stock
 * that did not move.
 *
 *   pnpm test:e2e:seeded --testPathPattern=golden-path
 */
const PERMISSIONS = [
  "inventory:warehouses:scope-all",
  "inventory:stock:read",
  "inventory:stock:reserve",
  "inventory:stock:adjust",
  "inventory:stock:transfer",
  "inventory:stock:reconcile",
  "inventory:products:read",
  "inventory:purchase-orders:create",
  "inventory:purchase-orders:approve",
  "inventory:purchase-orders:receive",
  "inventory:sales-orders:create",
  "inventory:sales-orders:confirm",
  "inventory:sales-orders:ship",
  "inventory:customer-returns:manage",
  "inventory:quality:inspect",
  "inventory:quality:read",
  "inventory:quality:release",
  "inventory:quality:recall",
] as const;

/**
 * Each slice drives a whole business step through real services against a real
 * database, and this suite shares that database with every other seeded run on
 * the machine. The 120s default is a coin toss under that load -- it failed the
 * reservation slice at 120019ms while the same slice passed in 8s on a quiet
 * database. A timeout that depends on what else is running is a flaky test, not
 * a slow one.
 */
const SLICE_TIMEOUT_MS = 300_000;

interface Scene {
  orgId: string;
  userId: string;
  variantId: number;
  sku: string;
  warehouseId: number;
  receivingId: number;
  storageId: number;
  vendorId: number;
  tag: string;
}

describe("[seeded-e2e] the golden path", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;
  let grnId: number;
  let soId: number;
  /** A second, lot-tracked SKU, so the recall has two lots to tell apart. */
  let lotVariantId: number;

  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  const db = () => app.app.get<Db>(DRIZZLE);

  /**
   * What the business can promise — through `availableQtySumSql`, not a copy of it.
   *
   * This spec spent one revision asserting against a hand-written subtraction,
   * which made it the seventh copy of a formula whose own module doc records
   * that none of the previous six subtracted `outgoing_qty`. A copy stays
   * correct only until somebody adds a term to the original, and then this
   * suite would go on asserting 100/70/80 against the old arithmetic while
   * every ATP figure in the product had moved -- green, and measuring nothing.
   *
   * The copy was not even equivalent. It joined `inv_locations` and filtered
   * `is_sellable IS NOT FALSE`, which drops a row whose location cannot be read
   * at all; the canonical form treats that row as sellable, matching the
   * column's `true` default rather than silently zeroing a warehouse.
   */
  const atp = async (variantId?: number): Promise<number> => {
    const [row] = await asTenant(() =>
      db().execute<{ available: string }>(sql`
        SELECT ${availableQtySumSql("sl")}::text AS available
        FROM inv_stock_levels sl
        WHERE sl.org_id = ${scene.orgId}
          AND sl.product_variant_id = ${variantId ?? scene.variantId}`),
    );
    return Number(row!.available);
  };

  const onHandAt = async (locationId: number): Promise<number> => {
    const [row] = await asTenant(() =>
      db().execute<{ qty: string }>(sql`
        SELECT COALESCE(SUM(on_hand), 0)::text AS qty FROM inv_stock_levels
        WHERE org_id = ${scene.orgId} AND product_variant_id = ${scene.variantId}
          AND location_id = ${locationId}`),
    );
    return Number(row!.qty);
  };

  /** The invariant asserted after every step: the ledger explains the projection. */
  const expectReconciled = async (step: string): Promise<void> => {
    const report = await asTenant(() =>
      app.app.get(InvReconciliationService).report(scene.orgId, scene.userId, {
        limit: 50,
      }),
    );
    expect({ step, drift: (report as { drift: unknown[] }).drift }).toEqual({ step, drift: [] });
  };

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("keeper", { permissionKeys: [...PERMISSIONS] })
      .build();
    teardown = () => seeded.teardown();

    const tag = randomUUID().slice(0, 6);
    scene = await runInNewTenantTransaction(db(), seeded.orgId, async () => {
      const userId = seeded.members.keeper!.userId;
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db().execute<T>(q))[0]!;
      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Golden widget', ${`GP-${tag}`}, ${userId}) RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`GP-${tag}-V`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Golden', ${`GW${tag}`}, ${userId}) RETURNING id`);
      const receiving = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable, is_pickable)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Dock', ${`GD${tag}`}, 'RECEIVING', true, false)
        RETURNING id`);
      const storage = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable, is_pickable)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Aisle', ${`GA${tag}`}, 'BIN', true, true)
        RETURNING id`);
      const vendor = await one<{ id: number }>(sql`
        INSERT INTO inv_vendors (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Golden vendor', ${`GV${tag}`}, ${userId}) RETURNING id`);
      return {
        orgId: seeded.orgId,
        userId,
        variantId: variant.id,
        sku: `GP-${tag}-V`,
        warehouseId: warehouse.id,
        receivingId: receiving.id,
        storageId: storage.id,
        vendorId: vendor.id,
        tag,
      };
    });
  }, 300_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app?.close();
  }, 120_000);

  it("starts with nothing on the shelf and nothing promisable", async () => {
    expect(await atp()).toBe(0);
    await expectReconciled("empty");
  }, SLICE_TIMEOUT_MS);

  it("buys 100 and receives them onto the dock", async () => {
    const po = await asTenant(() =>
      app.app.get(PoService).createPo(scene.orgId, scene.userId, {
        vendorId: scene.vendorId,
        orderDate: "2026-08-01",
        warehouseId: scene.warehouseId,
        currency: "INR",
        lines: [
          {
            productVariantId: scene.variantId,
            quantity: 100,
            unitCost: "4.0000",
            taxRate: "0",
            lineOrder: 0,
          },
        ],
      }),
    );
    const poId = (po as { id: number }).id;
    await asTenant(() => app.app.get(PoService).sendPo(scene.orgId, poId, scene.userId));

    const [line] = await asTenant(() =>
      db().execute<{ id: number }>(sql`
        SELECT id FROM inv_po_lines WHERE org_id = ${scene.orgId} AND po_id = ${poId}`),
    );

    // On order, and deliberately not promisable — they are not in the building.
    expect(await atp()).toBe(0);

    const grn = await asTenant(() =>
      app.app.get(GrnService).receiveGoods(
        scene.orgId,
        poId,
        scene.userId,
        `gp-receive-${scene.tag}`,
        {
          receivedDate: "2026-08-02",
          locationId: scene.receivingId,
          lines: [
            { poLineId: line!.id, quantityReceived: "100.0000", qualityStatus: "ACCEPTED" },
          ],
        },
      ),
    );

    grnId = (grn as { id: number }).id;

    expect(await onHandAt(scene.receivingId)).toBe(100);
    expect(await atp()).toBe(100);
    await expectReconciled("received");
  }, SLICE_TIMEOUT_MS);

  it("puts the stock away into a pickable bin without changing what is promisable", async () => {
    const task = await asTenant(() =>
      app.app.get(PutawayTaskService).createFromReceipt(scene.orgId, scene.userId, {
        grnId,
      }),
    );

    const lines = await asTenant(() =>
      db().execute<{ id: number }>(sql`
        SELECT id FROM inv_putaway_task_lines
        WHERE org_id = ${scene.orgId} AND task_id = ${task.taskId}
        ORDER BY id`),
    );
    expect(lines).toHaveLength(1);

    await asTenant(() =>
      app.app.get(PutawayCompleteService).complete(
        scene.orgId,
        scene.userId,
        task.taskId,
        {
          lines: [
            { taskLineId: lines[0]!.id, quantity: "100.0000", toLocationId: scene.storageId },
          ],
        },
        `gp-putaway-${scene.tag}`,
      ),
    );

    // The stock walked from the dock to the aisle. Putaway relocates; it neither
    // creates nor promises anything, so ATP is unmoved on purpose.
    expect(await onHandAt(scene.receivingId)).toBe(0);
    expect(await onHandAt(scene.storageId)).toBe(100);
    expect(await atp()).toBe(100);
    await expectReconciled("putaway");
  }, SLICE_TIMEOUT_MS);

  it("promises 30 to a customer and holds them against the shelf", async () => {
    const so = await asTenant(() =>
      app.app.get(SoCoreService).createSo(scene.orgId, scene.userId, {
        orderDate: "2026-08-03",
        warehouseId: scene.warehouseId,
        currency: "INR",
        lines: [
          {
            productVariantId: scene.variantId,
            quantity: 30,
            unitPrice: "9.0000",
            taxRate: "0",
            lineOrder: 0,
          },
        ],
      }),
    );
    soId = (so as { id: number }).id;

    await asTenant(() =>
      app.app
        .get(SoLifecycleService)
        .confirmSo(scene.orgId, soId, scene.userId, `gp-confirm-${scene.tag}`),
    );

    // `auto_reserve_on_confirm` defaults to true, so confirming IS the reserving
    // step on a default tenant — and `autoReserve` swallows its own failures with
    // a log line, so the only honest way to know it ran is to ask what is still
    // promisable. A silent no-op leaves ATP at 100 and fails here.
    const [reservation] = await asTenant(() =>
      db().execute<{ qty: string }>(sql`
        SELECT COALESCE(SUM(reserved_qty), 0)::text AS qty FROM inv_stock_reservations
        WHERE org_id = ${scene.orgId} AND source_type = 'inv_sales_order'
          AND source_id = ${String(soId)} AND status = 'ACTIVE'`),
    );
    expect(Number(reservation!.qty)).toBe(30);

    // The 30 are still on the shelf but are no longer anyone else's to promise.
    // This is the seam where a private copy of the availability formula silently
    // strands `committed` above `on_hand`, so it is asserted rather than assumed.
    expect(await onHandAt(scene.storageId)).toBe(100);
    expect(await atp()).toBe(70);
    await expectReconciled("reserved");
  }, SLICE_TIMEOUT_MS);

  it("picks the order on a wave and ships it out of the building", async () => {
    const wave = await asTenant(() =>
      app.app.get(PickWaveService).createWave(scene.orgId, scene.userId, {
        warehouseId: scene.warehouseId,
        soIds: [soId],
      }),
    );

    // A wave's pick lists hang off the wave, not off an order — `so_id` is null
    // for a wave, and both packSo and shipSo once looked them up by it and found
    // nothing while every unit suite stayed green. Walking the whole path is the
    // only thing that catches that, so the wave form is used deliberately here.
    const pickLines = await asTenant(() =>
      db().execute<{ id: number }>(sql`
        SELECT id FROM inv_pick_list_lines
        WHERE org_id = ${scene.orgId} AND pick_list_id = ${wave.pickListId}
        ORDER BY id`),
    );
    expect(pickLines).toHaveLength(1);

    await asTenant(() =>
      app.app.get(PickConfirmService).confirmPick(
        scene.orgId,
        scene.userId,
        wave.pickListId,
        { pickLineId: pickLines[0]!.id, quantityPicked: "30.0000" },
        `gp-pick-${scene.tag}`,
      ),
    );
    await expectReconciled("picked");

    await asTenant(() =>
      app.app
        .get(SoFulfillmentService)
        .packSo(scene.orgId, soId, scene.userId, {}, `gp-pack-${scene.tag}`),
    );

    await asTenant(() =>
      app.app
        .get(SoFulfillmentService)
        .shipSo(scene.orgId, soId, scene.userId, `gp-ship-${scene.tag}`, {
          shipDate: "2026-08-04",
        }),
    );

    // Shipping turns a promise into a departure. The 30 leave the shelf and the
    // reservation that held them is consumed, so on_hand falls by 30 while what
    // is promisable does not move at all -- if ATP moved here, the ship path
    // either double-counted the reservation or failed to release it.
    expect(await onHandAt(scene.storageId)).toBe(70);
    expect(await atp()).toBe(70);
    await expectReconciled("shipped");
  }, SLICE_TIMEOUT_MS);

  it("takes 10 back, and they are promisable only once somebody has looked at them", async () => {
    const ret = await asTenant(() =>
      app.app.get(CustomerReturnsService).create(scene.orgId, scene.userId, {
        soId,
        lines: [
          {
            productVariantId: scene.variantId,
            quantity: "10.0000",
            reason: "Customer changed their mind",
          },
        ],
      }),
    );
    const returnId = (ret as { id: number }).id;

    const [line] = await asTenant(() =>
      db().execute<{ id: number }>(sql`
        SELECT id FROM inv_customer_return_lines
        WHERE org_id = ${scene.orgId} AND return_id = ${returnId}`),
    );

    // A disposition asserted before anybody opened the box is a guess, so the
    // line is created without one and nothing has moved yet.
    expect(await atp()).toBe(70);

    await asTenant(() =>
      app.app.get(CustomerReturnsService).inspectLine(scene.orgId, scene.userId, returnId, {
        lineId: line!.id,
        disposition: "RESTOCK",
      }),
    );
    await asTenant(() =>
      app.app
        .get(CustomerReturnsService)
        .approve(scene.orgId, returnId, scene.userId, {}),
    );
    await asTenant(() =>
      app.app
        .get(CustomerReturnsService)
        .post(scene.orgId, returnId, scene.userId, `gp-return-${scene.tag}`, {}),
    );

    // Inspected RESTOCK, so the 10 rejoin sellable stock and are promisable again.
    expect(await atp()).toBe(80);
    await expectReconciled("returned");
  }, SLICE_TIMEOUT_MS);

  it("recalls one lot of two and leaves the other sellable", async () => {
    // A lot-tracked SKU of its own: the recall has to distinguish two lots, and
    // the first SKU tracks nothing.
    lotVariantId = await asTenant(async () => {
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db().execute<T>(q))[0]!;
      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${scene.orgId}, ${`Vial ${scene.tag}`}, ${`V${scene.tag}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, tracking_method, created_by)
        VALUES (${scene.orgId}, ${uom.id}, 'Batched syrup', ${`GPL-${scene.tag}`}, 'LOT', ${scene.userId})
        RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${scene.orgId}, ${product.id}, 'Default', ${`GPL-${scene.tag}-V`}) RETURNING id`);
      return variant.id;
    });

    const po = await asTenant(() =>
      app.app.get(PoService).createPo(scene.orgId, scene.userId, {
        vendorId: scene.vendorId,
        orderDate: "2026-08-05",
        warehouseId: scene.warehouseId,
        currency: "INR",
        lines: [
          {
            productVariantId: lotVariantId,
            quantity: 40,
            unitCost: "2.0000",
            taxRate: "0",
            lineOrder: 0,
          },
        ],
      }),
    );
    const poId = (po as { id: number }).id;
    await asTenant(() => app.app.get(PoService).sendPo(scene.orgId, poId, scene.userId));
    const [poLine] = await asTenant(() =>
      db().execute<{ id: number }>(sql`
        SELECT id FROM inv_po_lines WHERE org_id = ${scene.orgId} AND po_id = ${poId}`),
    );

    // Two deliveries against the one order line, each its own batch. A receipt
    // refuses to carry the same PO line twice -- one delivery is one count of
    // one line -- so two batches means two receipts, which is also how they
    // actually arrive. This is the reason a recall is a lot-level question
    // rather than a SKU-level one.
    const receiveBatch = (n: string, qty: string, lot: string, expiry: string) =>
      asTenant(() =>
        app.app.get(GrnService).receiveGoods(scene.orgId, poId, scene.userId, `gp-lots-${n}-${scene.tag}`, {
          receivedDate: "2026-08-06",
          locationId: scene.storageId,
          lines: [
            {
              poLineId: poLine!.id,
              quantityReceived: qty,
              qualityStatus: "ACCEPTED",
              lotNumber: lot,
              expiryDate: expiry,
            },
          ],
        }),
      );
    await receiveBatch("a", "25.0000", `L-A-${scene.tag}`, "2027-01-31");
    await receiveBatch("b", "15.0000", `L-B-${scene.tag}`, "2027-06-30");
    expect(await atp(lotVariantId)).toBe(40);

    const [badLot] = await asTenant(() =>
      db().execute<{ id: number }>(sql`
        SELECT id FROM inv_lots
        WHERE org_id = ${scene.orgId} AND lot_number = ${`L-A-${scene.tag}`}`),
    );

    // Simulating is a read. If it moved anything, the operator could not use it
    // to decide whether to act -- which is the whole point of a simulation.
    const impact = await asTenant(() =>
      app.app
        .get(RecallSimulationService)
        .simulate(scene.orgId, scene.userId, { lotIds: [badLot!.id] }),
    );
    expect(impact.lots.map((l) => l.lotNumber)).toEqual([`L-A-${scene.tag}`]);
    expect(await atp(lotVariantId)).toBe(40);
    await expectReconciled("recall simulated");

    await asTenant(() =>
      app.app.get(RecallsService).create(
        scene.orgId,
        scene.userId,
        {
          title: `Golden recall ${scene.tag}`,
          selection: { lotIds: [badLot!.id] },
          evidenceVersion: impact.evidenceVersion,
        },
        `gp-recall-${scene.tag}`,
      ),
    );

    // Executing holds the recalled lot and nothing else: 25 come off the market,
    // the 15 in the untouched lot stay sellable, and the first SKU is unaffected.
    expect(await atp(lotVariantId)).toBe(15);
    expect(await atp()).toBe(80);
    await expectReconciled("recall executed");
  }, SLICE_TIMEOUT_MS);
});
