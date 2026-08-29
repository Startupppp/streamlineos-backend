import { randomUUID } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { RecallsService } from "src/modules/inventory/quality/quality-recalls.service";
import { RecallSimulationService } from "src/modules/inventory/quality/recall-simulation.service";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * D4 — simulate, then execute, against a real database.
 *
 * The two properties the work order names, stated where they can actually be
 * observed:
 *
 *   1. Simulate twice gives the same set and writes nothing. The unit test
 *      proves the service never *calls* a writing method; this proves the
 *      warehouse is byte-for-byte unchanged afterwards, which is the claim an
 *      operator cares about.
 *   2. Execute is idempotent. Two posts with one key leave one recall
 *      document, one set of quality holds, and one quarantine movement per
 *      grain — the last of which used to double, because only the document
 *      was inside the idempotent unit.
 *
 * And the one that makes the simulate worth having at all: an execute
 * presenting evidence the warehouse has moved past is refused rather than
 * silently acting on a picture somebody read ten minutes ago.
 *
 *   pnpm test:e2e:seeded --testPathPattern=recall-simulate-execute
 */

const PERMISSIONS = [
  "inventory:warehouses:scope-all",
  "inventory:stock:read",
  "inventory:stock:adjust",
  "inventory:quality:read",
  "inventory:quality:recall",
  "inventory:quality:release",
] as const;

interface Scene {
  orgId: string;
  userId: string;
  variantId: number;
  warehouseId: number;
  locationId: number;
  otherLocationId: number;
  lotId: number;
  lotNumber: string;
}

const STOCKED_A = "100.0000";
const STOCKED_B = "40.0000";

interface Position extends Record<string, unknown> {
  recalls: number;
  recallLines: number;
  holds: number;
  quarantineTxns: number;
  lotStatus: string;
  onHand: string;
  qualityHold: string;
}

describe("[seeded-e2e] recall simulate and execute", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  const recalls = () => app.app.get(RecallsService);
  const simulator = () => app.app.get(RecallSimulationService);

  /**
   * Everything a recall touches, in one read. Comparing whole positions rather
   * than one counter at a time is what catches the failure this exists for: a
   * replay that leaves the document count right and doubles the holds.
   */
  const position = (): Promise<Position> =>
    asTenant(async () => {
      const [row] = await app.app.get<Db>(DRIZZLE).execute<Position>(sql`
        SELECT
          (SELECT count(*)::int FROM inv_recall_events WHERE org_id = ${scene.orgId}) AS recalls,
          (SELECT count(*)::int FROM inv_recall_lines  WHERE org_id = ${scene.orgId}) AS "recallLines",
          (SELECT count(*)::int FROM inv_quality_holds WHERE org_id = ${scene.orgId}) AS holds,
          (SELECT count(*)::int FROM inv_stock_transactions
             WHERE org_id = ${scene.orgId} AND transaction_type = 'QUARANTINE_IN') AS "quarantineTxns",
          (SELECT status::text FROM inv_lots
             WHERE org_id = ${scene.orgId} AND id = ${scene.lotId}) AS "lotStatus",
          (SELECT COALESCE(SUM(on_hand), 0)::text FROM inv_stock_levels
             WHERE org_id = ${scene.orgId} AND lot_id = ${scene.lotId}) AS "onHand",
          (SELECT COALESCE(SUM(quality_hold_qty), 0)::text FROM inv_stock_levels
             WHERE org_id = ${scene.orgId} AND lot_id = ${scene.lotId}) AS "qualityHold"`);
      return row!;
    });

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
      const userId = seeded.members["keeper"]!.userId;
      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, tracking_method, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Recalled goods', ${`RC-${tag}`}, 'LOT', ${userId})
        RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`RC-${tag}-V`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Main', ${`RW${tag}`}, ${userId}) RETURNING id`);
      const location = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Bin A', ${`RA${tag}`}, 'BIN', true) RETURNING id`);
      const otherLocation = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Bin B', ${`RB${tag}`}, 'BIN', true) RETURNING id`);
      const lotNumber = `L-${tag}`;
      const lot = await one<{ id: number }>(sql`
        INSERT INTO inv_lots (org_id, product_variant_id, lot_number, status, manufacture_date, expiry_date)
        VALUES (${seeded.orgId}, ${variant.id}, ${lotNumber}, 'ACTIVE', '2026-03-01', '2027-03-01')
        RETURNING id`);
      return {
        orgId: seeded.orgId,
        userId,
        variantId: variant.id,
        warehouseId: warehouse.id,
        locationId: location.id,
        otherLocationId: otherLocation.id,
        lotId: lot.id,
        lotNumber,
      };
    });

    // Two bins of the same lot, so "one hold per grain" is a real claim rather
    // than a coincidence of there being only one grain.
    await asTenant(() =>
      app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
        idempotencyKey: `recall-seed-a-${tag}`,
        sourceType: "recall-fixture",
        sourceId: tag,
        movements: [
          {
            transactionType: "PURCHASE",
            productVariantId: scene.variantId,
            locationId: scene.locationId,
            lotId: scene.lotId,
            quantityDelta: STOCKED_A,
            unitCost: "1.0000",
          },
          {
            transactionType: "PURCHASE",
            productVariantId: scene.variantId,
            locationId: scene.otherLocationId,
            lotId: scene.lotId,
            quantityDelta: STOCKED_B,
            unitCost: "1.0000",
          },
        ],
      }),
    );
  }, 300_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app?.close();
  }, 120_000);

  it("simulates the same set twice and writes nothing either time", async () => {
    const before = await position();

    const first = await asTenant(() =>
      simulator().simulate(scene.orgId, scene.userId, { lotIds: [scene.lotId] }),
    );
    const second = await asTenant(() =>
      simulator().simulate(scene.orgId, scene.userId, { lotIds: [scene.lotId] }),
    );

    expect(first.lots.map((l) => l.lotNumber)).toEqual([scene.lotNumber]);
    expect(first.totals.onHand).toBe("140.0000");
    expect(first.onHand).toHaveLength(2);
    expect(second.evidenceVersion).toBe(first.evidenceVersion);
    expect(second).toEqual(first);

    // The whole point: no holds, no lot status change, no ledger rows.
    expect(await position()).toEqual(before);
  }, 120_000);

  it("resolves the same lots from a product-and-date selection", async () => {
    const byLot = await asTenant(() =>
      simulator().simulate(scene.orgId, scene.userId, { lotIds: [scene.lotId] }),
    );
    const byWindow = await asTenant(() =>
      simulator().simulate(scene.orgId, scene.userId, {
        productVariantIds: [scene.variantId],
        manufacturedFrom: "2026-02-01",
        manufacturedTo: "2026-04-01",
      }),
    );

    expect(byWindow.lots.map((l) => l.lotId)).toEqual(byLot.lots.map((l) => l.lotId));
    // Different question, so a different hash even though the answer matches —
    // the evidence covers the selection too, and it has to, or a recall could
    // be executed against a picture produced by a different query.
    expect(byWindow.evidenceVersion).not.toBe(byLot.evidenceVersion);

    const outside = await asTenant(() =>
      simulator().simulate(scene.orgId, scene.userId, {
        productVariantIds: [scene.variantId],
        manufacturedFrom: "2027-01-01",
      }),
    );
    expect(outside.lots).toEqual([]);
  }, 120_000);

  it("refuses to execute against evidence the warehouse has moved past", async () => {
    const before = await position();

    await expect(
      asTenant(() =>
        recalls().create(
          scene.orgId,
          scene.userId,
          {
            title: "Stale reading",
            selection: { lotIds: [scene.lotId] },
            evidenceVersion: "0".repeat(32),
          },
          `stale-${randomUUID().slice(0, 8)}`,
        ),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(await position()).toEqual(before);
  }, 120_000);

  it("executes once, however many times the same key arrives", async () => {
    const simulated = await asTenant(() =>
      simulator().simulate(scene.orgId, scene.userId, { lotIds: [scene.lotId] }),
    );
    const request = {
      title: "Contaminated batch",
      description: "Simulated, reviewed, executed",
      selection: { lotIds: [scene.lotId] },
      evidenceVersion: simulated.evidenceVersion,
    };
    const key = `recall-exec-${randomUUID().slice(0, 8)}`;

    const before = await position();
    const first = await asTenant(() =>
      recalls().create(scene.orgId, scene.userId, request, key),
    );
    const once = await position();

    expect(once.recalls).toBe(before.recalls + 1);
    expect(once.recallLines).toBe(before.recallLines + 1);
    // One hold per (lot, location) grain that actually had stock.
    expect(once.holds).toBe(before.holds + 2);
    expect(once.quarantineTxns).toBe(before.quarantineTxns + 2);
    // The allocator refuses any lot that is not ACTIVE, under every strategy —
    // this flip is the enforcement, the holds are the document trail.
    expect(once.lotStatus).toBe("RECALLED");
    // A recall quarantines goods; it does not make them disappear. `on_hand`
    // is what is physically on the shelf and must not move.
    expect(once.onHand).toBe("140.0000");
    expect(once.qualityHold).toBe("140.0000");

    const second = await asTenant(() =>
      recalls().create(scene.orgId, scene.userId, request, key),
    );

    expect(second?.id).toBe(first?.id);
    expect(await position()).toEqual(once);
  }, 180_000);

  it("stores the evidence the recall was executed against", async () => {
    const [row] = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{ version: string | null; lots: number | null }>(sql`
        SELECT evidence_version AS version,
               jsonb_array_length(evidence_snapshot -> 'lots') AS lots
        FROM inv_recall_events
        WHERE org_id = ${scene.orgId}
        ORDER BY id DESC
        LIMIT 1`),
    );

    // "We recalled 14 lots" is not evidence. This is: the exact impact set,
    // hashed, beside the recall it justified.
    expect(row!.version).toMatch(/^[0-9a-f]{32}$/);
    expect(row!.lots).toBe(1);
  }, 120_000);
});
