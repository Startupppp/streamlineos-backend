import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { RecallsService } from "src/modules/inventory/quality/quality-recalls.service";
import { QualityHoldsService } from "src/modules/inventory/quality/quality-holds.service";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { InvReconciliationService } from "src/modules/inventory/reconciliation/inv-reconciliation.service";
import { InvStockAdjustmentsService } from "src/modules/inventory/stock/inv-stock-adjustments.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * INV-17 — the rest of a recall's life: quarantine, then release, and what
 * happens when the quarantine cannot be applied.
 *
 * `recall-simulate-execute` proves the *opening* of a recall — that simulate
 * writes nothing, that execute is idempotent, that stale evidence is refused.
 * It stops there. Nothing anywhere proved that a recalled lot can be let back
 * onto the shelf, or that a recall which fails leaves the warehouse where it
 * found it.
 *
 * The failure half is the point of the ticket. INV-04 was closed on the pack's
 * *first* branch — create and quarantine share one transaction, so
 * `PENDING_QUARANTINE` cannot arise — and that argument is only worth what an
 * actual failed recall demonstrates. A lot already fully held by an inspection
 * is a real warehouse situation and the kernel refuses to quarantine it twice
 * (`HOLD_EXCEEDS_ON_HAND`, because a hold may not exceed the stock it claims).
 * That gives a failure that is *reached from a real command*, rather than one
 * injected by a mock, and lets the two things the ticket asks be checked
 * directly: nothing at all was written, and the same request succeeds once the
 * obstruction is gone.
 *
 *   pnpm test:e2e:seeded --testPathPattern=recall-release-lifecycle
 */

const PERMISSIONS = [
  "inventory:warehouses:scope-all",
  "inventory:stock:read",
  "inventory:stock:adjust",
  "inventory:stock:reconcile",
  "inventory:quality:read",
  "inventory:quality:recall",
  "inventory:quality:hold",
  "inventory:quality:release",
] as const;

const IN_BIN_A = "100.0000";
const IN_BIN_B = "40.0000";
const CONTROL_QTY = "70.0000";

interface Scene {
  orgId: string;
  userId: string;
  variantId: number;
  warehouseId: number;
  binA: number;
  binB: number;
  /** The lot the recall names. */
  badLot: number;
  /** Same product, same bins, never recalled — the control. */
  goodLot: number;
  /** Recalled in the failure case, after an inspection has already held it. */
  blockedLot: number;
}

interface Grain extends Record<string, unknown> {
  location_id: number;
  on_hand: string;
  quality_hold_qty: string;
  handling_unit_id: number | null;
  ownership: string;
}

describe("[seeded-e2e] INV-17 — recall, quarantine, release, and a recall that fails", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;
  let tag: string;

  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  const db = () => app.app.get<Db>(DRIZZLE);
  const recalls = () => app.app.get(RecallsService);
  const holds = () => app.app.get(QualityHoldsService);

  /** Every grain of one lot, so a per-grain claim is a claim and not a total. */
  const grainsOf = (lotId: number): Promise<Grain[]> =>
    asTenant(async () => {
      const rows = await db().execute<Grain>(sql`
        SELECT location_id, on_hand, quality_hold_qty, handling_unit_id, ownership
          FROM inv_stock_levels
         WHERE org_id = ${scene.orgId} AND lot_id = ${lotId}
         ORDER BY location_id`);
      return [...rows];
    });

  const lotStatus = (lotId: number): Promise<string> =>
    asTenant(async () => {
      const rows = await db().execute<{ status: string }>(sql`
        SELECT status::text AS status FROM inv_lots
         WHERE org_id = ${scene.orgId} AND id = ${lotId}`);
      return rows[0]!.status;
    });

  const holdRowsFor = (lotId: number) =>
    asTenant(async () => {
      const rows = await db().execute<{
        id: number;
        status: string;
        quantity: string;
        location_id: number;
        handling_unit_id: number | null;
        ownership: string;
        reason: string | null;
      }>(sql`
        SELECT id, status::text AS status, quantity, location_id, handling_unit_id,
               ownership::text AS ownership, reason
          FROM inv_quality_holds
         WHERE org_id = ${scene.orgId} AND lot_id = ${lotId}
         ORDER BY location_id, id`);
      return [...rows];
    });

  /**
   * Everything a recall can touch, counted in one read. Comparing whole
   * positions is what makes "nothing was written" a checkable claim rather
   * than a sampling of the two tables that came to mind.
   */
  const worldPosition = () =>
    asTenant(async () => {
      const rows = await db().execute<Record<string, number | string>>(sql`
        SELECT
          (SELECT count(*)::int FROM inv_recall_events    WHERE org_id = ${scene.orgId}) AS recalls,
          (SELECT count(*)::int FROM inv_recall_lines     WHERE org_id = ${scene.orgId}) AS lines,
          (SELECT count(*)::int FROM inv_quality_holds    WHERE org_id = ${scene.orgId}) AS holds,
          (SELECT count(*)::int FROM inv_stock_transactions WHERE org_id = ${scene.orgId}) AS txns,
          (SELECT count(*)::int FROM inv_idempotency_keys WHERE org_id = ${scene.orgId}) AS keys,
          (SELECT count(*)::int FROM outbox_events        WHERE organization_id = ${scene.orgId}) AS outbox,
          (SELECT COALESCE(SUM(on_hand), 0)::text FROM inv_stock_levels WHERE org_id = ${scene.orgId}) AS on_hand,
          (SELECT COALESCE(SUM(quality_hold_qty), 0)::text FROM inv_stock_levels WHERE org_id = ${scene.orgId}) AS held`);
      return rows[0]!;
    });

  const expectReconciled = async (): Promise<void> => {
    const report = await asTenant(() =>
      app.app.get(InvReconciliationService).report(scene.orgId, scene.userId, { limit: 100 }),
    );
    expect(report.drift).toEqual([]);
  };

  const seedStock = (key: string, lotId: number, locationId: number, qty: string) =>
    asTenant(() =>
      app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
        idempotencyKey: key,
        sourceType: "inv_recall_fixture",
        sourceId: key,
        movements: [
          {
            transactionType: "PURCHASE",
            productVariantId: scene.variantId,
            locationId,
            lotId,
            quantityDelta: qty,
            unitCost: "2.0000",
          },
        ],
      }),
    );

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("keeper", { permissionKeys: PERMISSIONS })
      .build();
    teardown = () => seeded.teardown();

    tag = randomUUID().slice(0, 6);
    const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
      (await app.app.get<Db>(DRIZZLE).execute<T>(q))[0]!;

    scene = await runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), seeded.orgId, async () => {
      const userId = seeded.members["keeper"]!.userId;
      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, tracking_method, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Recallable goods', ${`RL-${tag}`}, 'LOT', ${userId})
        RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`RL-${tag}-V`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Main', ${`RLW${tag}`}, ${userId}) RETURNING id`);
      const binA = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Bin A', ${`RLA${tag}`}, 'BIN', true) RETURNING id`);
      const binB = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Bin B', ${`RLB${tag}`}, 'BIN', true) RETURNING id`);
      const lot = async (suffix: string) =>
        one<{ id: number }>(sql`
          INSERT INTO inv_lots (org_id, product_variant_id, lot_number, status, expiry_date)
          VALUES (${seeded.orgId}, ${variant.id}, ${`L-${suffix}-${tag}`}, 'ACTIVE', '2027-03-01')
          RETURNING id`);
      const bad = await lot("BAD");
      const good = await lot("GOOD");
      const blocked = await lot("BLOCK");
      return {
        orgId: seeded.orgId,
        userId,
        variantId: variant.id,
        warehouseId: warehouse.id,
        binA: binA.id,
        binB: binB.id,
        badLot: bad.id,
        goodLot: good.id,
        blockedLot: blocked.id,
      };
    });

    // The recalled lot sits in two bins, so "one hold per grain" is a real
    // claim. The good lot shares a bin with it, so "the recall touched only
    // what it named" is a real claim too.
    await seedStock(`rl-bad-a-${tag}`, scene.badLot, scene.binA, IN_BIN_A);
    await seedStock(`rl-bad-b-${tag}`, scene.badLot, scene.binB, IN_BIN_B);
    await seedStock(`rl-good-${tag}`, scene.goodLot, scene.binA, CONTROL_QTY);
    await seedStock(`rl-blocked-${tag}`, scene.blockedLot, scene.binB, "30.0000");
  }, 600_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app?.close();
  }, 600_000);

  describe("the recall quarantines what it names, and only that", () => {
    let recallId: number;

    it("holds every grain of the recalled lot without moving any of it", async () => {
      const created = await asTenant(() =>
        recalls().create(
          scene.orgId,
          scene.userId,
          { title: `Recall ${tag}`, lines: [{ lotId: scene.badLot }] },
          `rl-exec-${tag}`,
        ),
      );
      recallId = created.id;

      const grains = await grainsOf(scene.badLot);
      expect(grains).toHaveLength(2);
      // A recall quarantines; it does not make the goods vanish. The physical
      // count is the number the recall itself has to report.
      expect(grains.map((g) => g.on_hand)).toEqual([IN_BIN_A, IN_BIN_B]);
      expect(grains.map((g) => g.quality_hold_qty)).toEqual([IN_BIN_A, IN_BIN_B]);

      expect(await lotStatus(scene.badLot)).toBe("RECALLED");
      await expectReconciled();
    }, 300_000);

    it("raises one hold per grain, carrying the handling unit and the ownership", async () => {
      const rows = await holdRowsFor(scene.badLot);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.status)).toEqual(["ACTIVE", "ACTIVE"]);
      expect(rows.map((r) => r.location_id)).toEqual([scene.binA, scene.binB]);
      expect(rows.map((r) => r.quantity)).toEqual([IN_BIN_A, IN_BIN_B]);
      // The two grain components a hold most easily loses. Loose owned stock is
      // `null` / `OWNED`, and a hold that recorded neither could not tell this
      // apart from a consigned pallet standing in the same bin.
      expect(rows.map((r) => r.handling_unit_id)).toEqual([null, null]);
      expect(rows.map((r) => r.ownership)).toEqual(["OWNED", "OWNED"]);
      expect(rows.every((r) => (r.reason ?? "").startsWith("Recall "))).toBe(true);
    });

    it("leaves the lot standing beside it completely alone", async () => {
      const control = await grainsOf(scene.goodLot);
      expect(control).toHaveLength(1);
      expect(control[0]!.on_hand).toBe(CONTROL_QTY);
      expect(control[0]!.quality_hold_qty).toBe("0.0000");
      expect(await lotStatus(scene.goodLot)).toBe("ACTIVE");
      expect(await holdRowsFor(scene.goodLot)).toHaveLength(0);
    });

    it("closes the recall document once the response is decided", async () => {
      const closed = await asTenant(() =>
        recalls().update(scene.orgId, scene.userId, recallId, { status: "CLOSED" }),
      );
      expect(closed?.status).toBe("CLOSED");
    });
  });

  describe("release — the recalled goods come back to the shelf", () => {
    it("clears the hold bucket on every grain and moves no stock", async () => {
      const before = await grainsOf(scene.badLot);
      const rows = await holdRowsFor(scene.badLot);
      expect(rows).toHaveLength(2);

      for (const row of rows) {
        await asTenant(() =>
          holds().release(scene.orgId, scene.userId, row.id, `rl-release-${row.id}-${tag}`),
        );
      }

      const after = await grainsOf(scene.badLot);
      // The mirror of the quarantine: the hold bucket empties, on-hand does not
      // move. A release implemented as an ON_HAND movement would show up here
      // as stock that left the building.
      expect(after.map((g) => g.quality_hold_qty)).toEqual(["0.0000", "0.0000"]);
      expect(after.map((g) => g.on_hand)).toEqual(before.map((g) => g.on_hand));
      await expectReconciled();
    }, 300_000);

    it("marks each hold released rather than deleting it", async () => {
      const rows = await holdRowsFor(scene.badLot);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.status)).toEqual(["RELEASED", "RELEASED"]);
    });

    it("posts the release through the ledger as a quarantine reversal", async () => {
      const rows = await asTenant(async () => {
        const out = await db().execute<{ n: number; total: string }>(sql`
          SELECT count(*)::int AS n, COALESCE(SUM(quantity_change), 0)::text AS total
            FROM inv_stock_transactions
           WHERE org_id = ${scene.orgId}
             AND lot_id = ${scene.badLot}
             AND transaction_type = 'QUARANTINE_OUT'`);
        return out[0]!;
      });
      expect(rows.n).toBe(2);
      // 100 + 40 held, so 140 released — the ledger states the reversal, it is
      // not merely implied by the projection having changed.
      expect(Number(rows.total)).toBe(-140);
    });

    it("refuses to release the same hold twice", async () => {
      const rows = await holdRowsFor(scene.badLot);
      await expect(
        asTenant(() =>
          holds().release(scene.orgId, scene.userId, rows[0]!.id, `rl-rerelease-${tag}`),
        ),
      ).rejects.toThrow();
    });
  });

  describe("a recall that cannot be applied leaves the warehouse where it found it", () => {
    let inspectionHoldId: number;

    it("takes the whole of a lot under an inspection hold first", async () => {
      const created = await asTenant(() =>
        holds().create(scene.orgId, scene.userId, `rl-insp-${tag}`, {
          productVariantId: scene.variantId,
          locationId: scene.binB,
          lotId: scene.blockedLot,
          quantity: "30.0000",
          reason: "Inspection",
        }),
      );
      inspectionHoldId = created.id;

      const grains = await grainsOf(scene.blockedLot);
      expect(grains).toHaveLength(1);
      expect(grains[0]!.quality_hold_qty).toBe("30.0000");
      expect(grains[0]!.on_hand).toBe("30.0000");
    }, 300_000);

    it("refuses the recall, because a second hold would exceed the stock it claims", async () => {
      const before = await worldPosition();

      await expect(
        asTenant(() =>
          recalls().create(
            scene.orgId,
            scene.userId,
            { title: `Blocked recall ${tag}`, lines: [{ lotId: scene.blockedLot }] },
            `rl-blocked-${tag}`,
          ),
        ),
      ).rejects.toMatchObject({ response: { code: "HOLD_EXCEEDS_ON_HAND" } });

      // Nothing at all. Not "the recall row was rolled back" — the lines, the
      // holds, the movements, the outbox announcement and even the idempotency
      // claim are all inside the one transaction, and a half-applied recall is
      // the failure INV-04 exists to make impossible.
      expect(await worldPosition()).toEqual(before);
      expect(await lotStatus(scene.blockedLot)).toBe("ACTIVE");
      await expectReconciled();
    }, 300_000);

    it("accepts the very same request once the obstruction is cleared", async () => {
      // This is what makes the failure *recoverable* rather than merely atomic.
      // A rolled-back attempt that left its idempotency claim behind would
      // answer the retry with a replay of a recall that never happened, and the
      // lot would stay on the shelf while the operator was told it was recalled.
      await asTenant(() =>
        holds().release(scene.orgId, scene.userId, inspectionHoldId, `rl-insp-rel-${tag}`),
      );

      const created = await asTenant(() =>
        recalls().create(
          scene.orgId,
          scene.userId,
          { title: `Blocked recall ${tag}`, lines: [{ lotId: scene.blockedLot }] },
          `rl-blocked-${tag}`,
        ),
      );
      expect(created.id).toBeGreaterThan(0);

      expect(await lotStatus(scene.blockedLot)).toBe("RECALLED");
      const grains = await grainsOf(scene.blockedLot);
      expect(grains[0]!.quality_hold_qty).toBe("30.0000");
      expect(grains[0]!.on_hand).toBe("30.0000");
      const rows = await holdRowsFor(scene.blockedLot);
      // The released inspection hold plus exactly one new recall hold — the
      // retry did not stack a second copy on top of the first attempt's.
      expect(rows.filter((r) => r.status === "ACTIVE")).toHaveLength(1);
      await expectReconciled();
    }, 300_000);
  });

  describe("disposal, and the door that is not there", () => {
    /**
     * INV-17 asks for "release/dispose". Release is above and is real. Disposal
     * is *not* reachable for lot-tracked stock, and this pins the reason rather
     * than leaving it as a paragraph somebody has to trust.
     *
     * `inv_stock_adjustment_lines` records a variant and a location and nothing
     * else, so `applyAdjustmentLinesInTx` posts at the loose, owned, lot-less
     * grain. Against a bin whose stock is all under a lot, that grain holds
     * zero, and the write-off is refused. Which is the safe answer — the
     * dangerous one would be for it to succeed by silently taking the lot's
     * stock, and that is the assertion here: the refusal is the grain rule
     * working, not a bug to be "fixed" by relaxing it.
     */
    it("cannot write off lot-tracked stock, because an adjustment cannot name a lot", async () => {
      const before = await grainsOf(scene.goodLot);
      expect(before[0]!.on_hand).toBe(CONTROL_QTY);

      await expect(
        asTenant(() =>
          app.app.get(InvStockAdjustmentsService).createAdjustment(
            scene.orgId,
            scene.userId,
            {
              reason: "DAMAGE",
              lines: [
                {
                  productVariantId: scene.variantId,
                  locationId: scene.binA,
                  quantityChange: "-10.0000",
                },
              ],
            } as Parameters<InvStockAdjustmentsService["createAdjustment"]>[2],
            `rl-writeoff-${tag}`,
          ),
        ),
      ).rejects.toMatchObject({ response: { code: "INSUFFICIENT_STOCK" } });

      // And the lot is untouched — the refusal did not take the stock on its
      // way out.
      expect((await grainsOf(scene.goodLot))[0]!.on_hand).toBe(CONTROL_QTY);
      await expectReconciled();
    }, 300_000);
  });
});
