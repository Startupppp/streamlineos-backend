import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { ReservationService } from "src/modules/inventory/stock-engine/reservation.service";
import { InvReconciliationService } from "src/modules/inventory/reconciliation/inv-reconciliation.service";
import { InvStockAdjustmentsService } from "src/modules/inventory/stock/inv-stock-adjustments.service";
import { InventorySettingsService } from "src/modules/inventory/stock-engine/inventory-settings.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * INV-105 — the concurrency matrix, against Postgres.
 *
 * The single-command path used to lock stock rows in whatever order the caller
 * listed its movements, so two commands touching the same grains in opposite
 * order could deadlock. That is fixed; these prove it, and prove the properties
 * that matter more than any one fix: after N concurrent commands the projection
 * equals what serial execution would have produced, a repeated idempotency key
 * writes one movement rather than N, and nothing goes negative that policy
 * forbids.
 *
 * Every worker runs in its own transaction, because that is what a concurrent
 * request is. Running them inside one shared transaction would prove nothing —
 * there would be no second writer to race.
 *
 *   pnpm test:e2e:seeded --testPathPattern=stock-concurrency
 */

const PERMISSIONS = [
  "inventory:warehouses:scope-all",
  "inventory:stock:read",
  "inventory:stock:adjust",
  "inventory:stock:reserve",
  "inventory:stock:reconcile",
] as const;

interface Scene {
  orgId: string;
  userId: string;
  variantId: number;
  locationA: number;
  locationB: number;
  warehouseId: number;
}

describe("[seeded-e2e] concurrent stock commands", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  const engine = () => app.app.get(StockEngineService);

  /** One command, in its own transaction — this is what a request is. */
  function command(key: string, movements: Parameters<StockEngineService["execute"]>[2]["movements"]) {
    return asTenant(() =>
      engine().execute(scene.orgId, scene.userId, {
        idempotencyKey: key,
        sourceType: "concurrency-probe",
        sourceId: key,
        postingDate: "2026-06-10",
        movements,
      }),
    );
  }

  async function onHandAt(locationId: number): Promise<number> {
    const rows = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{ n: string }>(sql`
        SELECT COALESCE(SUM(on_hand), 0)::text AS n FROM inv_stock_levels
        WHERE org_id = ${scene.orgId} AND product_variant_id = ${scene.variantId}
          AND location_id = ${locationId}`),
    );
    return Number(rows[0]!.n);
  }

  async function ledgerRowsFor(prefix: string): Promise<number> {
    const rows = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM inv_stock_transactions
        WHERE org_id = ${scene.orgId} AND idempotency_key LIKE ${`${prefix}%`}`),
    );
    return rows[0]!.n;
  }

  async function expectReconciled() {
    const report = await asTenant(() =>
      app.app.get(InvReconciliationService).report(scene.orgId, scene.userId, { limit: 100 }),
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
        VALUES (${seeded.orgId}, ${uom.id}, 'Race widget', ${`RACE-${tag}`}, ${userId}) RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`RACE-${tag}-V1`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Race warehouse', ${`RW${tag}`}, ${userId}) RETURNING id`);
      const a = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'A', ${`RA${tag}`}, 'BIN') RETURNING id`);
      const b = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'B', ${`RB${tag}`}, 'BIN') RETURNING id`);
      return {
        orgId: seeded.orgId,
        userId,
        variantId: variant.id,
        warehouseId: warehouse.id,
        locationA: a.id,
        locationB: b.id,
      };
    });
  }, 180_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  it(
    "twenty concurrent adjustments land exactly once each",
    async () => {
      const prefix = `race-add-${randomUUID().slice(0, 6)}`;
      const before = await onHandAt(scene.locationA);

      const results = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) =>
          command(`${prefix}-${String(i)}`, [
            {
              transactionType: "ADJUSTMENT_IN",
              productVariantId: scene.variantId,
              locationId: scene.locationA,
              quantityDelta: "5.0000",
            },
          ]),
        ),
      );

      const accepted = results.filter((r) => r.status === "fulfilled").length;
      // A lost update would leave on_hand short of the accepted total. Serial
      // execution of the same commands is the answer this must match.
      expect(await onHandAt(scene.locationA)).toBe(before + accepted * 5);
      expect(await ledgerRowsFor(prefix)).toBe(accepted);
      await expectReconciled();
    },
    300_000,
  );

  it(
    "the same idempotency key concurrently writes one movement, not ten",
    async () => {
      const key = `race-idem-${randomUUID().slice(0, 6)}`;
      const before = await onHandAt(scene.locationA);

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          command(key, [
            {
              transactionType: "ADJUSTMENT_IN",
              productVariantId: scene.variantId,
              locationId: scene.locationA,
              quantityDelta: "7.0000",
            },
          ]),
        ),
      );

      // Some callers replay and some are told the key is in flight; what matters
      // is that the stock moved once.
      expect(results.some((r) => r.status === "fulfilled")).toBe(true);
      expect(await onHandAt(scene.locationA)).toBe(before + 7);
      expect(await ledgerRowsFor(key)).toBe(1);
      await expectReconciled();
    },
    300_000,
  );

  it(
    "transfers in opposite directions do not deadlock",
    async () => {
      // The defect this replaces: the single-command path locked rows in the
      // order the caller listed its movements, so A→B and B→A took the same two
      // rows in opposite orders. Both commands name the same two grains; only
      // the order within each command differs.
      await command(`race-seed-${randomUUID().slice(0, 6)}`, [
        { transactionType: "ADJUSTMENT_IN", productVariantId: scene.variantId, locationId: scene.locationA, quantityDelta: "200.0000" },
        { transactionType: "ADJUSTMENT_IN", productVariantId: scene.variantId, locationId: scene.locationB, quantityDelta: "200.0000" },
      ]);

      const prefix = `race-xfer-${randomUUID().slice(0, 6)}`;
      const aBefore = await onHandAt(scene.locationA);
      const bBefore = await onHandAt(scene.locationB);

      const results = await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) =>
          i % 2 === 0
            ? command(`${prefix}-ab-${String(i)}`, [
                { transactionType: "TRANSFER_OUT", productVariantId: scene.variantId, locationId: scene.locationA, quantityDelta: "-1.0000" },
                { transactionType: "TRANSFER_IN", productVariantId: scene.variantId, locationId: scene.locationB, quantityDelta: "1.0000" },
              ])
            : command(`${prefix}-ba-${String(i)}`, [
                { transactionType: "TRANSFER_OUT", productVariantId: scene.variantId, locationId: scene.locationB, quantityDelta: "-1.0000" },
                { transactionType: "TRANSFER_IN", productVariantId: scene.variantId, locationId: scene.locationA, quantityDelta: "1.0000" },
              ]),
        ),
      );

      const deadlocked = results.filter(
        (r) => r.status === "rejected" && /deadlock/i.test(String((r.reason as Error)?.message ?? "")),
      );
      expect(deadlocked).toEqual([]);

      // Every accepted transfer moved one unit each way, so the pair sums back
      // to where it started whatever order they landed in.
      const total = (await onHandAt(scene.locationA)) + (await onHandAt(scene.locationB));
      expect(total).toBe(aBefore + bBefore);
      await expectReconciled();
    },
    300_000,
  );

  it(
    "the same two rows taken in opposite order do deadlock — proving the test above discriminates",
    async () => {
      // The test before this one passes because the engine sorts its grains
      // before locking. Without a control it would also pass against an engine
      // that took no locks at all, so this reproduces the unordered shape
      // directly and asserts Postgres kills one of the pair. If this stops
      // deadlocking, the scenario has stopped being deadlock-prone and the test
      // above has stopped proving anything.
      const db = app.app.get<Db>(DRIZZLE);
      const [a, b] = await runInNewTenantTransaction(db, scene.orgId, async () => {
        const rows = await db.execute<{ id: number }>(sql`
          SELECT id FROM inv_stock_levels
          WHERE org_id = ${scene.orgId} AND product_variant_id = ${scene.variantId}
            AND location_id IN (${scene.locationA}, ${scene.locationB})
          ORDER BY id`);
        return [rows[0]!.id, rows[1]!.id];
      });

      const lockPair = (first: number, second: number) =>
        runInNewTenantTransaction(db, scene.orgId, async () => {
          await db.execute(sql`SELECT id FROM inv_stock_levels WHERE id = ${first} FOR UPDATE`);
          await new Promise((resolve) => setTimeout(resolve, 300));
          await db.execute(sql`SELECT id FROM inv_stock_levels WHERE id = ${second} FOR UPDATE`);
        });

      const outcomes = await Promise.allSettled([lockPair(a, b), lockPair(b, a)]);
      const deadlocked = outcomes.filter((o) => {
        if (o.status !== "rejected") return false;
        const error = o.reason as { code?: string; cause?: { code?: string }; message?: string };
        return (
          error.code === "40P01" ||
          error.cause?.code === "40P01" ||
          /deadlock/i.test(String(error.message ?? ""))
        );
      });
      expect(deadlocked).toHaveLength(1);
    },
    120_000,
  );

  it(
    "concurrent issues cannot take the same stock twice",
    async () => {
      const prefix = `race-issue-${randomUUID().slice(0, 6)}`;
      const location = scene.locationB;
      const start = await onHandAt(location);

      // Ten callers each try to take a tenth of what is there, plus one more
      // than exists in total. Whatever mix succeeds, the shelf cannot go below
      // zero while the tenant forbids it.
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) =>
          command(`${prefix}-${String(i)}`, [
            {
              transactionType: "SALE",
              productVariantId: scene.variantId,
              locationId: location,
              quantityDelta: `-${String(Math.ceil(start / 5))}.0000`,
            },
          ]),
        ),
      );

      const accepted = results.filter((r) => r.status === "fulfilled").length;
      const after = await onHandAt(location);
      expect(after).toBeGreaterThanOrEqual(0);
      expect(after).toBe(start - accepted * Math.ceil(start / 5));
      expect(await ledgerRowsFor(prefix)).toBe(accepted);
      await expectReconciled();
    },
    300_000,
  );

  it(
    "concurrent reservations never commit more than is on the shelf",
    async () => {
      const location = scene.locationA;
      const available = await onHandAt(location);
      const each = Math.max(1, Math.floor(available / 4));

      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          asTenant(() =>
            app.app.get(ReservationService).createReservation(scene.orgId, scene.userId, {
              sourceType: "concurrency-probe",
              sourceId: `res-${randomUUID().slice(0, 8)}-${String(i)}`,
              productVariantId: scene.variantId,
              warehouseId: scene.warehouseId,
              locationId: location,
              qty: `${String(each)}.0000`,
            }),
          ),
        ),
      );

      const accepted = results.filter((r) => r.status === "fulfilled").length;
      const rows = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ committed: string; on_hand: string }>(sql`
          SELECT COALESCE(SUM(committed), 0)::text AS committed,
                 COALESCE(SUM(on_hand), 0)::text AS on_hand
          FROM inv_stock_levels
          WHERE org_id = ${scene.orgId} AND product_variant_id = ${scene.variantId}
            AND location_id = ${location}`),
      );
      // A promise of stock that is not there is the failure this guards.
      expect(Number(rows[0]!.committed)).toBe(accepted * each);
      expect(Number(rows[0]!.committed)).toBeLessThanOrEqual(Number(rows[0]!.on_hand));
      await expectReconciled();
    },
    300_000,
  );
  describe("the same create-adjustment request, sent twice", () => {
    const adjustments = () => app.app.get(InvStockAdjustmentsService);

    const setThreshold = (value: string | null) =>
      asTenant(() =>
        app.app
          .get(InventorySettingsService)
          .update(scene.orgId, { adjustmentApprovalThreshold: value }, scene.userId),
      );

    const documentsNoted = async (note: string) => {
      const [row] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM inv_stock_adjustments
          WHERE org_id = ${scene.orgId} AND notes = ${note}`),
      );
      return row!.n;
    };

    it("raises one adjustment on the branch that waits for approval", async () => {
      // A3, and the branch that had no protection at all. Below the approval
      // threshold the key went to the engine and the *movement* was safe. Above
      // it the command stops at PENDING_APPROVAL, posts nothing, and so claimed
      // nothing — a retry raised a second write-off document with its own
      // reference number, and both were then approvable and postable.
      await setThreshold("5.0000");
      const key = `adj-approval-${randomUUID()}`;
      const data = {
        reason: "DAMAGE",
        notes: key,
        lines: [{ productVariantId: scene.variantId, locationId: scene.locationA, quantityChange: -50 }],
      };

      const first = await asTenant(() =>
        adjustments().createAdjustment(scene.orgId, scene.userId, data as never, key),
      );
      const second = await asTenant(() =>
        adjustments().createAdjustment(scene.orgId, scene.userId, data as never, key),
      );

      expect(second!.id).toBe(first!.id);
      expect(first!.status).toBe("PENDING_APPROVAL");
      expect(await documentsNoted(key)).toBe(1);
    });

    it("posts one adjustment on the branch that posts immediately", async () => {
      // The other branch. It was correct only by accident: the engine hashes
      // its command, the command names the new adjustment's id, so an identical
      // retry looked like a different request and got 422. The stock was safe
      // and the caller was told something untrue.
      await setThreshold(null);
      await command(`adj-seed-${randomUUID()}`, [
        {
          transactionType: "PURCHASE",
          productVariantId: scene.variantId,
          locationId: scene.locationA,
          quantityDelta: "40.0000",
          unitCost: "1.0000",
        },
      ]);
      const before = await onHandAt(scene.locationA);

      const key = `adj-post-${randomUUID()}`;
      const data = {
        reason: "RECOUNT",
        notes: key,
        lines: [{ productVariantId: scene.variantId, locationId: scene.locationA, quantityChange: -10 }],
      };

      const first = await asTenant(() =>
        adjustments().createAdjustment(scene.orgId, scene.userId, data as never, key),
      );
      const second = await asTenant(() =>
        adjustments().createAdjustment(scene.orgId, scene.userId, data as never, key),
      );

      expect(second!.id).toBe(first!.id);
      expect(first!.status).toBe("POSTED");
      expect(await documentsNoted(key)).toBe(1);
      expect(await onHandAt(scene.locationA)).toBe(before - 10);
      await expectReconciled();
    });
  });
});
