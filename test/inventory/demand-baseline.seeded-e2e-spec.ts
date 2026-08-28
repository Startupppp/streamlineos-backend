import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { DemandBaselineService } from "src/modules/inventory/replenishment/forecast/demand-baseline.service";
import { SafetyStockPolicyService } from "src/modules/inventory/replenishment/forecast/safety-stock-policy.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * INV-301 — demand history against the real ledger.
 *
 * The arithmetic is unit-tested. What needs a database is the extraction: which
 * movements count as demand, and whether a quiet week comes back as a zero or
 * as a hole. The second one decides whether every downstream number is right,
 * because a series that omits its quiet weeks has a higher mean than the real
 * one and every safety stock computed from it will be too large.
 */
interface Scene {
  orgId: string;
  userId: string;
  soldVariantId: number;
  transferredVariantId: number;
  quietVariantId: number;
}

describe("[seeded-e2e] demand baselines", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const svc = () => app.app.get(DemandBaselineService);
  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("planner", { permissionKeys: ["inventory:replenishment:manage"] })
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
        VALUES (${seeded.orgId}, ${uom.id}, 'Forecast goods', ${`FC-${tag}`}, ${userId})
        RETURNING id`);
      const variantOf = async (name: string) =>
        (
          await one<{ id: number }>(sql`
            INSERT INTO inv_product_variants (org_id, product_id, name, sku)
            VALUES (${seeded.orgId}, ${product.id}, ${name}, ${`FC-${tag}-${name}`})
            RETURNING id`)
        ).id;

      const sold = await variantOf("sold");
      const transferred = await variantOf("transferred");
      const quiet = await variantOf("quiet");

      const movement = async (
        variantId: number,
        type: string,
        weeksAgo: number,
        qty: number,
      ) => {
        await db.execute(sql`
          INSERT INTO inv_stock_transactions
            (org_id, product_variant_id, transaction_type, quantity_change,
             quantity_before, quantity_after, posting_date, created_by)
          VALUES (${seeded.orgId}, ${variantId}, ${type}::inv_txn_type, ${-qty},
                  1000, ${1000 - qty},
                  (date_trunc('week', CURRENT_DATE) - (${weeksAgo} || ' weeks')::interval)::date,
                  ${userId})`);
      };

      // Sales in some weeks and deliberately none in others, so the dense
      // spine has something to be wrong about.
      for (const [weeksAgo, qty] of [[1, 5], [3, 7], [5, 4], [8, 9], [12, 6]] as const) {
        await movement(sold, "SALE", weeksAgo, qty);
      }
      // A warehouse move is not demand. Counting it would teach the forecast to
      // reorder for a relocation.
      for (const weeksAgo of [1, 2, 3, 4, 5]) {
        await movement(transferred, "TRANSFER_OUT", weeksAgo, 50);
      }

      return {
        orgId: seeded.orgId,
        userId,
        soldVariantId: sold,
        transferredVariantId: transferred,
        quietVariantId: quiet,
      };
    });
  }, 240_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  it("returns a dense weekly series, zeros included", async () => {
    // The load-bearing property. A gap where a quiet week should be raises the
    // mean of the whole series and inflates every safety stock derived from it.
    const history = await asTenant(() =>
      svc().history(scene.orgId, scene.soldVariantId, { weeks: 16 }),
    );
    expect(history).toHaveLength(16);
    expect(history.filter((p) => p.quantity === 0).length).toBeGreaterThan(5);
    expect(history.some((p) => p.quantity === 7)).toBe(true);
    // Strictly ascending periods: a forecaster that receives these backwards
    // produces a confident and entirely wrong answer.
    const periods = history.map((p) => p.period);
    expect([...periods].sort()).toEqual(periods);
  });

  it("counts sales as demand and warehouse transfers as not", async () => {
    const sold = await asTenant(() =>
      svc().history(scene.orgId, scene.soldVariantId, { weeks: 16 }),
    );
    const transferred = await asTenant(() =>
      svc().history(scene.orgId, scene.transferredVariantId, { weeks: 16 }),
    );
    expect(sold.reduce((a, p) => a + p.quantity, 0)).toBe(31);
    // Five 50-unit transfers, and none of them are demand.
    expect(transferred.reduce((a, p) => a + p.quantity, 0)).toBe(0);
  });

  it("names a champion baseline once there is enough history", async () => {
    const report = await asTenant(() =>
      svc().baseline(scene.orgId, scene.soldVariantId, { weeks: 26 }),
    );
    expect(report.champion).not.toBeNull();
    expect(report.ranked.length).toBeGreaterThan(1);
    // Ranked best first, and every entry actually measured something.
    expect(report.ranked[0]!.metrics.mae).toBeLessThanOrEqual(
      report.ranked[report.ranked.length - 1]!.metrics.mae,
    );
    expect(report.ranked[0]!.metrics.n).toBeGreaterThan(0);
  });

  it("refuses to name a champion for a SKU nobody has bought", async () => {
    // "Not enough data" is a real answer. A confident forecast from no demand
    // is how a replenishment engine orders a year of something nobody wants.
    const report = await asTenant(() =>
      svc().baseline(scene.orgId, scene.quietVariantId, { weeks: 26 }),
    );
    expect(report.champion).toBeNull();
    expect(report.insufficientReason).toMatch(/No demand recorded/);
  });

  it("classifies the demand shape alongside the ranking", async () => {
    // INV-302. Five sales across twenty-six weeks is gappy by construction, and
    // the category is what decides which methods are even defensible.
    const report = await asTenant(() =>
      svc().baseline(scene.orgId, scene.soldVariantId, { weeks: 26 }),
    );
    expect(["intermittent", "lumpy"]).toContain(report.classification.category);
    expect(report.classification.adi).toBeGreaterThan(1.32);
    expect(report.classification.nonZeroPeriods).toBe(5);
  });

  it("chooses a method the demand shape can justify", async () => {
    // The point of the restriction: on gappy demand a period average has small
    // error every week and implies a nonsense reorder point, so it must not be
    // able to win the ranking.
    const report = await asTenant(() =>
      svc().baseline(scene.orgId, scene.soldVariantId, { weeks: 26 }),
    );
    expect(["croston", "naive"]).toContain(report.champion!.method);
    // And when error alone would have picked something else, the disagreement
    // is reported rather than resolved silently.
    if (report.unrestrictedBest!.method !== report.champion!.method) {
      expect(report.shapeNote).toMatch(/cannot justify/);
    }
  });

  it("declines to name a season it has not seen twice", async () => {
    const report = await asTenant(() =>
      svc().baseline(scene.orgId, scene.soldVariantId, { weeks: 26 }),
    );
    // Twenty-six weekly points cannot support a 52-week claim, and the
    // candidate list shows which lags were even considered.
    expect(report.seasonality.candidates.some((c) => c.lag === 52)).toBe(false);
  });

  describe("INV-303 safety stock policy", () => {
    const policy = () => app.app.get(SafetyStockPolicyService);

    it("refuses a normal-model buffer for gappy demand", async () => {
      // The guard that matters. The arithmetic would still produce a number,
      // and the number would still look like a service level, which is exactly
      // why returning it with a footnote is not good enough.
      const result = await asTenant(() =>
        policy().policyFor(scene.orgId, scene.soldVariantId, { weeks: 26 }),
      );
      expect(result.applicable).toBe(false);
      expect(result.policy).toBeNull();
      expect(result.notes.join(" ")).toMatch(/does not describe it/);
    });

    it("says so when there is no demand to buffer against", async () => {
      const result = await asTenant(() =>
        policy().policyFor(scene.orgId, scene.quietVariantId, { weeks: 26 }),
      );
      expect(result.demandCategory).toBe("no_demand");
      expect(result.notes.join(" ")).toMatch(/nothing to buffer/);
    });

    it("flags a lead time it could not measure", async () => {
      // No receipts on record. The difference between "this supplier is
      // reliable" and "nobody measured" is invisible in the number and
      // decisive for the answer.
      const result = await asTenant(() =>
        policy().policyFor(scene.orgId, scene.soldVariantId, { weeks: 26 }),
      );
      expect(result.leadTime.observations).toBe(0);
      expect(result.notes.join(" ")).toMatch(/cannot support a lead-time deviation/);
    });

    it("reports demand statistics whether or not the model applies", async () => {
      // The refusal must not swallow the facts the refusal was based on.
      const result = await asTenant(() =>
        policy().policyFor(scene.orgId, scene.soldVariantId, { weeks: 26 }),
      );
      expect(result.demand.periods).toBeGreaterThan(20);
      expect(result.demand.mean).toBeGreaterThan(0);
    });
  });

  it("refuses to judge a baseline on a handful of weeks", async () => {
    const report = await asTenant(() =>
      svc().baseline(scene.orgId, scene.soldVariantId, { weeks: 6 }),
    );
    expect(report.champion).toBeNull();
    expect(report.insufficientReason).toMatch(/at least/);
  });
});
