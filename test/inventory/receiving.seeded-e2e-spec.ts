import { randomUUID } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { PoService } from "src/modules/inventory/purchase-orders/po.service";
import { GrnService } from "src/modules/inventory/purchase-orders/grn.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * INV-201 — receiving, and what a receipt is allowed to forget.
 *
 * Two defects sit behind these probes. The quantity a receiver typed reached
 * the stock ledger as `Number(qty).toFixed(4)`, which is float arithmetic on
 * the one value the inventory PRD forbids it for; and the receipt recorded what
 * arrived while forgetting what was expected, so a short delivery was
 * indistinguishable from a partial one everybody had agreed to.
 */
const PERMISSIONS = [
  "inventory:warehouses:scope-all",
  "inventory:purchase-orders:create",
  "inventory:purchase-orders:receive",
  "inventory:stock:read",
] as const;

interface Scene {
  orgId: string;
  userId: string;
  variantId: number;
  warehouseId: number;
  locationId: number;
  vendorId: number;
}

describe("[seeded-e2e] goods receipt discrepancies and exact quantities", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  /** A sent order for `ordered` units, and the id of its single line. */
  async function sentOrder(ordered: number) {
    const po = await asTenant(() =>
      app.app.get(PoService).createPo(scene.orgId, scene.userId, {
        vendorId: scene.vendorId,
        orderDate: "2026-08-01",
        warehouseId: scene.warehouseId,
        currency: "INR",
        lines: [
          {
            productVariantId: scene.variantId,
            quantity: ordered,
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
    return { poId: po.id, poLineId: line!.id };
  }

  const receive = (
    poId: number,
    line: Record<string, unknown>,
  ): Promise<unknown> =>
    asTenant(() =>
      app.app.get(GrnService).receiveGoods(
        scene.orgId,
        poId,
        scene.userId,
        `grn-${randomUUID()}`,
        {
          receivedDate: "2026-08-02",
          locationId: scene.locationId,
          lines: [line],
        } as never,
      ),
    );

  const grnLinesFor = (poLineId: number) =>
    asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{
        quantity_received: string;
        quantity_expected: string | null;
        discrepancy_reason: string | null;
      }>(sql`
        SELECT quantity_received, quantity_expected, discrepancy_reason
        FROM inv_grn_lines
        WHERE org_id = ${scene.orgId} AND po_line_id = ${poLineId}
        ORDER BY id`),
    );

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("receiver", { permissionKeys: PERMISSIONS })
      .build();
    teardown = () => seeded.teardown();

    const tag = randomUUID().slice(0, 6);
    const db = app.app.get<Db>(DRIZZLE);
    scene = await runInNewTenantTransaction(db, seeded.orgId, async () => {
      const userId = seeded.members["receiver"]!.userId;
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db.execute<T>(q))[0]!;
      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, tracking_method, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Received goods', ${`RC-${tag}`}, 'NONE', ${userId})
        RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`RC-${tag}-V`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Main', ${`MN${tag}`}, ${userId}) RETURNING id`);
      const location = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Dock', ${`DK${tag}`}, 'BIN') RETURNING id`);
      const vendor = await one<{ id: number }>(sql`
        INSERT INTO inv_vendors (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Perf vendor', ${`VN${tag}`}, ${userId}) RETURNING id`);
      return {
        orgId: seeded.orgId,
        userId,
        variantId: variant.id,
        warehouseId: warehouse.id,
        locationId: location.id,
        vendorId: vendor.id,
      };
    });
  }, 240_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  it("carries a fractional quantity to the ledger without rounding it", async () => {
    // 33.3333 is chosen because it survives neither a float round-trip nor a
    // toFixed(2) intact. The ledger row must read back exactly what arrived.
    const { poId, poLineId } = await sentOrder(100);
    await receive(poId, {
      poLineId,
      quantityReceived: "33.3333",
      qualityStatus: "ACCEPTED",
    });

    const [grnLine] = await grnLinesFor(poLineId);
    expect(grnLine!.quantity_received).toBe("33.3333");

    const [ledger] = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{ quantity_change: string }>(sql`
        SELECT quantity_change FROM inv_stock_transactions
        WHERE org_id = ${scene.orgId} AND product_variant_id = ${scene.variantId}
        ORDER BY id DESC LIMIT 1`),
    );
    expect(ledger!.quantity_change).toBe("33.3333");
  });

  it("records what the line still owed, so a short receipt is legible later", async () => {
    const { poId, poLineId } = await sentOrder(50);
    await receive(poId, {
      poLineId,
      quantityReceived: "20.0000",
      qualityStatus: "ACCEPTED",
      discrepancyReason: "SHORT",
    });

    const [grnLine] = await grnLinesFor(poLineId);
    expect(grnLine!.quantity_expected).toBe("50.0000");
    expect(grnLine!.quantity_received).toBe("20.0000");
    expect(grnLine!.discrepancy_reason).toBe("SHORT");
  });

  it("leaves no discrepancy on a line that matched", async () => {
    // The control. Without it, every assertion above would also pass against a
    // service that stamped a reason on every receipt it ever wrote.
    const { poId, poLineId } = await sentOrder(40);
    await receive(poId, {
      poLineId,
      quantityReceived: "40.0000",
      qualityStatus: "ACCEPTED",
    });

    const [grnLine] = await grnLinesFor(poLineId);
    expect(grnLine!.discrepancy_reason).toBeNull();
    expect(grnLine!.quantity_expected).toBe("40.0000");
  });

  it("expects less on a second receipt, because the first one counted", async () => {
    // The snapshot is per receipt, not per line: after 30 of 100 arrives the
    // next delivery is expected to owe 70, and a receipt that recorded the
    // original 100 both times would be lying about the second one.
    const { poId, poLineId } = await sentOrder(100);
    await receive(poId, { poLineId, quantityReceived: "30.0000", qualityStatus: "ACCEPTED" });
    await receive(poId, { poLineId, quantityReceived: "70.0000", qualityStatus: "ACCEPTED" });

    const lines = await grnLinesFor(poLineId);
    expect(lines.map((l) => l.quantity_expected)).toEqual(["100.0000", "70.0000"]);
  });

  it("refuses a receipt beyond the over-receipt tolerance", async () => {
    // Tolerance defaults to 0%, so anything past the outstanding quantity is
    // refused rather than silently absorbed.
    const { poId, poLineId } = await sentOrder(10);
    await expect(
      receive(poId, {
        poLineId,
        quantityReceived: "10.0001",
        qualityStatus: "ACCEPTED",
      }),
    ).rejects.toThrow(BadRequestException);

    expect(await grnLinesFor(poLineId)).toHaveLength(0);
  });

  it("accepts exactly the outstanding quantity at the tolerance boundary", async () => {
    // The boundary the epsilon used to blur. Without this the refusal above
    // would also pass against a guard that rejected every full receipt.
    const { poId, poLineId } = await sentOrder(10);
    await receive(poId, { poLineId, quantityReceived: "10.0000", qualityStatus: "ACCEPTED" });

    const [grnLine] = await grnLinesFor(poLineId);
    expect(grnLine!.quantity_received).toBe("10.0000");
    expect(grnLine!.discrepancy_reason).toBeNull();
  });

  describe("a receipt sent twice under one key", () => {
    const receiveWithKey = (poId: number, key: string, line: Record<string, unknown>) =>
      asTenant(() =>
        app.app.get(GrnService).receiveGoods(scene.orgId, poId, scene.userId, key, {
          receivedDate: "2026-08-02",
          locationId: scene.locationId,
          lines: [line],
        } as never),
      );

    const receivedOnLine = async (poLineId: number) => {
      const [row] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ quantity_received: string }>(sql`
          SELECT quantity_received FROM inv_po_lines
          WHERE org_id = ${scene.orgId} AND id = ${poLineId}`),
      );
      return row!.quantity_received;
    };

    it("posts one receipt when nothing on the delivery was accepted", async () => {
      // A3, and the branch that had no protection at all. With every line
      // REJECTED there are no movements, so the engine — which is where the key
      // was claimed — is never called. The retry therefore ran the whole
      // receipt again: a second GRN document, and the same twelve units counted
      // against the order twice, which is how a purchase order closes as
      // RECEIVED against goods nobody accepted.
      const { poId, poLineId } = await sentOrder(20);
      const key = `grn-rejected-${randomUUID()}`;
      const line = {
        poLineId,
        quantityReceived: "12.0000",
        qualityStatus: "REJECTED",
        rejectionReason: "Crushed in transit",
      };

      await receiveWithKey(poId, key, line);
      await receiveWithKey(poId, key, line);

      expect(await grnLinesFor(poLineId)).toHaveLength(1);
      expect(await receivedOnLine(poLineId)).toBe("12.0000");
    });

    it("replays an accepted receipt rather than refusing it", async () => {
      // The other half. Where movements did exist the retry was refused, and
      // only by accident: the engine hashes the command, the command carries
      // the new GRN's id, so an identical retry looked like a different request
      // and got 422. Right answer, wrong reason, wrong error — and it stopped
      // being right the moment a command stopped naming a fresh row.
      const { poId, poLineId } = await sentOrder(20);
      const key = `grn-accepted-${randomUUID()}`;
      const line = { poLineId, quantityReceived: "8.0000", qualityStatus: "ACCEPTED" };

      const first = await receiveWithKey(poId, key, line);
      const second = await receiveWithKey(poId, key, line);

      expect((second as { id: number }).id).toBe((first as { id: number }).id);
      expect(await grnLinesFor(poLineId)).toHaveLength(1);
      expect(await receivedOnLine(poLineId)).toBe("8.0000");

      // One movement, because the engine's own claim held; one document,
      // because the command's claim now holds too.
      const [ledger] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM inv_stock_transactions
          WHERE org_id = ${scene.orgId} AND idempotency_key = ${`${key}:stock`}`),
      );
      expect(ledger!.n).toBe(1);
    });
  });

  describe("a terminal purchase order stops being expected", () => {
    const onOrder = async () => {
      const [row] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ total: string }>(sql`
          SELECT COALESCE(SUM(COALESCE(on_order, 0)), 0)::text AS total
          FROM inv_stock_levels
          WHERE org_id = ${scene.orgId} AND product_variant_id = ${scene.variantId}`),
      );
      return Number(row!.total);
    };

    it("takes the outstanding quantity back out when the order is cancelled", async () => {
      // Sending books the goods as expected; nothing took them back out again
      // when the order was abandoned. Replenishment then read a permanent
      // phantom arrival and under-ordered that variant every cycle.
      const before = await onOrder();
      const { poId } = await sentOrder(30);
      expect(await onOrder()).toBe(before + 30);

      await asTenant(() =>
        app.app.get(PoService).cancelPo(scene.orgId, poId, scene.userId),
      );
      expect(await onOrder()).toBe(before);
    });

    it("takes the undelivered remainder back out when a partial order is closed", async () => {
      const before = await onOrder();
      const { poId, poLineId } = await sentOrder(20);
      await receive(poId, { poLineId, quantityReceived: "8.0000", qualityStatus: "ACCEPTED" });

      // 8 arrived, so 12 are still expected — until the buyer closes the order,
      // at which point nobody is ever going to deliver them.
      expect(await onOrder()).toBe(before + 12);

      await asTenant(() =>
        app.app.get(PoService).closePo(scene.orgId, poId, scene.userId),
      );
      expect(await onOrder()).toBe(before);
    });
  });
});
