import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { PoService } from "src/modules/inventory/purchase-orders/po.service";
import { GrnService } from "src/modules/inventory/purchase-orders/grn.service";
import { SoCoreService } from "src/modules/inventory/sales-orders/so-core.service";
import { SoFulfillmentService } from "src/modules/inventory/sales-orders/so-fulfillment.service";
import { SoLifecycleService } from "src/modules/inventory/sales-orders/so-lifecycle.service";
import { InvReconciliationService } from "src/modules/inventory/reconciliation/inv-reconciliation.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * The whole flow, once — purchase order to shipment.
 *
 * Every service below already existed. None of them had ever run: the stock
 * engine died on a missing accounting table on the first statement of every
 * command, so the entire write path was unreachable and the tables were empty
 * across 43 organisations. Unit tests passed throughout, because they mock the
 * database.
 *
 * This drives the real services in the real order a warehouse works in, and
 * asserts after every step that the ledger still explains the projection. A step
 * that silently does nothing shows up as stock that did not move.
 *
 *   pnpm test:e2e:seeded --testPathPattern=order-to-ship
 */

const PERMISSIONS = [
  "inventory:warehouses:scope-all",
  "inventory:stock:read",
  "inventory:stock:reserve",
  "inventory:stock:reconcile",
  "inventory:purchase-orders:create",
  "inventory:purchase-orders:receive",
  "inventory:sales-orders:create",
  "inventory:sales-orders:confirm",
  "inventory:sales-orders:ship",
] as const;

interface Scene {
  orgId: string;
  userId: string;
  variantId: number;
  productId: number;
  vendorId: number;
  warehouseId: number;
  locationId: number;
}

describe("[seeded-e2e] purchase order to shipment", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  /** on_hand, committed and outgoing for the one grain this flow moves. */
  async function stock() {
    const rows = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{ on_hand: string; committed: string; outgoing: string; ledger: number }>(sql`
        SELECT
          COALESCE(SUM(sl.on_hand), 0)::text AS on_hand,
          COALESCE(SUM(sl.committed), 0)::text AS committed,
          COALESCE(SUM(sl.outgoing_qty), 0)::text AS outgoing,
          (SELECT count(*)::int FROM inv_stock_transactions t WHERE t.org_id = ${scene.orgId}) AS ledger
        FROM inv_stock_levels sl
        WHERE sl.org_id = ${scene.orgId} AND sl.product_variant_id = ${scene.variantId}`),
    );
    const row = rows[0]!;
    return {
      onHand: Number(row.on_hand),
      committed: Number(row.committed),
      outgoing: Number(row.outgoing),
      ledgerRows: row.ledger,
    };
  }

  /** The projection still follows from the movements. Asserted after every step. */
  async function expectReconciled() {
    const report = await asTenant(() =>
      app.app
        .get(InvReconciliationService)
        .report(scene.orgId, scene.userId, { limit: 100 }),
    );
    expect(report.drift).toEqual([]);
  }

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("keeper", { permissionKeys: PERMISSIONS })
      .build();
    teardown = () => seeded.teardown();

    const tag = randomUUID().slice(0, 6);
    const db = app.app.get<Db>(DRIZZLE);
    const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
      (await db.execute<T>(q))[0]!;

    scene = await runInNewTenantTransaction(db, seeded.orgId, async () => {
      const userId = seeded.members.keeper!.userId;
      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Flow widget', ${`FLOW-${tag}`}, ${userId}) RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`FLOW-${tag}-V1`}) RETURNING id`);
      const vendor = await one<{ id: number }>(sql`
        INSERT INTO inv_vendors (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Flow vendor', ${`FV${tag}`}, ${userId}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Flow warehouse', ${`FW${tag}`}, ${userId}) RETURNING id`);
      const location = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Bin', ${`FB${tag}`}, 'BIN') RETURNING id`);
      return {
        orgId: seeded.orgId,
        userId,
        productId: product.id,
        variantId: variant.id,
        vendorId: vendor.id,
        warehouseId: warehouse.id,
        locationId: location.id,
      };
    });
  }, 180_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  it(
    "receives against a purchase order, then reserves, picks, packs and ships it",
    async () => {
      const po = await asTenant(() =>
        app.app.get(PoService).createPo(scene.orgId, scene.userId, {
          vendorId: scene.vendorId,
          orderDate: "2026-06-01",
          warehouseId: scene.warehouseId,
          currency: "INR",
          lines: [
            { productVariantId: scene.variantId, quantity: 100, unitCost: "10.0000", taxRate: "0", lineOrder: 0 },
          ],
        }),
      );
      expect(po.id).toBeGreaterThan(0);

      // Goods are received against a sent order, never a draft. Approval is a
      // separate gate this organisation does not require, so sending is the
      // transition — approvePo refuses outright when requirePoApproval is off.
      await asTenant(() => app.app.get(PoService).sendPo(scene.orgId, po.id, scene.userId));

      const before = await stock();
      expect(before.onHand).toBe(0);

      const poLines = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ id: number }>(sql`
          SELECT id FROM inv_po_lines WHERE org_id = ${scene.orgId} AND po_id = ${po.id}`),
      );
      expect(poLines).toHaveLength(1);

      // ── receive ────────────────────────────────────────────────────────────
      await asTenant(() =>
        app.app.get(GrnService).receiveGoods(scene.orgId, po.id, scene.userId, `grn-${po.id}`, {
          receivedDate: "2026-06-02",
          locationId: scene.locationId,
          lines: [{ poLineId: poLines[0]!.id, quantityReceived: "100.0000", qualityStatus: "ACCEPTED" }],
        }),
      );

      const received = await stock();
      expect(received.onHand).toBe(100);
      expect(received.ledgerRows).toBeGreaterThan(before.ledgerRows);
      await expectReconciled();

      // ── order ──────────────────────────────────────────────────────────────
      const so = await asTenant(() =>
        app.app.get(SoCoreService).createSo(scene.orgId, scene.userId, {
          orderDate: "2026-06-03",
          warehouseId: scene.warehouseId,
          currency: "INR",
          lines: [
            { productVariantId: scene.variantId, quantity: 40, unitPrice: "25.0000", taxRate: "0", lineOrder: 0 },
          ],
        }),
      );

      const soLines = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ id: number }>(sql`
          SELECT id FROM inv_so_lines WHERE org_id = ${scene.orgId} AND so_id = ${so.id}`),
      );
      expect(soLines).toHaveLength(1);

      // ── confirm, which reserves ────────────────────────────────────────────
      // `autoReserveOnConfirm` is on by default, so confirming an order also
      // takes the stock. Calling reserveSo afterwards is refused, because the
      // order has already left CONFIRMED — the reservation is part of confirming,
      // not a step after it.
      await asTenant(() =>
        app.app.get(SoLifecycleService).confirmSo(scene.orgId, so.id, scene.userId),
      );

      const reserved = await stock();
      // Reserving commits stock without moving it: the goods are still on the
      // shelf, they are just no longer promisable to anybody else.
      expect(reserved.onHand).toBe(100);
      expect(reserved.committed).toBe(40);
      await expectReconciled();

      // ── pick ───────────────────────────────────────────────────────────────
      await asTenant(() =>
        app.app.get(SoFulfillmentService).pickSo(scene.orgId, so.id, scene.userId, {
          lines: [
            { soLineId: soLines[0]!.id, locationId: scene.locationId, quantityPicked: "40.0000" },
          ],
        }),
      );
      await expectReconciled();

      // ── pack ───────────────────────────────────────────────────────────────
      await asTenant(() =>
        app.app.get(SoFulfillmentService).packSo(scene.orgId, so.id, scene.userId, { weight: 12 }),
      );
      await expectReconciled();

      // ── ship ───────────────────────────────────────────────────────────────
      await asTenant(() =>
        app.app.get(SoFulfillmentService).shipSo(scene.orgId, so.id, scene.userId, `ship-${so.id}`, {
          shipDate: "2026-06-04",
        }),
      );

      const shipped = await stock();
      // Shipping is the step that actually removes stock. Everything before it
      // moved paperwork.
      expect(shipped.onHand).toBe(60);
      expect(shipped.committed).toBe(0);
      await expectReconciled();

      const finalSo = await asTenant(() => app.app.get(SoCoreService).getSo(scene.orgId, so.id));
      expect(finalSo.status).toBe("SHIPPED");
    },
    600_000,
  );

  it("partially reserves when the order asks for more than is on the shelf", async () => {
    const so = await asTenant(() =>
      app.app.get(SoCoreService).createSo(scene.orgId, scene.userId, {
        orderDate: "2026-06-05",
        warehouseId: scene.warehouseId,
        currency: "INR",
        lines: [
          // 60 remain on the shelf after the flow above; ask for more than that.
          { productVariantId: scene.variantId, quantity: 500, unitPrice: "25.0000", taxRate: "0", lineOrder: 0 },
        ],
      }),
    );

    await asTenant(() =>
      app.app.get(SoLifecycleService).confirmSo(scene.orgId, so.id, scene.userId),
    );

    const confirmed = await asTenant(() => app.app.get(SoCoreService).getSo(scene.orgId, so.id));
    // Asking for 500 against 60 on the shelf is not an error — it is a partial
    // reservation, and the order says so rather than silently promising stock
    // that is not there.
    expect(confirmed.status).toBe("PARTIALLY_RESERVED");

    const after = await stock();
    // 100 received less the 40 the first flow shipped. Nothing moved here:
    // reserving commits stock, it does not issue it.
    expect(after.onHand).toBe(60);
    expect(after.committed).toBeLessThanOrEqual(60);
    await expectReconciled();
  });

  it("replays a receipt rather than receiving it twice", async () => {
    const po = await asTenant(() =>
      app.app.get(PoService).createPo(scene.orgId, scene.userId, {
        vendorId: scene.vendorId,
        orderDate: "2026-06-06",
        warehouseId: scene.warehouseId,
        currency: "INR",
        lines: [{ productVariantId: scene.variantId, quantity: 10, unitCost: "10.0000", taxRate: "0", lineOrder: 0 }],
      }),
    );
    await asTenant(() => app.app.get(PoService).sendPo(scene.orgId, po.id, scene.userId));
    const lines = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{ id: number }>(sql`
        SELECT id FROM inv_po_lines WHERE org_id = ${scene.orgId} AND po_id = ${po.id}`),
    );
    const key = `grn-replay-${po.id}`;
    const receive = () =>
      asTenant(() =>
        app.app.get(GrnService).receiveGoods(scene.orgId, po.id, scene.userId, key, {
          receivedDate: "2026-06-06",
          locationId: scene.locationId,
          lines: [{ poLineId: lines[0]!.id, quantityReceived: "10.0000", qualityStatus: "ACCEPTED" }],
        }),
      );

    const before = await stock();
    await receive();
    const once = await stock();
    expect(once.onHand).toBe(before.onHand + 10);

    // The same key again is a retry, not a second delivery.
    await receive().catch(() => undefined);
    const twice = await stock();
    expect(twice.onHand).toBe(once.onHand);
    await expectReconciled();
  });
});
