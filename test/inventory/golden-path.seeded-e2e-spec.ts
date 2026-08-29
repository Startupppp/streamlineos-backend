import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { PoService } from "src/modules/inventory/purchase-orders/po.service";
import { GrnService } from "src/modules/inventory/purchase-orders/grn.service";
import { InvStockService } from "src/modules/inventory/stock/inv-stock.service";
import { PutawayTaskService } from "src/modules/inventory/putaway/putaway-task.service";
import { PutawayCompleteService } from "src/modules/inventory/putaway/putaway-complete.service";
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

  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  const db = () => app.app.get<Db>(DRIZZLE);

  /** What the business can promise, through the one availability formula. */
  const atp = async (): Promise<number> => {
    const [row] = await asTenant(() =>
      db().execute<{ available: string }>(sql`
        SELECT COALESCE(SUM(
          sl.on_hand::numeric - sl.committed::numeric
          - COALESCE(sl.blocked_qty, 0)::numeric
          - COALESCE(sl.quality_hold_qty, 0)::numeric
          - COALESCE(sl.outgoing_qty, 0)::numeric
        ), 0)::text AS available
        FROM inv_stock_levels sl
        JOIN inv_locations loc ON loc.org_id = sl.org_id AND loc.id = sl.location_id
        WHERE sl.org_id = ${scene.orgId}
          AND sl.product_variant_id = ${scene.variantId}
          AND loc.is_sellable IS NOT FALSE`),
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
      } as never),
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
  });

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
      } as never),
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
        } as never,
      ),
    );

    grnId = (grn as { id: number }).id;

    expect(await onHandAt(scene.receivingId)).toBe(100);
    expect(await atp()).toBe(100);
    await expectReconciled("received");
  });

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
  });
});
