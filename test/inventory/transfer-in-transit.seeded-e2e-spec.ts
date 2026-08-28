import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { InvStockService } from "src/modules/inventory/stock/inv-stock.service";
import { InvStockTransfersService } from "src/modules/inventory/stock/inv-stock-transfers.service";
import { TRANSIT_LOCATION_CODE } from "src/modules/inventory/stock-engine/transit-location.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * A2 — goods in transit are somewhere.
 *
 * A transfer used to post TRANSFER_OUT at dispatch and TRANSFER_IN at
 * completion. In between, the units were on no stock level anywhere: the org's
 * total on-hand dropped by the transferred quantity for the whole journey and
 * inventory valuation dropped with it, and no screen in the product could say
 * where the goods were.
 *
 * These probes hold both halves of the fix at once, because either alone is
 * wrong. Conservation without a sellability rule would be worse than the bug it
 * replaces — stock that is physically in a van, offered to the next customer.
 * Sellability without conservation is the bug. So: the goods are visible in
 * transit, the org's total never dips, and not one unit of it is promisable
 * from anywhere while it is there.
 */
interface Scene {
  orgId: string;
  userId: string;
  variantId: number;
  sourceWarehouseId: number;
  destWarehouseId: number;
  sourceLocationId: number;
  destLocationId: number;
}

const SEEDED_QTY = 100;
const TRANSFER_QTY = 40;
const SHORT_TRANSFER_QTY = 20;
const SHORT_RECEIPT_QTY = 15;

describe("[seeded-e2e] stock in transit", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;
  let transferId: number;

  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  /** Availability the way every ATP surface reports it, org-wide or per warehouse. */
  const availability = async (warehouseId?: number) => {
    const result = await asTenant(() =>
      app.app.get(InvStockService).getAvailability(scene.orgId, scene.userId, {
        variantId: scene.variantId,
        ...(warehouseId === undefined ? {} : { warehouseId }),
      } as never),
    );
    const typed = result as { onHand: unknown; available: unknown };
    return { onHand: Number(typed.onHand), available: Number(typed.available) };
  };

  /** On-hand at one location, straight off the projection. */
  const onHandAt = async (locationId: number) => {
    const [row] = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{ on_hand: string }>(sql`
        SELECT COALESCE(SUM(on_hand), 0)::text AS on_hand
        FROM inv_stock_levels
        WHERE org_id = ${scene.orgId}
          AND product_variant_id = ${scene.variantId}
          AND location_id = ${locationId}`),
    );
    return Number(row!.on_hand);
  };

  /** The transit location of the source warehouse, as the service names it. */
  const transitLocationId = async () => {
    const [row] = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{ id: number }>(sql`
        SELECT id FROM inv_locations
        WHERE org_id = ${scene.orgId}
          AND warehouse_id = ${scene.sourceWarehouseId}
          AND code = ${TRANSIT_LOCATION_CODE}`),
    );
    return row ? Number(row.id) : null;
  };

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("keeper", {
        permissionKeys: [
          "inventory:warehouses:scope-all",
          "inventory:stock:read",
          "inventory:stock:adjust",
          "inventory:stock:transfer",
        ],
      })
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
        VALUES (${seeded.orgId}, ${uom.id}, 'Travelling goods', ${`TR-${tag}`}, ${userId})
        RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`TR-${tag}-V`}) RETURNING id`);
      const sourceWarehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Origin', ${`OR${tag}`}, ${userId}) RETURNING id`);
      const destWarehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Arrival', ${`AR${tag}`}, ${userId}) RETURNING id`);
      const sourceLocation = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable)
        VALUES (${seeded.orgId}, ${sourceWarehouse.id}, 'Origin bin', ${`OB${tag}`}, 'BIN', true)
        RETURNING id`);
      const destLocation = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable)
        VALUES (${seeded.orgId}, ${destWarehouse.id}, 'Arrival bin', ${`AB${tag}`}, 'BIN', true)
        RETURNING id`);
      return {
        orgId: seeded.orgId,
        userId,
        variantId: variant.id,
        sourceWarehouseId: sourceWarehouse.id,
        destWarehouseId: destWarehouse.id,
        sourceLocationId: sourceLocation.id,
        destLocationId: destLocation.id,
      };
    });

    await asTenant(() =>
      app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
        idempotencyKey: `transit-seed-${tag}`,
        sourceType: "transit-fixture",
        sourceId: tag,
        movements: [
          {
            transactionType: "PURCHASE",
            productVariantId: scene.variantId,
            locationId: scene.sourceLocationId,
            quantityDelta: `${SEEDED_QTY}.0000`,
            unitCost: "2.0000",
          },
        ],
      }),
    );

    const transfer = await asTenant(() =>
      app.app.get(InvStockTransfersService).createTransfer(scene.orgId, scene.userId, {
        fromLocationId: scene.sourceLocationId,
        toLocationId: scene.destLocationId,
        fromWarehouseId: scene.sourceWarehouseId,
        toWarehouseId: scene.destWarehouseId,
        lines: [{ productVariantId: scene.variantId, quantity: TRANSFER_QTY }],
      } as never),
    );
    transferId = (transfer as { id: number }).id;
  }, 300_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  it("starts with everything at the source and everything promisable", async () => {
    // The control. Every movement below is only meaningful against this.
    const org = await availability();
    expect(org.onHand).toBe(SEEDED_QTY);
    expect(org.available).toBe(SEEDED_QTY);
    expect(await onHandAt(scene.sourceLocationId)).toBe(SEEDED_QTY);
    expect(await onHandAt(scene.destLocationId)).toBe(0);
  });

  describe("after dispatch", () => {
    beforeAll(async () => {
      await asTenant(() =>
        app.app
          .get(InvStockTransfersService)
          .dispatchTransfer(
            scene.orgId,
            scene.userId,
            transferId,
            `transit-dispatch-${transferId}`,
          ),
      );
    }, 120_000);

    it("drops source availability by exactly what left", async () => {
      const source = await availability(scene.sourceWarehouseId);
      expect(source.available).toBe(SEEDED_QTY - TRANSFER_QTY);
      expect(await onHandAt(scene.sourceLocationId)).toBe(SEEDED_QTY - TRANSFER_QTY);
    });

    it("leaves the destination untouched until the goods actually arrive", async () => {
      const dest = await availability(scene.destWarehouseId);
      expect(dest.onHand).toBe(0);
      expect(dest.available).toBe(0);
      expect(await onHandAt(scene.destLocationId)).toBe(0);
    });

    it("parks the goods at the transit location, conserving org-wide on-hand", async () => {
      // The property that did not hold before this unit. The units left one bin
      // and had not reached the other, and the answer to "where are they" was
      // nowhere: the org's total silently fell by 40 for the duration.
      const transitId = await transitLocationId();
      expect(transitId).not.toBeNull();
      expect(await onHandAt(transitId!)).toBe(TRANSFER_QTY);

      const org = await availability();
      expect(org.onHand).toBe(SEEDED_QTY);
    });

    it("does not promise a single unit of it anywhere", async () => {
      // Conservation without this would be worse than the bug: stock physically
      // in a van, offered to the next customer. The org-wide aggregate is the
      // strict test — it sums every location, transit included, and still must
      // not count it.
      const org = await availability();
      expect(org.available).toBe(SEEDED_QTY - TRANSFER_QTY);

      // Nor at the source warehouse, whose transit location it is.
      const source = await availability(scene.sourceWarehouseId);
      expect(source.onHand).toBe(SEEDED_QTY);
      expect(source.available).toBe(SEEDED_QTY - TRANSFER_QTY);
    });

    it("stands the transit stock at a location marked unsellable", async () => {
      // The mechanism, not just the number: availability excludes it because of
      // a flag on the location, so anything new that sums stock levels inherits
      // the rule instead of having to remember it.
      const transitId = await transitLocationId();
      const [row] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{
          location_type: string;
          is_sellable: boolean | null;
          is_pickable: boolean | null;
          is_receivable: boolean | null;
          capacity: string | null;
        }>(sql`
          SELECT location_type, is_sellable, is_pickable, is_receivable, capacity
          FROM inv_locations WHERE id = ${transitId}`),
      );
      expect(row!.location_type).toBe("TRANSIT");
      expect(row!.is_sellable).toBe(false);
      expect(row!.is_pickable).toBe(false);
      expect(row!.is_receivable).toBe(false);
      expect(row!.capacity).toBeNull();
    });
  });

  describe("after complete", () => {
    beforeAll(async () => {
      const lines = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ id: number }>(sql`
          SELECT id FROM inv_stock_transfer_lines WHERE transfer_id = ${transferId}`),
      );
      await asTenant(() =>
        app.app.get(InvStockTransfersService).completeTransfer(
          scene.orgId,
          scene.userId,
          transferId,
          { lines: [{ transferLineId: Number(lines[0]!.id), quantityReceived: TRANSFER_QTY }] },
          `transit-complete-${transferId}`,
        ),
      );
    }, 120_000);

    it("empties the transit location", async () => {
      const transitId = await transitLocationId();
      expect(await onHandAt(transitId!)).toBe(0);
    });

    it("raises destination availability by what arrived", async () => {
      expect(await onHandAt(scene.destLocationId)).toBe(TRANSFER_QTY);
      const dest = await availability(scene.destWarehouseId);
      expect(dest.onHand).toBe(TRANSFER_QTY);
      expect(dest.available).toBe(TRANSFER_QTY);
    });

    it("has conserved on-hand, and made the goods promisable again", async () => {
      const org = await availability();
      expect(org.onHand).toBe(SEEDED_QTY);
      expect(org.available).toBe(SEEDED_QTY);
    });
  });

  describe("a short receipt", () => {
    let shortTransferId: number;

    beforeAll(async () => {
      const transfer = await asTenant(() =>
        app.app.get(InvStockTransfersService).createTransfer(scene.orgId, scene.userId, {
          fromLocationId: scene.sourceLocationId,
          toLocationId: scene.destLocationId,
          fromWarehouseId: scene.sourceWarehouseId,
          toWarehouseId: scene.destWarehouseId,
          lines: [{ productVariantId: scene.variantId, quantity: SHORT_TRANSFER_QTY }],
        } as never),
      );
      shortTransferId = (transfer as { id: number }).id;

      await asTenant(() =>
        app.app
          .get(InvStockTransfersService)
          .dispatchTransfer(
            scene.orgId,
            scene.userId,
            shortTransferId,
            `transit-dispatch-short-${shortTransferId}`,
          ),
      );

      const lines = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ id: number }>(sql`
          SELECT id FROM inv_stock_transfer_lines WHERE transfer_id = ${shortTransferId}`),
      );
      await asTenant(() =>
        app.app.get(InvStockTransfersService).completeTransfer(
          scene.orgId,
          scene.userId,
          shortTransferId,
          {
            lines: [
              { transferLineId: Number(lines[0]!.id), quantityReceived: SHORT_RECEIPT_QTY },
            ],
          },
          `transit-complete-short-${shortTransferId}`,
        ),
      );
    }, 180_000);

    it("moves only what was actually received to the destination", async () => {
      expect(await onHandAt(scene.destLocationId)).toBe(TRANSFER_QTY + SHORT_RECEIPT_QTY);
    });

    it("leaves the shortfall standing in transit rather than writing it off", async () => {
      // A short receipt is a real event, not an error. Zeroing the remainder
      // would make the missing units vanish from the org's total a second time,
      // which is precisely the defect this unit exists to close. They stay
      // where they are -- on hand, unsellable, and countable by anyone asking
      // what happened to them.
      const transitId = await transitLocationId();
      expect(await onHandAt(transitId!)).toBe(SHORT_TRANSFER_QTY - SHORT_RECEIPT_QTY);
    });

    it("still conserves org-wide on-hand, and still promises none of the shortfall", async () => {
      const org = await availability();
      expect(org.onHand).toBe(SEEDED_QTY);
      expect(org.available).toBe(SEEDED_QTY - (SHORT_TRANSFER_QTY - SHORT_RECEIPT_QTY));
    });
  });

  /**
   * The cost has to survive the waypoint.
   *
   * A dispatch now writes two ledger rows per line — the issue at the source bin
   * and a receipt at the transit location — and the line's `dispatched_unit_cost`
   * must be read off the first, not the second. Reading the second would cost
   * the destination from the waypoint's own inbound number and lose the source
   * layers entirely.
   *
   * Under weighted average the two numbers are equal by construction, so the
   * mistake would be invisible. This fixture is FIFO with two layers at
   * different costs and a transfer big enough to cross the boundary between
   * them, which is the smallest scene where they differ.
   */
  describe("costing across the waypoint", () => {
    const OLD_LAYER = { qty: 60, cost: "2.0000" };
    const NEW_LAYER = { qty: 40, cost: "5.0000" };
    const FIFO_TRANSFER_QTY = 70;
    /** 60 @ 2 + 10 @ 5 = 170, over 70 units. */
    const BLENDED_COST = "2.4286";

    let fifoVariantId: number;
    let fifoTransferId: number;

    beforeAll(async () => {
      const tag = randomUUID().slice(0, 6);
      const db = app.app.get<Db>(DRIZZLE);
      fifoVariantId = await runInNewTenantTransaction(db, scene.orgId, async () => {
        const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
          (await db.execute<T>(q))[0]!;
        const uom = await one<{ id: number }>(sql`
          INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
          VALUES (${scene.orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
        const product = await one<{ id: number }>(sql`
          INSERT INTO inv_products (org_id, uom_id, name, sku, costing_method, created_by)
          VALUES (${scene.orgId}, ${uom.id}, 'Layered goods', ${`FI-${tag}`}, 'FIFO', ${scene.userId})
          RETURNING id`);
        const variant = await one<{ id: number }>(sql`
          INSERT INTO inv_product_variants (org_id, product_id, name, sku)
          VALUES (${scene.orgId}, ${product.id}, 'Default', ${`FI-${tag}-V`}) RETURNING id`);
        return Number(variant.id);
      });

      for (const [index, layer] of [OLD_LAYER, NEW_LAYER].entries()) {
        await asTenant(() =>
          app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
            idempotencyKey: `fifo-seed-${tag}-${index}`,
            sourceType: "transit-fixture",
            sourceId: `${tag}-${index}`,
            movements: [
              {
                transactionType: "PURCHASE",
                productVariantId: fifoVariantId,
                locationId: scene.sourceLocationId,
                quantityDelta: `${layer.qty}.0000`,
                unitCost: layer.cost,
              },
            ],
          }),
        );
      }

      const transfer = await asTenant(() =>
        app.app.get(InvStockTransfersService).createTransfer(scene.orgId, scene.userId, {
          fromLocationId: scene.sourceLocationId,
          toLocationId: scene.destLocationId,
          fromWarehouseId: scene.sourceWarehouseId,
          toWarehouseId: scene.destWarehouseId,
          lines: [{ productVariantId: fifoVariantId, quantity: FIFO_TRANSFER_QTY }],
        } as never),
      );
      fifoTransferId = (transfer as { id: number }).id;

      await asTenant(() =>
        app.app
          .get(InvStockTransfersService)
          .dispatchTransfer(
            scene.orgId,
            scene.userId,
            fifoTransferId,
            `fifo-dispatch-${fifoTransferId}`,
          ),
      );
    }, 180_000);

    it("stamps the line from the outbound leg, not from the transit receipt", async () => {
      const [line] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ dispatched_unit_cost: string }>(sql`
          SELECT dispatched_unit_cost FROM inv_stock_transfer_lines
          WHERE transfer_id = ${fifoTransferId}`),
      );
      // What the source layers were genuinely consumed at: 60 at 2 and 10 at 5.
      expect(line!.dispatched_unit_cost).toBe(BLENDED_COST);

      const transitId = await transitLocationId();
      const [transitLeg] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ unit_cost: string }>(sql`
          SELECT unit_cost FROM inv_stock_transactions
          WHERE org_id = ${scene.orgId}
            AND product_variant_id = ${fifoVariantId}
            AND transaction_type = 'TRANSFER_IN'
            AND location_id = ${transitId}`),
      );
      // A2. The waypoint is received at exactly what leaving the source
      // consumed, because it inherits the outbound issue's derived cost rather
      // than an estimate taken before the command ran. Under FIFO the estimate
      // was the oldest open layer — 2.0000 here — so the goods entered transit
      // valued at 140.00 against the 170.00 that left, and inventory was
      // understated for the whole journey. The transfer crosses a layer
      // boundary on purpose: under weighted average the two figures agree by
      // construction and this could not tell them apart.
      expect(transitLeg!.unit_cost).toBe(BLENDED_COST);
    });

    it("conserves inventory value across the waypoint, not just quantity", async () => {
      // The property the costs above exist to deliver, asserted directly: what
      // the source gave up is what the waypoint received.
      const [legs] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ out_value: string; in_value: string }>(sql`
          SELECT
            COALESCE(SUM(total_cost) FILTER (WHERE transaction_type = 'TRANSFER_OUT'), 0)::text
              AS out_value,
            COALESCE(SUM(total_cost) FILTER (WHERE transaction_type = 'TRANSFER_IN'), 0)::text
              AS in_value
          FROM inv_stock_transactions
          WHERE org_id = ${scene.orgId}
            AND product_variant_id = ${fifoVariantId}
            AND reference_type = 'inv_transfer'
            AND reference_id = ${String(fifoTransferId)}`),
      );
      // 60 @ 2.00 + 10 @ 5.00 = 170.00 out of the source, 170.00 into transit.
      expect(Number(legs!.out_value)).toBeCloseTo(170, 2);
      expect(Number(legs!.in_value)).toBeCloseTo(170, 2);
    });

    it("costs the destination from the source layers when it arrives", async () => {
      const lines = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ id: number }>(sql`
          SELECT id FROM inv_stock_transfer_lines WHERE transfer_id = ${fifoTransferId}`),
      );
      await asTenant(() =>
        app.app.get(InvStockTransfersService).completeTransfer(
          scene.orgId,
          scene.userId,
          fifoTransferId,
          {
            lines: [
              { transferLineId: Number(lines[0]!.id), quantityReceived: FIFO_TRANSFER_QTY },
            ],
          },
          `fifo-complete-${fifoTransferId}`,
        ),
      );

      const [arrival] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ unit_cost: string }>(sql`
          SELECT unit_cost FROM inv_stock_transactions
          WHERE org_id = ${scene.orgId}
            AND product_variant_id = ${fifoVariantId}
            AND transaction_type = 'TRANSFER_IN'
            AND location_id = ${scene.destLocationId}`),
      );
      expect(arrival!.unit_cost).toBe(BLENDED_COST);

      const transitId = await transitLocationId();
      const [transitLevel] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ on_hand: string }>(sql`
          SELECT COALESCE(SUM(on_hand), 0)::text AS on_hand FROM inv_stock_levels
          WHERE org_id = ${scene.orgId}
            AND product_variant_id = ${fifoVariantId}
            AND location_id = ${transitId}`),
      );
      expect(Number(transitLevel!.on_hand)).toBe(0);
    });
  });
});
