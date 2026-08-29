import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { HoldsService } from "src/modules/inventory/quality/quality-holds.service";
import { RecallsService } from "src/modules/inventory/quality/quality-recalls.service";
import { CustomerReturnsService } from "src/modules/inventory/returns/customer-returns.service";
import { SoLifecycleService } from "src/modules/inventory/sales-orders/so-lifecycle.service";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { INVENTORY_COMMAND_EVENTS } from "src/modules/inventory/stock-engine/command-events";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { outboxEventsFor } from "test/helpers/outbox-events";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * INV-403 — a quality hold, against the availability formula the rest of the
 * module computes with.
 *
 *   available = on_hand - committed - blocked_qty - quality_hold_qty - outgoing_qty
 *
 * quality_hold_qty is *subtracted from* on_hand, which makes it a subset of
 * on_hand and not a pool beside it. `create` moved the quantity out of ON_HAND
 * and into QUALITY_HOLD, so the same units were deducted twice: holding 10 of
 * 100 left 90 on hand and 80 available, and on_hand under-reported goods that
 * were still sitting on the shelf.
 *
 * A hold is a legal state change, not a physical one. Nothing leaves the
 * building, so on_hand must not move.
 *
 *   pnpm test:e2e:seeded --testPathPattern=quality-hold
 */

const PERMISSIONS = [
  "inventory:warehouses:scope-all",
  "inventory:stock:read",
  "inventory:stock:adjust",
  "inventory:stock:reserve",
  "inventory:quality:read",
  "inventory:quality:inspect",
  "inventory:quality:release",
] as const;

interface Level {
  onHand: string;
  committed: string;
  blocked: string;
  qualityHold: string;
  available: string;
}

interface Scene {
  orgId: string;
  userId: string;
  variantId: number;
  warehouseId: number;
  locationId: number;
  lotId: number;
}

const STOCKED = "100.0000";
const HELD = "10.0000";

describe("[seeded-e2e] quality holds and the availability formula", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  /**
   * The projection, read the way every availability check reads it — summed
   * over the lot, because a disposition may route stock to a different bin
   * and a per-row read would miss it.
   */
  const levelFor = (lotId: number): Promise<Level> =>
    asTenant(async () => {
      const rows = await app.app.get<Db>(DRIZZLE).execute<Level>(sql`
        SELECT SUM(on_hand)::text                       AS "onHand",
               SUM(committed)::text                     AS committed,
               SUM(COALESCE(blocked_qty, 0))::text      AS blocked,
               SUM(COALESCE(quality_hold_qty, 0))::text AS "qualityHold",
               SUM(on_hand - committed
                           - COALESCE(blocked_qty, 0)
                           - COALESCE(quality_hold_qty, 0)
                           - COALESCE(outgoing_qty, 0))::text AS available
        FROM inv_stock_levels
        WHERE org_id = ${scene.orgId} AND lot_id = ${lotId}`);
      return rows[0]!;
    });

  const level = (): Promise<Level> => levelFor(scene.lotId);

  /** A fresh lot in its own bin, stocked through the engine. */
  async function stockedLot(alias: string, qty: string): Promise<{ lotId: number; locationId: number }> {
    const db = app.app.get<Db>(DRIZZLE);
    const suffix = randomUUID().slice(0, 6);
    const made = await runInNewTenantTransaction(db, scene.orgId, async () => {
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db.execute<T>(q))[0]!;
      const location = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
        VALUES (${scene.orgId}, ${scene.warehouseId}, ${alias}, ${`${alias}${suffix}`.slice(0, 20)}, 'BIN')
        RETURNING id`);
      const lot = await one<{ id: number }>(sql`
        INSERT INTO inv_lots (org_id, product_variant_id, lot_number, status)
        VALUES (${scene.orgId}, ${scene.variantId}, ${`${alias}-${suffix}`}, 'ACTIVE') RETURNING id`);
      return { lotId: lot.id, locationId: location.id };
    });
    if (qty !== "0") {
      await runInNewTenantTransaction(db, scene.orgId, async () => {
        await app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
          idempotencyKey: `stocked-${suffix}`,
          sourceType: "hold-fixture",
          sourceId: suffix,
          movements: [
            {
              transactionType: "PURCHASE",
              productVariantId: scene.variantId,
              locationId: made.locationId,
              lotId: made.lotId,
              quantityDelta: qty,
              unitCost: "1.0000",
            },
          ],
        });
      });
    }
    return made;
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
        INSERT INTO inv_products (org_id, uom_id, name, sku, tracking_method, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Held goods', ${`HOLD-${tag}`}, 'LOT', ${userId}) RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`HOLD-${tag}-V1`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Main', ${`MN${tag}`}, ${userId}) RETURNING id`);
      const location = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Bin A', ${`BA${tag}`}, 'BIN') RETURNING id`);
      const lot = await one<{ id: number }>(sql`
        INSERT INTO inv_lots (org_id, product_variant_id, lot_number, status)
        VALUES (${seeded.orgId}, ${variant.id}, ${`L-${tag}`}, 'ACTIVE') RETURNING id`);
      return {
        orgId: seeded.orgId,
        userId,
        variantId: variant.id,
        warehouseId: warehouse.id,
        locationId: location.id,
        lotId: lot.id,
      };
    });

    await runInNewTenantTransaction(db, scene.orgId, async () => {
      await app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
        idempotencyKey: `hold-seed-${tag}`,
        sourceType: "hold-fixture",
        sourceId: tag,
        movements: [
          {
            transactionType: "PURCHASE",
            productVariantId: scene.variantId,
            locationId: scene.locationId,
            lotId: scene.lotId,
            quantityDelta: STOCKED,
            unitCost: "1.0000",
          },
        ],
      });
    });
  }, 180_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  it("starts with everything on hand and everything available", async () => {
    // The control. Without it the assertions below could pass against an
    // empty fixture, where nothing is available because nothing is there.
    const before = await level();
    expect(before.onHand).toBe(STOCKED);
    expect(before.available).toBe(STOCKED);
  });

  describe("placing a hold", () => {
    let holdId: number;

    it("does not move stock out of on_hand", async () => {
      // A hold is a legal state change. The goods have not left the shelf,
      // so a stock count taken after the hold must still find all 100.
      const hold = await asTenant(() =>
        app.app.get(HoldsService).create(scene.orgId, scene.userId, `hold-${randomUUID().slice(0, 8)}`, {
          productVariantId: scene.variantId,
          locationId: scene.locationId,
          lotId: scene.lotId,
          quantity: HELD,
          reason: "Damaged outer packaging",
        } as never),
      );
      holdId = (hold as { id: number }).id;

      const after = await level();
      expect(after.onHand).toBe(STOCKED);
      expect(after.qualityHold).toBe(HELD);
    });

    it("removes the held quantity from available exactly once", async () => {
      // The defect: on_hand was decremented *and* quality_hold_qty was
      // incremented, so the formula subtracted the same 10 units twice and
      // available came out at 80.
      const after = await level();
      expect(after.available).toBe("90.0000");
    });

    it("refuses to allocate the held quantity to a customer", async () => {
      // The projection agreeing is not the same as the allocator honouring it.
      const chosen = await asTenant(() =>
        app.app
          .get(SoLifecycleService)
          .findAvailableLotForLine(scene.orgId, scene.variantId, scene.warehouseId, "95.0000", "FIFO", "BLOCK"),
      );
      expect(chosen).toBeNull();
    });

    it("still allocates what is not held", async () => {
      // Otherwise the refusal above would also pass against a hold that
      // blocked the entire lot, which is a different, wrong behaviour.
      const chosen = await asTenant(() =>
        app.app
          .get(SoLifecycleService)
          .findAvailableLotForLine(scene.orgId, scene.variantId, scene.warehouseId, "90.0000", "FIFO", "BLOCK"),
      );
      expect(chosen).not.toBeNull();
      expect(chosen!.lotId).toBe(scene.lotId);
    });

    it("returns the quantity to available when released, and leaves on_hand alone", async () => {
      await asTenant(() =>
        app.app.get(HoldsService).release(scene.orgId, scene.userId, holdId, `rel-${randomUUID().slice(0, 8)}`),
      );
      const after = await level();
      expect(after.onHand).toBe(STOCKED);
      expect(after.qualityHold).toBe("0.0000");
      expect(after.available).toBe(STOCKED);
    });
  });

  describe("the same hold request, sent twice", () => {
    it("records one hold document and quarantines the quantity once", async () => {
      // A3. The engine claimed the key, so the movement replayed correctly and
      // quality_hold_qty was right — which is exactly why this went unnoticed.
      // The `inv_quality_holds` insert sat outside that claim and ran again, so
      // one quarantined quantity grew a hold document per attempt. Releasing
      // one of them leaves its twin ACTIVE against stock that is no longer
      // held: a hold on nothing that nobody can clear.
      const lot = await stockedLot("retry", "50.0000");
      const key = `hold-retry-${randomUUID().slice(0, 8)}`;
      const request = {
        productVariantId: scene.variantId,
        locationId: lot.locationId,
        lotId: lot.lotId,
        quantity: "10.0000",
        reason: "Sent twice",
      };

      const first = await asTenant(() =>
        app.app.get(HoldsService).create(scene.orgId, scene.userId, key, request as never),
      );
      const second = await asTenant(() =>
        app.app.get(HoldsService).create(scene.orgId, scene.userId, key, request as never),
      );

      expect((second as { id: number }).id).toBe((first as { id: number }).id);

      const [holds] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM inv_quality_holds
          WHERE org_id = ${scene.orgId} AND lot_id = ${lot.lotId}`),
      );
      expect(holds!.n).toBe(1);

      const after = await levelFor(lot.lotId);
      expect(after.onHand).toBe("50.0000");
      expect(after.qualityHold).toBe("10.0000");
    });
  });

  describe("a recall", () => {
    it("quarantines the lot without erasing what is on the shelf", async () => {
      // A recall used to post `-on_hand` to ON_HAND as well as `+on_hand` to
      // QUALITY_HOLD. on_hand went to zero — so the books stopped knowing how
      // much product was physically present, at the one moment that number is
      // the whole point — and available went to *negative* the recalled
      // quantity, because the hold bucket is subtracted from an on_hand that
      // was no longer there.
      const lot = await stockedLot("recall", "40.0000");
      const before = await levelFor(lot.lotId);
      expect(before.onHand).toBe("40.0000");

      await asTenant(() =>
        app.app.get(RecallsService).create(
          scene.orgId,
          scene.userId,
          {
            title: `Recall ${randomUUID().slice(0, 6)}`,
            lines: [{ productVariantId: scene.variantId, lotId: lot.lotId }],
          } as never,
          `recall-${randomUUID().slice(0, 8)}`,
        ),
      );

      const after = await levelFor(lot.lotId);
      expect(after.onHand).toBe("40.0000");
      expect(after.qualityHold).toBe("40.0000");
      expect(after.available).toBe("0.0000");
      expect(Number(after.available)).toBeGreaterThanOrEqual(0);
    });
  });

  describe("a customer return received into quarantine", () => {
    it("adds the goods to on_hand instead of subtracting them from good stock", async () => {
      // The arrival raised only the hold bucket, so available fell by the
      // returned quantity — a return of 5 quietly made 5 units of perfectly
      // good stock unsellable, and a large enough return drove available
      // below zero.
      const lot = await stockedLot("return", "20.0000");
      const before = await levelFor(lot.lotId);
      expect(before.available).toBe("20.0000");

      const returns = app.app.get(CustomerReturnsService);
      const created = await asTenant(() =>
        returns.create(scene.orgId, scene.userId, {
          lines: [
            {
              productVariantId: scene.variantId,
              lotId: lot.lotId,
              quantity: "5.0000",
              disposition: "QUARANTINE",
              targetLocationId: lot.locationId,
            },
          ],
        } as never),
      );
      // INV-209. A disposition named at intake is a guess from the customer's
      // description; posting moves stock, so every line has to have been looked
      // at. The gate is `inspectedAt`, so the return is inspected before it is
      // posted rather than posted on the strength of the intake note.
      const returnId = (created as { id: number }).id;
      const detail = (await asTenant(() => returns.get(scene.orgId, returnId))) as {
        lines: Array<{ id: number }>;
      };
      for (const line of detail.lines) {
        await asTenant(() =>
          returns.inspectLine(scene.orgId, scene.userId, returnId, {
            lineId: line.id,
            disposition: "QUARANTINE",
          }),
        );
      }

      await asTenant(() =>
        returns.post(
          scene.orgId,
          returnId,
          scene.userId,
          `ret-${randomUUID().slice(0, 8)}`,
          {} as never,
        ),
      );

      const after = await levelFor(lot.lotId);
      expect(after.onHand).toBe("25.0000");
      expect(after.qualityHold).toBe("5.0000");
      // The good stock that was already there is untouched.
      expect(after.available).toBe("20.0000");
    });
  });

  describe("the buckets are subsets of on_hand, and the engine holds them to it", () => {
    it("refuses a hold larger than what is on the shelf", async () => {
      // INV-404, hold overage. The only guard was on on_hand itself, which a
      // hold never decrements — so holding 500 of 40 left on_hand at a
      // comfortable 40, quality_hold at 500, and available at -460.
      const lot = await stockedLot("overage", "40.0000");
      await expect(
        asTenant(() =>
          app.app.get(HoldsService).create(scene.orgId, scene.userId, `over-${randomUUID().slice(0, 8)}`, {
            productVariantId: scene.variantId,
            locationId: lot.locationId,
            lotId: lot.lotId,
            quantity: "500.0000",
            reason: "More than exists",
          } as never),
        ),
      ).rejects.toMatchObject({ response: { code: "HOLD_EXCEEDS_ON_HAND" } });

      const after = await levelFor(lot.lotId);
      expect(after.qualityHold).toBe("0.0000");
      expect(after.available).toBe("40.0000");
    });

    it("allows a hold of exactly what is on the shelf", async () => {
      // The boundary. Without it the refusal above would also pass against an
      // off-by-one guard that rejected every hold of the full quantity.
      const lot = await stockedLot("exact", "40.0000");
      await asTenant(() =>
        app.app.get(HoldsService).create(scene.orgId, scene.userId, `exact-${randomUUID().slice(0, 8)}`, {
          productVariantId: scene.variantId,
          locationId: lot.locationId,
          lotId: lot.lotId,
          quantity: "40.0000",
          reason: "All of it",
        } as never),
      );
      const after = await levelFor(lot.lotId);
      expect(after.qualityHold).toBe("40.0000");
      expect(after.available).toBe("0.0000");
    });

    it("refuses a second hold that would push the total past on_hand", async () => {
      // Each hold is individually affordable; together they are not. A
      // per-request check against the request's own quantity would miss this.
      const lot = await stockedLot("twohold", "40.0000");
      const hold = (qty: string) =>
        asTenant(() =>
          app.app.get(HoldsService).create(scene.orgId, scene.userId, `two-${randomUUID().slice(0, 8)}`, {
            productVariantId: scene.variantId,
            locationId: lot.locationId,
            lotId: lot.lotId,
            quantity: qty,
            reason: "Partial",
          } as never),
        );
      await hold("30.0000");
      await expect(hold("30.0000")).rejects.toMatchObject({
        response: { code: "HOLD_EXCEEDS_ON_HAND" },
      });
      const after = await levelFor(lot.lotId);
      expect(after.qualityHold).toBe("30.0000");
    });
  });

  /**
   * A5, item 3 — a hold, a release and a return each announce themselves.
   *
   * All three already wrote an audit row, and an audit row is not an event: it
   * records who did what for a human reading it later, and nothing subscribes
   * to a table. So quarantining a lot — the moment a recall, a supplier claim
   * or a customer notification most needs to start — was visible to nobody
   * outside the database.
   *
   * The counts are the assertion. A hold that emits twice is two quarantine
   * notifications for one batch of goods, and a hold that emits on a refused
   * request is a notification about goods that were never held at all.
   */
  describe("the events a quality decision owes", () => {
    const eventsFor = (eventType: string, aggregateId?: string) =>
      asTenant(() =>
        outboxEventsFor(app.app.get<Db>(DRIZZLE), scene.orgId, eventType, aggregateId),
      );

    it("announces a hold once, and again nothing when the same request is retried", async () => {
      const lot = await stockedLot("evhold", "60.0000");
      const key = `hold-event-${randomUUID().slice(0, 8)}`;
      const request = {
        productVariantId: scene.variantId,
        locationId: lot.locationId,
        lotId: lot.lotId,
        quantity: "10.0000",
        reason: "Damaged outer packaging",
      };

      const hold = await asTenant(() =>
        app.app.get(HoldsService).create(scene.orgId, scene.userId, key, request as never),
      );
      const holdId = (hold as { id: number }).id;

      const created = await eventsFor(
        INVENTORY_COMMAND_EVENTS.QUALITY_HOLD_CREATED,
        String(holdId),
      );
      expect(created).toHaveLength(1);
      expect(created[0]!.aggregateType).toBe("inv_quality_hold");
      expect(created[0]!.payload.quantity).toBe("10.0000");
      expect(created[0]!.payload.lotId).toBe(lot.lotId);
      expect(created[0]!.payload.warehouseId).toBe(scene.warehouseId);
      expect(created[0]!.payload.idempotencyKey).toBe(key);

      // The emit shares the claim with the hold document, so the retry that
      // replays the stored hold id emits nothing — the same reason it does not
      // raise a second hold.
      await asTenant(() =>
        app.app.get(HoldsService).create(scene.orgId, scene.userId, key, request as never),
      );
      expect(
        await eventsFor(INVENTORY_COMMAND_EVENTS.QUALITY_HOLD_CREATED, String(holdId)),
      ).toHaveLength(1);

      // ── and the release ──────────────────────────────────────────────────
      await asTenant(() =>
        app.app
          .get(HoldsService)
          .release(scene.orgId, scene.userId, holdId, `rel-event-${randomUUID().slice(0, 8)}`),
      );
      const released = await eventsFor(
        INVENTORY_COMMAND_EVENTS.QUALITY_HOLD_RELEASED,
        String(holdId),
      );
      expect(released).toHaveLength(1);
      expect(released[0]!.payload.holdId).toBe(holdId);
      expect(released[0]!.payload.sku).toBe(created[0]!.payload.sku);
    });

    it("announces nothing for a hold the engine refused", async () => {
      // The emit shares the transaction with the hold, so a command that rolls
      // back leaves no event. An event published for a hold that does not exist
      // has every consumer quarantining stock that is on sale.
      const lot = await stockedLot("evrefused", "5.0000");
      const before = await eventsFor(INVENTORY_COMMAND_EVENTS.QUALITY_HOLD_CREATED);

      await expect(
        asTenant(() =>
          app.app.get(HoldsService).create(scene.orgId, scene.userId, `ev-over-${randomUUID().slice(0, 8)}`, {
            productVariantId: scene.variantId,
            locationId: lot.locationId,
            lotId: lot.lotId,
            quantity: "500.0000",
            reason: "More than exists",
          } as never),
        ),
      ).rejects.toMatchObject({ response: { code: "HOLD_EXCEEDS_ON_HAND" } });

      expect(await eventsFor(INVENTORY_COMMAND_EVENTS.QUALITY_HOLD_CREATED)).toHaveLength(
        before.length,
      );
    });

    it("announces a customer return once, with what was decided about the goods", async () => {
      const lot = await stockedLot("evreturn", "20.0000");
      const returns = app.app.get(CustomerReturnsService);
      const created = await asTenant(() =>
        returns.create(scene.orgId, scene.userId, {
          lines: [
            {
              productVariantId: scene.variantId,
              lotId: lot.lotId,
              quantity: "5.0000",
              reason: "Arrived scratched",
              targetLocationId: lot.locationId,
            },
          ],
        } as never),
      );
      const returnId = (created as { id: number }).id;

      const detail = (await asTenant(() => returns.get(scene.orgId, returnId))) as {
        lines: Array<{ id: number }>;
      };
      for (const line of detail.lines) {
        await asTenant(() =>
          returns.inspectLine(scene.orgId, scene.userId, returnId, {
            lineId: line.id,
            disposition: "RESTOCK",
          }),
        );
      }

      await asTenant(() =>
        returns.post(
          scene.orgId,
          returnId,
          scene.userId,
          `ret-event-${randomUUID().slice(0, 8)}`,
          {} as never,
        ),
      );

      const events = await eventsFor(
        INVENTORY_COMMAND_EVENTS.RETURN_POSTED,
        String(returnId),
      );
      expect(events).toHaveLength(1);
      expect(events[0]!.aggregateType).toBe("inv_customer_return");
      // One event type covers both directions; which way the goods went is a
      // field, because "goods came back" is one thing to subscribe to.
      expect(events[0]!.payload.returnType).toBe("CUSTOMER");
      expect(events[0]!.payload.lineCount).toBe(1);
      // A restock and a scrap are the same document and opposite outcomes.
      expect(events[0]!.payload.dispositions).toEqual([
        { lineId: detail.lines[0]!.id, productVariantId: scene.variantId, disposition: "RESTOCK" },
      ]);

      // Posting an already-POSTED return short-circuits, so no second event.
      await asTenant(() =>
        returns.post(
          scene.orgId,
          returnId,
          scene.userId,
          `ret-event-again-${randomUUID().slice(0, 8)}`,
          {} as never,
        ),
      );
      expect(
        await eventsFor(INVENTORY_COMMAND_EVENTS.RETURN_POSTED, String(returnId)),
      ).toHaveLength(1);
    });
  });
});
