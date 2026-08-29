import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { SyncBatchService } from "src/modules/inventory/sync/sync-batch.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * INV-208 — replaying a device's offline queue.
 *
 * The properties worth proving are the ones a naive implementation gets wrong
 * in ways nobody notices until stock is missing: replay must be free, a
 * conflict must be reported rather than forced, and one bad operation must not
 * discard the good ones around it.
 */
interface Scene {
  orgId: string;
  userId: string;
  variantId: number;
  locationId: number;
}

describe("[seeded-e2e] offline sync batch", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const sync = () => app.app.get(SyncBatchService);
  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  const onHand = async () => {
    const [row] = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{ total: string }>(sql`
        SELECT COALESCE(SUM(on_hand), 0)::text AS total FROM inv_stock_levels
        WHERE org_id = ${scene.orgId} AND product_variant_id = ${scene.variantId}`),
    );
    return row!.total;
  };

  const adjust = (clientOperationId: string, delta: string, occurredAt: string) => ({
    type: "stock.adjust" as const,
    clientOperationId,
    occurredAt,
    productVariantId: scene.variantId,
    locationId: scene.locationId,
    quantityDelta: delta,
  });

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("device", {
        permissionKeys: [
          "inventory:warehouses:scope-all",
          "inventory:stock:read",
          "inventory:stock:adjust",
        ],
      })
      .build();
    teardown = () => seeded.teardown();

    const tag = randomUUID().slice(0, 6);
    const db = app.app.get<Db>(DRIZZLE);
    scene = await runInNewTenantTransaction(db, seeded.orgId, async () => {
      const userId = seeded.members["device"]!.userId;
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db.execute<T>(q))[0]!;
      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Synced goods', ${`SY-${tag}`}, ${userId})
        RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`SY-${tag}-V`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Main', ${`MN${tag}`}, ${userId}) RETURNING id`);
      const location = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Bin', ${`B${tag}`}, 'BIN') RETURNING id`);
      return {
        orgId: seeded.orgId,
        userId,
        variantId: variant.id,
        locationId: location.id,
      };
    });

    await asTenant(() =>
      app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
        idempotencyKey: `sync-seed-${tag}`,
        sourceType: "sync-fixture",
        sourceId: tag,
        movements: [
          {
            transactionType: "PURCHASE",
            productVariantId: scene.variantId,
            locationId: scene.locationId,
            quantityDelta: "100.0000",
            unitCost: "1.0000",
          },
        ],
      }),
    );
  }, 240_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  it("applies a queued batch", async () => {
    // The control.
    const before = await onHand();
    const result = await asTenant(() =>
      sync().apply(scene.orgId, scene.userId, {
        operations: [
          adjust(`op-${randomUUID()}`, "5.0000", "2026-08-28T09:00:00.000Z"),
          adjust(`op-${randomUUID()}`, "3.0000", "2026-08-28T09:01:00.000Z"),
        ],
      }),
    );

    expect(result.applied).toBe(2);
    expect(result.conflicts).toBe(0);
    expect(Number(await onHand())).toBe(Number(before) + 8);
  });

  it("replays a batch for free", async () => {
    // A device that cannot tell whether its last request arrived will send it
    // again, and it must be free to. Replay adding the stock twice is how a
    // flaky network becomes a stock discrepancy.
    const ops = [
      adjust(`op-${randomUUID()}`, "7.0000", "2026-08-28T10:00:00.000Z"),
      adjust(`op-${randomUUID()}`, "2.0000", "2026-08-28T10:01:00.000Z"),
    ];

    await asTenant(() => sync().apply(scene.orgId, scene.userId, { operations: ops }));
    const afterFirst = await onHand();

    const second = await asTenant(() =>
      sync().apply(scene.orgId, scene.userId, { operations: ops }),
    );

    expect(second.duplicates).toBe(2);
    expect(second.applied).toBe(0);
    expect(await onHand()).toBe(afterFirst);
  });

  it("reports a conflict instead of forcing it through", async () => {
    // The device has been offline; the shelf emptied while it was away.
    // Forcing this would let six hours of stale belief overwrite decisions
    // made by people who could see the shelf.
    const before = await onHand();
    const result = await asTenant(() =>
      sync().apply(scene.orgId, scene.userId, {
        operations: [
          adjust(`op-${randomUUID()}`, "-999999.0000", "2026-08-28T11:00:00.000Z"),
        ],
      }),
    );

    expect(result.conflicts + result.failures).toBe(1);
    expect(result.applied).toBe(0);
    expect(result.results[0]!.reason).toBeDefined();
    expect(await onHand()).toBe(before);
  });

  it("does not let one bad operation discard the good ones", async () => {
    // A device told only "batch failed" has no way to know what to resend, and
    // will resend everything.
    const before = Number(await onHand());
    const result = await asTenant(() =>
      sync().apply(scene.orgId, scene.userId, {
        operations: [
          adjust(`op-${randomUUID()}`, "4.0000", "2026-08-28T12:00:00.000Z"),
          adjust(`op-${randomUUID()}`, "-999999.0000", "2026-08-28T12:01:00.000Z"),
          adjust(`op-${randomUUID()}`, "6.0000", "2026-08-28T12:02:00.000Z"),
        ],
      }),
    );

    expect(result.applied).toBe(2);
    expect(result.conflicts + result.failures).toBe(1);
    expect(Number(await onHand())).toBe(before + 10);
  });

  it("replays in the order the operator worked, not the order sent", async () => {
    // Two corrections to the same bin have to land in the order the human made
    // them, or the final position is a coin toss.
    const first = `op-${randomUUID()}`;
    const second = `op-${randomUUID()}`;
    const result = await asTenant(() =>
      sync().apply(scene.orgId, scene.userId, {
        operations: [
          // Deliberately serialised out of order.
          adjust(second, "1.0000", "2026-08-28T13:05:00.000Z"),
          adjust(first, "1.0000", "2026-08-28T13:00:00.000Z"),
        ],
      }),
    );

    expect(result.applied).toBe(2);
    expect(result.results.map((r) => r.clientOperationId)).toEqual([first, second]);
  });
  describe("a queued pick, sent twice at once", () => {
    /** A pick list with one line asking for `qty`, ready to be confirmed. */
    async function pickTask(qty: string): Promise<{ pickListId: number; pickLineId: number }> {
      const db = app.app.get<Db>(DRIZZLE);
      return runInNewTenantTransaction(db, scene.orgId, async () => {
        const tag = randomUUID().slice(0, 8);
        const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
          (await db.execute<T>(q))[0]!;
        const list = await one<{ id: number }>(sql`
          INSERT INTO inv_pick_lists (org_id, pick_number, status, created_by)
          VALUES (${scene.orgId}, ${`PK-${tag}`}, 'PENDING', ${scene.userId}) RETURNING id`);
        const line = await one<{ id: number }>(sql`
          INSERT INTO inv_pick_list_lines
            (org_id, pick_list_id, product_variant_id, location_id, quantity_to_pick)
          VALUES (${scene.orgId}, ${list.id}, ${scene.variantId}, ${scene.locationId}, ${qty})
          RETURNING id`);
        return { pickListId: list.id, pickLineId: line.id };
      });
    }

    const pickedOn = async (pickLineId: number) => {
      const [row] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ quantity_picked: string }>(sql`
          SELECT quantity_picked FROM inv_pick_list_lines
          WHERE org_id = ${scene.orgId} AND id = ${pickLineId}`),
      );
      return row!.quantity_picked;
    };

    it("picks the units once when the same operation arrives twice at once", async () => {
      // A3. The two operation types were not equally protected. `stock.adjust`
      // claims inside the engine, before its movement; the pick ran first and
      // wrote a COMPLETED row afterwards, which is a receipt, not a claim.
      // `confirmPick` adds to `quantity_picked` relatively, so two copies of
      // one operation in flight together both got past the COMPLETED read and
      // both picked — ten units out of a tote that holds five.
      const { pickListId, pickLineId } = await pickTask("10.0000");
      const operation = {
        type: "pick.confirm" as const,
        clientOperationId: `pick-${randomUUID()}`,
        occurredAt: "2026-08-28T14:00:00.000Z",
        pickListId,
        pickLineId,
        quantityPicked: "5.0000",
      };

      const [a, b] = await Promise.all([
        asTenant(() => sync().apply(scene.orgId, scene.userId, { operations: [operation] })),
        asTenant(() => sync().apply(scene.orgId, scene.userId, { operations: [operation] })),
      ]);

      expect(a.applied + b.applied).toBe(1);
      expect(a.duplicates + b.duplicates).toBe(1);
      expect(await pickedOn(pickLineId)).toBe("5.0000");
    });
  });
});
