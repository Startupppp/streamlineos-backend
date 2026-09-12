import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { TransferRecommendationService } from "src/modules/inventory/replenishment/forecast/transfer-recommendation.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * INV-308 — moving stock instead of buying it.
 *
 * The fixture is three sites: one busy and nearly out, one busy and
 * comfortable, one holding a pile it never sells. That shape is what separates
 * a working recommendation from a plausible one, because comparing units rather
 * than weeks of cover picks the wrong donor in exactly this arrangement.
 */
interface Scene {
  orgId: string;
  userId: string;
  variantId: number;
  shortWh: number;
  comfortableWh: number;
  idleWh: number;
}

describe("[seeded-e2e] transfer recommendations", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const svc = () => app.app.get(TransferRecommendationService);
  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("planner", {
        permissionKeys: [
          "inventory:warehouses:scope-all",
          "inventory:replenishment:manage",
        ],
      })
      .build();
    teardown = () => seeded.teardown();

    const tag = randomUUID().slice(0, 6);
    const db = app.app.get<Db>(DRIZZLE);
    scene = await runInNewTenantTransaction(db, seeded.orgId, async () => {
      const userId = seeded.members["planner"]!.userId;
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db.execute<T>(q))[0]!;
      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Network goods', ${`TR-${tag}`}, ${userId})
        RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`TR-${tag}-V`}) RETURNING id`);

      const site = async (name: string, onHand: number, weeklySales: number) => {
        const wh = await one<{ id: number }>(sql`
          INSERT INTO inv_warehouses (org_id, name, code, created_by)
          VALUES (${seeded.orgId}, ${name}, ${`${name.slice(0, 3)}${tag}`}, ${userId})
          RETURNING id`);
        const loc = await one<{ id: number }>(sql`
          INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
          VALUES (${seeded.orgId}, ${wh.id}, 'Bin', ${`${name.slice(0, 3)}B${tag}`}, 'BIN')
          RETURNING id`);
        await db.execute(sql`
          INSERT INTO inv_stock_levels (org_id, product_variant_id, location_id, on_hand)
          VALUES (${seeded.orgId}, ${variant.id}, ${loc.id}, ${String(onHand)})`);
        for (let w = 1; w <= 12 && weeklySales > 0; w += 1) {
          await db.execute(sql`
            INSERT INTO inv_stock_transactions
              (org_id, product_variant_id, location_id, transaction_type,
               quantity_change, quantity_before, quantity_after, posting_date, created_by)
            VALUES (${seeded.orgId}, ${variant.id}, ${loc.id}, 'SALE',
                    ${-weeklySales}, 1000, ${1000 - weeklySales},
                    (CURRENT_DATE - (${w} * 7))::date, ${userId})`);
        }
        return wh.id;
      };

      return {
        orgId: seeded.orgId,
        userId,
        variantId: variant.id,
        // Sells 20/wk, holds 10 — half a week of cover.
        shortWh: await site("Short", 10, 20),
        // Sells 10/wk, holds 300 — thirty weeks of cover.
        comfortableWh: await site("Comfortable", 300, 10),
        // Sells nothing, holds 40. Fewer units than Comfortable, but all spare.
        idleWh: await site("Idle", 40, 0),
      };
    });
  }, 300_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  it("measures every site in weeks of cover, not units", async () => {
    const plan = await asTenant(() => svc().plan(scene.orgId, scene.userId, scene.variantId));
    const short = plan.positions.find((p) => p.warehouseId === scene.shortWh)!;
    const comfortable = plan.positions.find((p) => p.warehouseId === scene.comfortableWh)!;
    expect(short.weeksOfCover).toBeCloseTo(0.5, 1);
    expect(comfortable.weeksOfCover).toBeCloseTo(30, 0);
  });

  it("reports a site that sells nothing as having no cover figure, not infinite", async () => {
    // Infinity is not a number, and reporting it as one makes every idle site
    // look like the best donor in the network by a mile.
    const plan = await asTenant(() => svc().plan(scene.orgId, scene.userId, scene.variantId));
    const idle = plan.positions.find((p) => p.warehouseId === scene.idleWh)!;
    expect(idle.weeklyDemand).toBe(0);
    expect(idle.weeksOfCover).toBeNull();
  });

  it("recommends moving stock to the site that is short", async () => {
    const plan = await asTenant(() => svc().plan(scene.orgId, scene.userId, scene.variantId));
    expect(plan.recommendations.length).toBeGreaterThan(0);
    for (const rec of plan.recommendations) {
      expect(rec.toWarehouseId).toBe(scene.shortWh);
      expect(rec.quantity).toBeGreaterThanOrEqual(5);
    }
  });

  it("never strips a donor below its own cover floor", async () => {
    // Solving a stockout at one site by creating one at another looks like
    // progress on the report that recommended it.
    const plan = await asTenant(() => svc().plan(scene.orgId, scene.userId, scene.variantId));
    for (const rec of plan.recommendations) {
      if (rec.coverAfter.from !== null) {
        expect(rec.coverAfter.from).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it("never sends stock to a site that sells none of it", async () => {
    // A transfer cost for no service improvement.
    const plan = await asTenant(() => svc().plan(scene.orgId, scene.userId, scene.variantId));
    expect(plan.recommendations.some((r) => r.toWarehouseId === scene.idleWh)).toBe(false);
  });

  it("explains each move in terms a planner can check", async () => {
    const plan = await asTenant(() => svc().plan(scene.orgId, scene.userId, scene.variantId));
    for (const rec of plan.recommendations) {
      expect(rec.rationale).toMatch(/weeks of cover|sells none/);
      expect(rec.fromWarehouseName.length).toBeGreaterThan(0);
    }
  });
});
