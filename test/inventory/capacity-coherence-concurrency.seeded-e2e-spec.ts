import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { StockEngineBatchService } from "src/modules/inventory/stock-engine/stock-engine-batch.service";
import type { StockEngineCommand } from "src/modules/inventory/stock-engine/stock-engine.types";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * INV-10 — capacity and bucket coherence, enforced identically on every path
 * and holding under concurrency.
 *
 * `LOCATION_CAPACITY_EXCEEDED` had **no test at all** on this branch: a grep of
 * `src/` and `test/` found the constant declared once and thrown once, and read
 * by nothing. A bin's capacity was therefore enforced only in the sense that
 * somebody had written the code.
 *
 * The interesting half is the race. `assertLocationCapacity` aggregates
 * `SUM(on_hand)` over *every* grain in the raised location, but `lockLevels`
 * only locks the grains the command itself names. Under READ COMMITTED a
 * concurrent transaction's uncommitted increase on a *different* grain in the
 * same bin is invisible, so two commands can each read a total under capacity,
 * each pass the guard, and commit a position over it. Nothing about that is
 * exotic: two lots of one product landing in one bin is the ordinary shape of a
 * receiving dock.
 *
 * The bucket half is the control. Holds are arithmetic on the grain's own row,
 * which `lockLevels` does lock, so concurrency must *not* be able to break
 * coherence there. If that half ever starts failing, the row lock has been lost.
 *
 *   pnpm test:e2e:seeded --testPathPattern=capacity-coherence-concurrency
 */

const PERMISSIONS = [
  "inventory:warehouses:scope-all",
  "inventory:stock:read",
  "inventory:stock:adjust",
];

/** The bin holds this much and no more. */
const CAPACITY = 100;

interface Scene {
  orgId: string;
  userId: string;
  variantId: number;
  lotA: number;
  lotB: number;
  cappedLocationId: number;
  /** Capped and empty, so each racer is legal on its own and only the pair is not. */
  raceSingleLocationId: number;
  raceBatchLocationId: number;
  freeLocationId: number;
}

describe("[seeded-e2e] INV-10 — location capacity and bucket coherence", () => {
  let seededApp: SeededE2eApp;
  let db: Db;
  let scene: Scene;
  const teardowns: Array<() => Promise<void>> = [];

  const asTenant = <T>(work: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(db, scene.orgId, work);

  const single = () => seededApp.app.get(StockEngineService);
  const batch = () => seededApp.app.get(StockEngineBatchService);

  /** One command in its own transaction — this is what a request is. */
  const postSingle = (cmd: StockEngineCommand) =>
    runInNewTenantTransaction(db, scene.orgId, (tx) =>
      single().executeInTx(tx, scene.orgId, scene.userId, cmd),
    );

  /** The same command through the batch orchestrator, in its own transaction. */
  const postBatch = (...cmds: StockEngineCommand[]) =>
    runInNewTenantTransaction(db, scene.orgId, (tx) =>
      batch().executeManyInTx(tx, scene.orgId, scene.userId, cmds),
    );

  function receipt(
    key: string,
    locationId: number,
    lotId: number | null,
    qty: string,
  ): StockEngineCommand {
    return {
      idempotencyKey: key,
      sourceType: "inv_capacity_probe",
      sourceId: key,
      reason: "capacity probe",
      postingDate: "2026-06-10",
      movements: [
        {
          transactionType: "ADJUSTMENT_IN",
          productVariantId: scene.variantId,
          locationId,
          ...(lotId === null ? {} : { lotId }),
          quantityDelta: qty,
          unitCost: "1.0000",
        },
      ],
    };
  }

  function hold(key: string, lotId: number | null, qty: string): StockEngineCommand {
    return {
      idempotencyKey: key,
      sourceType: "inv_capacity_probe",
      sourceId: key,
      reason: "coherence probe",
      postingDate: "2026-06-10",
      movements: [
        {
          transactionType: "QUARANTINE_IN",
          productVariantId: scene.variantId,
          locationId: scene.freeLocationId,
          ...(lotId === null ? {} : { lotId }),
          quantityDelta: qty,
          qualityBucket: "QUALITY_HOLD",
        },
      ],
    };
  }

  /** Everything physically in the bin, across every grain. */
  const onHandIn = (locationId: number): Promise<number> =>
    asTenant(async (tx) => {
      const rows = await tx.execute<{ n: string }>(sql`
        SELECT COALESCE(SUM(on_hand), 0)::text AS n FROM inv_stock_levels
         WHERE org_id = ${scene.orgId} AND location_id = ${locationId}`);
      return Number(rows[0]!.n);
    });

  const bucketsAt = (lotId: number | null): Promise<{ onHand: number; hold: number }> =>
    asTenant(async (tx) => {
      const rows = await tx.execute<{ on_hand: string; quality_hold_qty: string }>(sql`
        SELECT on_hand, quality_hold_qty FROM inv_stock_levels
         WHERE org_id = ${scene.orgId}
           AND location_id = ${scene.freeLocationId}
           AND product_variant_id = ${scene.variantId}
           AND lot_id IS NOT DISTINCT FROM ${lotId}
           AND serial_id IS NULL AND handling_unit_id IS NULL AND ownership = 'OWNED'`);
      return {
        onHand: Number(rows[0]?.on_hand ?? "0"),
        hold: Number(rows[0]?.quality_hold_qty ?? "0"),
      };
    });

  const ledgerRowsFor = (prefix: string): Promise<number> =>
    asTenant(async (tx) => {
      const rows = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM inv_stock_transactions
         WHERE org_id = ${scene.orgId} AND idempotency_key LIKE ${`${prefix}%`}`);
      return rows[0]!.n;
    });

  const codeOf = (reason: unknown): string | undefined =>
    (reason as { response?: { code?: string } } | undefined)?.response?.code;

  const sqlstateOf = (reason: unknown): string | undefined => {
    const e = reason as { code?: string; cause?: { code?: string } } | undefined;
    return e?.cause?.code ?? e?.code;
  };

  /**
   * The capacity lock must serialise, not collide.
   *
   * `inv_stock_levels.location_id` is a foreign key, so creating a grain takes
   * `FOR KEY SHARE` on its location — the one mode `FOR UPDATE` conflicts with.
   * Locking the bin `FOR UPDATE` therefore turns two ordinary receipts into a
   * deadlock, which was measured here before the mode was changed to
   * `FOR NO KEY UPDATE`. Asserting the refusal *code* alone would not catch a
   * regression to `FOR UPDATE`: the position would still be correct, because
   * Postgres kills one of the pair, and only the operator would see a 500.
   */
  const expectNoDeadlock = (results: PromiseSettledResult<unknown>[]): void => {
    for (const r of results) {
      if (r.status === "rejected") expect(sqlstateOf(r.reason)).not.toBe("40P01");
    }
  };

  beforeAll(async () => {
    seededApp = await createSeededE2eApp();
    db = seededApp.app.get<Db>(DRIZZLE);

    const seeded = await seedOrg(seededApp.seedDb)
      .onPlan("PAID")
      .addMember("keeper", { permissionKeys: PERMISSIONS })
      .build();
    teardowns.push(() => seeded.teardown());

    const tag = randomUUID().slice(0, 6);
    const userId = seeded.members["keeper"]!.userId;

    scene = await runInNewTenantTransaction(db, seeded.orgId, async (tx) => {
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await tx.execute<T>(q))[0]!;

      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Capacity widget', ${`CAP-${tag}`}, ${userId}) RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`CAP-${tag}-V1`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Capacity warehouse', ${`CW${tag}`}, ${userId}) RETURNING id`);
      // The bin under test records a capacity. The second one records none,
      // because "no capacity means unlimited" is the common case and the guard
      // must leave it alone.
      const capped = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, capacity)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Capped bin', ${`CB${tag}`}, 'BIN', ${String(CAPACITY)})
        RETURNING id`);
      const raceSingle = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, capacity)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Race bin', ${`RB${tag}`}, 'BIN', ${String(CAPACITY)})
        RETURNING id`);
      const raceBatch = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, capacity)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Race bin 2', ${`R2${tag}`}, 'BIN', ${String(CAPACITY)})
        RETURNING id`);
      const free = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Free bin', ${`FB${tag}`}, 'BIN') RETURNING id`);
      const lotA = await one<{ id: number }>(sql`
        INSERT INTO inv_lots (org_id, product_variant_id, lot_number)
        VALUES (${seeded.orgId}, ${variant.id}, ${`LOT-A-${tag}`}) RETURNING id`);
      const lotB = await one<{ id: number }>(sql`
        INSERT INTO inv_lots (org_id, product_variant_id, lot_number)
        VALUES (${seeded.orgId}, ${variant.id}, ${`LOT-B-${tag}`}) RETURNING id`);

      return {
        orgId: seeded.orgId,
        userId,
        variantId: variant.id,
        lotA: lotA.id,
        lotB: lotB.id,
        cappedLocationId: capped.id,
        raceSingleLocationId: raceSingle.id,
        raceBatchLocationId: raceBatch.id,
        freeLocationId: free.id,
      };
    });
  }, 600_000);

  afterAll(async () => {
    for (const teardown of teardowns.reverse()) await teardown().catch(() => undefined);
    if (seededApp) await seededApp.close();
  }, 120_000);

  describe("serially, the two engine paths answer the same", () => {
    it("lets the single path fill the bin exactly to its capacity", async () => {
      await postSingle(receipt(`cap-fill-${scene.lotA}`, scene.cappedLocationId, scene.lotA, `${String(CAPACITY)}.0000`));
      expect(await onHandIn(scene.cappedLocationId)).toBe(CAPACITY);
    });

    it("refuses the single-path movement that would take it over, by code", async () => {
      await expect(
        postSingle(receipt(`cap-over-single-${scene.lotB}`, scene.cappedLocationId, scene.lotB, "1.0000")),
      ).rejects.toMatchObject({ response: { code: "LOCATION_CAPACITY_EXCEEDED" } });
      expect(await onHandIn(scene.cappedLocationId)).toBe(CAPACITY);
      expect(await ledgerRowsFor("cap-over-single-")).toBe(0);
    });

    it("refuses the identical batch-path movement, with the identical code", async () => {
      // The whole reason MovementApplyService exists: the capacity guard used to
      // live in one path and not the other. If these two ever answer
      // differently again, a document routed through the batch orchestrator
      // silently obeys a weaker rule than the same document posted singly.
      await expect(
        postBatch(receipt(`cap-over-batch-${scene.lotB}`, scene.cappedLocationId, scene.lotB, "1.0000")),
      ).rejects.toMatchObject({ response: { code: "LOCATION_CAPACITY_EXCEEDED" } });
      expect(await onHandIn(scene.cappedLocationId)).toBe(CAPACITY);
      expect(await ledgerRowsFor("cap-over-batch-")).toBe(0);
    });

    it("leaves a bin with no capacity recorded alone", async () => {
      // Unlimited is the default and by far the common case; a guard that
      // started treating NULL as zero would stop the whole warehouse.
      await postSingle(receipt(`cap-free-${scene.lotA}`, scene.freeLocationId, scene.lotA, "5000.0000"));
      expect(await onHandIn(scene.freeLocationId)).toBe(5000);
    });
  });

  describe("under concurrency, on grains the command does not lock", () => {
    it("cannot let two commands over different lots overfill one capped bin", async () => {
      // The bin is EMPTY and holds 100. Each racer asks for 60, so each is
      // legal on its own and only the pair is not — that is what makes this
      // test discriminate. Aim it at a bin that is already over and both are
      // refused whether or not the guard serialises, and the test proves
      // nothing.
      //
      // They raise *different* lots, so `lockLevels` gives them disjoint row
      // locks and neither blocks the other. Each then aggregates the whole bin
      // and, under READ COMMITTED, cannot see the other's uncommitted row.
      const prefix = `cap-race-${randomUUID().slice(0, 6)}`;
      const bin = scene.raceSingleLocationId;
      expect(await onHandIn(bin)).toBe(0);

      const results = await Promise.allSettled([
        postSingle(receipt(`${prefix}-a`, bin, scene.lotA, "60.0000")),
        postSingle(receipt(`${prefix}-b`, bin, scene.lotB, "60.0000")),
      ]);

      const accepted = results.filter((r) => r.status === "fulfilled").length;
      const after = await onHandIn(bin);

      expectNoDeadlock(results);
      // The invariant, stated the way the building states it: the shelf cannot
      // hold more than the shelf holds.
      expect(after).toBeLessThanOrEqual(CAPACITY);
      // Exactly one fits. Zero would mean the guard had become a lock that
      // refuses everything, which is a different defect and not an improvement.
      expect(accepted).toBe(1);
      // The ledger has to agree with the projection — a guard that rolled the
      // level back but left the movement row would satisfy the line above.
      expect(await ledgerRowsFor(prefix)).toBe(accepted);
      expect(after).toBe(accepted * 60);

      for (const r of results) {
        if (r.status === "rejected") expect(codeOf(r.reason)).toBe("LOCATION_CAPACITY_EXCEEDED");
      }
    }, 300_000);

    it("cannot let two concurrent batches overfill one capped bin either", async () => {
      const prefix = `cap-brace-${randomUUID().slice(0, 6)}`;
      const bin = scene.raceBatchLocationId;
      expect(await onHandIn(bin)).toBe(0);

      const results = await Promise.allSettled([
        postBatch(receipt(`${prefix}-a`, bin, scene.lotA, "60.0000")),
        postBatch(receipt(`${prefix}-b`, bin, scene.lotB, "60.0000")),
      ]);

      const accepted = results.filter((r) => r.status === "fulfilled").length;
      expectNoDeadlock(results);
      expect(await onHandIn(bin)).toBeLessThanOrEqual(CAPACITY);
      expect(accepted).toBe(1);
      expect(await ledgerRowsFor(prefix)).toBe(accepted);
      for (const r of results) {
        if (r.status === "rejected") expect(codeOf(r.reason)).toBe("LOCATION_CAPACITY_EXCEEDED");
      }
    }, 300_000);
  });

  describe("bucket coherence, which the grain's own row lock already protects", () => {
    it("refuses a hold larger than the stock it claims", async () => {
      const buckets = await bucketsAt(scene.lotA);
      await expect(
        postSingle(hold(`coh-over-${randomUUID().slice(0, 6)}`, scene.lotA, `${String(buckets.onHand + 1)}.0000`)),
      ).rejects.toMatchObject({ response: { code: "HOLD_EXCEEDS_ON_HAND" } });
    });

    it("cannot let two concurrent holds on one grain together exceed its stock", async () => {
      // The control. These two contend for the same stock level row, which
      // `lockLevels` takes FOR UPDATE, so the second reads the first's result
      // rather than the snapshot it started from. If this ever fails, the row
      // lock has been lost and every bucket guard in the engine is advisory.
      const prefix = `coh-race-${randomUUID().slice(0, 6)}`;
      const start = await bucketsAt(scene.lotA);
      const each = Math.floor(start.onHand * 0.6) + 1;

      const results = await Promise.allSettled([
        postSingle(hold(`${prefix}-a`, scene.lotA, `${String(each)}.0000`)),
        postSingle(hold(`${prefix}-b`, scene.lotA, `${String(each)}.0000`)),
      ]);

      const accepted = results.filter((r) => r.status === "fulfilled").length;
      const end = await bucketsAt(scene.lotA);
      expect(accepted).toBe(1);
      expect(end.hold).toBe(start.hold + each);
      expect(end.hold).toBeLessThanOrEqual(end.onHand);
      for (const r of results) {
        if (r.status === "rejected") expect(codeOf(r.reason)).toBe("HOLD_EXCEEDS_ON_HAND");
      }
    }, 300_000);
  });
});
