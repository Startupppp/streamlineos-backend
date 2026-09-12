import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import {
  DemandBaselineService,
  demandSeries,
} from "src/modules/inventory/replenishment/forecast/demand-baseline.service";
import { ForecastPersistenceService } from "src/modules/inventory/replenishment/forecast/forecast-persistence.service";
import { ReorderProposalService } from "src/modules/inventory/replenishment/forecast/reorder-proposal.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * C1 — the forecast is stored, it is per warehouse, and its numbers are exact.
 *
 * The fixture is one SKU that is *simultaneously* short and long: it sells ten a
 * week at North, where five units are left, and sells none at South, where five
 * hundred sit on a shelf. Organisation-wide that SKU looks comfortable, which is
 * the failure this unit exists to remove — the engine used to answer only
 * org-wide, so the site about to stock out was invisible behind the site that
 * was drowning.
 *
 * Alongside it: a SKU that ran to zero and stayed there (censoring), a SKU with
 * gappy demand the normal model refuses (a refusal that must be *stored*), and a
 * warehouse-restricted operator (the scope gate).
 */
interface Scene {
  orgId: string;
  plannerId: string;
  operatorId: string;
  northWh: number;
  southWh: number;
  splitVariantId: number;
  stockoutVariantId: number;
  gappyVariantId: number;
}

describe("[seeded-e2e] forecast persistence and warehouse scope", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const versions = () => app.app.get(ForecastPersistenceService);
  const baselines = () => app.app.get(DemandBaselineService);
  const proposals = () => app.app.get(ReorderProposalService);
  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  const storedRows = (variantId: number) =>
    asTenant(async () => {
      const rows = await app.app.get<Db>(DRIZZLE).execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM inv_demand_forecasts
        WHERE org_id = ${scene.orgId} AND product_variant_id = ${variantId}`);
      return rows[0]!.n;
    });

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
      // Deliberately without `scope-all`: this is the operator the warehouse
      // gate is for.
      .addMember("operator", { permissionKeys: ["inventory:replenishment:manage"] })
      .build();
    teardown = () => seeded.teardown();

    const tag = randomUUID().slice(0, 6);
    const db = app.app.get<Db>(DRIZZLE);
    scene = await runInNewTenantTransaction(db, seeded.orgId, async () => {
      const plannerId = seeded.members["planner"]!.userId;
      const operatorId = seeded.members["operator"]!.userId;
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db.execute<T>(q))[0]!;

      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Persisted goods', ${`PF-${tag}`}, ${plannerId})
        RETURNING id`);
      const variantOf = async (name: string) =>
        (
          await one<{ id: number }>(sql`
            INSERT INTO inv_product_variants (org_id, product_id, name, sku)
            VALUES (${seeded.orgId}, ${product.id}, ${name}, ${`PF-${tag}-${name}`})
            RETURNING id`)
        ).id;

      const siteOf = async (name: string) => {
        const wh = await one<{ id: number }>(sql`
          INSERT INTO inv_warehouses (org_id, name, code, created_by)
          VALUES (${seeded.orgId}, ${name}, ${`${name.slice(0, 3)}${tag}`}, ${plannerId})
          RETURNING id`);
        const loc = await one<{ id: number }>(sql`
          INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
          VALUES (${seeded.orgId}, ${wh.id}, 'Bin', ${`${name.slice(0, 3)}B${tag}`}, 'BIN')
          RETURNING id`);
        return { warehouseId: wh.id, locationId: loc.id };
      };

      const north = await siteOf("North");
      const south = await siteOf("South");

      const stock = async (variantId: number, locationId: number, onHand: number) =>
        db.execute(sql`
          INSERT INTO inv_stock_levels (org_id, product_variant_id, location_id, on_hand)
          VALUES (${seeded.orgId}, ${variantId}, ${locationId}, ${String(onHand)})`);

      const sale = async (
        variantId: number,
        locationId: number,
        weeksAgo: number,
        qty: number,
      ) =>
        db.execute(sql`
          INSERT INTO inv_stock_transactions
            (org_id, product_variant_id, location_id, transaction_type, quantity_change,
             quantity_before, quantity_after, posting_date, created_by)
          VALUES (${seeded.orgId}, ${variantId}, ${locationId}, 'SALE', ${-qty},
                  1000, ${1000 - qty},
                  (date_trunc('week', CURRENT_DATE) - (${weeksAgo} || ' weeks')::interval)::date,
                  ${plannerId})`);

      // Short at North, long at South, and the two cancel out org-wide.
      const split = await variantOf("split");
      await stock(split, north.locationId, 5);
      await stock(split, south.locationId, 500);
      for (let w = 1; w <= 40; w += 1) await sale(split, north.locationId, w, 10 + (w % 3));

      // Sold out eight weeks ago and never restocked: the recent zeros are the
      // stockout, not the demand.
      const stockout = await variantOf("stockout");
      await stock(stockout, north.locationId, 0);
      for (const w of [8, 9, 10, 11, 12]) await sale(stockout, north.locationId, w, 10);

      // Five sales in half a year: gappy, and the normal model must refuse it.
      const gappy = await variantOf("gappy");
      await stock(gappy, north.locationId, 60);
      for (const [w, qty] of [[2, 5], [6, 7], [11, 4], [17, 9], [23, 6]] as const) {
        await sale(gappy, north.locationId, w, qty);
      }

      await db.execute(sql`
        INSERT INTO inv_user_warehouses (org_id, user_id, warehouse_id, granted_by)
        VALUES (${seeded.orgId}, ${operatorId}, ${north.warehouseId}, ${plannerId})`);

      return {
        orgId: seeded.orgId,
        plannerId,
        operatorId,
        northWh: north.warehouseId,
        southWh: south.warehouseId,
        splitVariantId: split,
        stockoutVariantId: stockout,
        gappyVariantId: gappy,
      };
    });
  }, 300_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  describe("the demand extract is warehouse-scoped", () => {
    it("reports one site's demand at that site and not at the other", async () => {
      const north = await asTenant(() =>
        baselines().history(scene.orgId, scene.splitVariantId, {
          weeks: 40,
          warehouseId: scene.northWh,
        }),
      );
      const south = await asTenant(() =>
        baselines().history(scene.orgId, scene.splitVariantId, {
          weeks: 40,
          warehouseId: scene.southWh,
        }),
      );
      expect(demandSeries(north).reduce((a, q) => a + q, 0)).toBeGreaterThan(300);
      // The same SKU, the same window, a different site: nothing sold here.
      expect(demandSeries(south).reduce((a, q) => a + q, 0)).toBe(0);
    });

    it("proposes at the site that is short while the organisation looks comfortable", async () => {
      // The whole reason the scope exists. Org-wide, 505 units against a reorder
      // point in the twenties is a hold; at North there are five.
      const orgWide = await asTenant(() =>
        proposals().propose(scene.orgId, scene.splitVariantId, { weeks: 40 }),
      );
      const atNorth = await asTenant(() =>
        proposals().propose(scene.orgId, scene.splitVariantId, {
          weeks: 40,
          warehouseId: scene.northWh,
        }),
      );

      expect(orgWide.reorderPoint).not.toBeNull();
      expect(orgWide.recommendation).toBe("hold");
      expect(orgWide.suggestedQuantity).toBeNull();

      expect(atNorth.warehouseId).toBe(scene.northWh);
      expect(atNorth.suggestedQuantity).not.toBeNull();
      expect(Number(atNorth.suggestedQuantity)).toBeGreaterThan(0);
    });

    it("keeps every quantity exact rather than a float", async () => {
      // C1's own rule: a ledger quantity never passes through a float, and the
      // figure a buyer acts on is exact. Four decimal places, as a string.
      const atNorth = await asTenant(() =>
        proposals().propose(scene.orgId, scene.splitVariantId, {
          weeks: 40,
          warehouseId: scene.northWh,
        }),
      );
      for (const value of [
        atNorth.position.onHand,
        atNorth.position.committed,
        atNorth.position.onOrder,
        atNorth.position.available,
        atNorth.reorderPoint!,
        atNorth.suggestedQuantity!,
      ]) {
        expect(typeof value).toBe("string");
        expect(value).toMatch(/^-?\d+\.\d{4}$/);
      }
      expect(atNorth.position.onHand).toBe("5.0000");
    });
  });

  describe("stockout censoring", () => {
    it("marks the periods that closed with nothing on the shelf", async () => {
      // A zero that means "nobody wanted any" and a zero that means "we had none
      // to sell" are the same number and opposite facts.
      const history = await asTenant(() =>
        baselines().history(scene.orgId, scene.stockoutVariantId, {
          weeks: 26,
          warehouseId: scene.northWh,
        }),
      );
      const censored = history.filter((p) => p.stockoutCensored);
      expect(censored.length).toBeGreaterThan(3);
      // The censored run is the recent one — the weeks after it sold out.
      expect(history[history.length - 1]!.stockoutCensored).toBe(true);
      // And the weeks it was still selling are not censored.
      expect(history.some((p) => !p.stockoutCensored)).toBe(true);
    });

    it("does not cry stockout at a site that always had stock", async () => {
      // The control. Without it the flag could be true everywhere and still pass
      // the test above.
      const history = await asTenant(() =>
        baselines().history(scene.orgId, scene.splitVariantId, {
          weeks: 26,
          warehouseId: scene.southWh,
        }),
      );
      expect(history.every((p) => !p.stockoutCensored)).toBe(true);
    });

    it("carries the censoring into the report and its caveats", async () => {
      const report = await asTenant(() =>
        baselines().baseline(scene.orgId, scene.stockoutVariantId, {
          weeks: 26,
          warehouseId: scene.northWh,
        }),
      );
      expect(report.stockoutCensored).toBe(true);
      expect(report.censoredPeriods).toBeGreaterThan(0);
      expect(report.censoringNote).toMatch(/lower bound/);
    });
  });

  describe("a forecast version is stored", () => {
    it("stores one version and returns the same one for the same fixture", async () => {
      // The phase's acceptance test. Two calls over unchanged data must produce
      // the *same stored version*, not two rows that happen to agree.
      const first = await asTenant(() =>
        versions().generate(scene.orgId, scene.plannerId, {
          productVariantId: scene.splitVariantId,
          warehouseId: scene.northWh,
          historyWeeks: 40,
        }),
      );
      const second = await asTenant(() =>
        versions().generate(scene.orgId, scene.plannerId, {
          productVariantId: scene.splitVariantId,
          warehouseId: scene.northWh,
          historyWeeks: 40,
        }),
      );

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.version.id).toBe(first.version.id);
      expect(second.version.inputFingerprint).toBe(first.version.inputFingerprint);
      expect(second.version.generatedAt).toBe(first.version.generatedAt);
      expect(await storedRows(scene.splitVariantId)).toBe(1);
    });

    it("records what the forecast claimed, not just that one was made", async () => {
      const stored = await asTenant(() =>
        versions().latest(scene.orgId, scene.splitVariantId, scene.northWh),
      );
      expect(stored).not.toBeNull();
      expect(stored!.warehouseId).toBe(scene.northWh);
      expect(stored!.applicable).toBe(true);
      expect(stored!.method).not.toBeNull();
      expect(stored!.demandCategory).toBe("smooth");
      expect(stored!.historyWeeks).toBe(40);
      expect(stored!.horizonWeeks).toBeGreaterThan(0);
      expect(stored!.coverage.from < stored!.coverage.to).toBe(true);
      expect(stored!.metrics).not.toBeNull();
      // Quantities come back exact, as they went in.
      expect(stored!.safetyStock).toMatch(/^\d+\.\d{4}$/);
      expect(stored!.reorderPoint).toMatch(/^\d+\.\d{4}$/);
      expect(stored!.assumptions).toHaveProperty("demandDefinition");
      expect(stored!.assumptions).toHaveProperty("ranking");
    });

    it("keeps a warehouse's forecast separate from the organisation's", async () => {
      // Same SKU, same day, two scopes: two versions, because they are two
      // different claims.
      const orgWide = await asTenant(() =>
        versions().generate(scene.orgId, scene.plannerId, {
          productVariantId: scene.splitVariantId,
          warehouseId: null,
          historyWeeks: 40,
        }),
      );
      expect(orgWide.created).toBe(true);
      expect(orgWide.version.warehouseId).toBeNull();

      const latestNorth = await asTenant(() =>
        versions().latest(scene.orgId, scene.splitVariantId, scene.northWh),
      );
      expect(latestNorth!.id).not.toBe(orgWide.version.id);
      expect(await storedRows(scene.splitVariantId)).toBe(2);

      // And the org-wide re-run is idempotent too, which is what
      // `NULLS NOT DISTINCT` on the fingerprint index buys.
      const again = await asTenant(() =>
        versions().generate(scene.orgId, scene.plannerId, {
          productVariantId: scene.splitVariantId,
          warehouseId: null,
          historyWeeks: 40,
        }),
      );
      expect(again.created).toBe(false);
      expect(again.version.id).toBe(orgWide.version.id);
      expect(await storedRows(scene.splitVariantId)).toBe(2);
    });

    it("appends a new version when the inputs actually change", async () => {
      // A different window is a different question, so it is a different stored
      // answer rather than an overwrite of the first.
      const shorter = await asTenant(() =>
        versions().generate(scene.orgId, scene.plannerId, {
          productVariantId: scene.splitVariantId,
          warehouseId: scene.northWh,
          historyWeeks: 30,
        }),
      );
      expect(shorter.created).toBe(true);
      const history = await asTenant(() =>
        versions().versions(scene.orgId, scene.splitVariantId, scene.northWh, { limit: 10 }),
      );
      expect(history.total).toBe(2);
      expect(history.items.map((v) => v.historyWeeks).sort()).toEqual([30, 40]);
    });

    it("stores the refusal, with its reason, rather than storing nothing", async () => {
      // The other half of the phase's acceptance test. An intermittent SKU is
      // refused by INV-303 already; what C1 adds is that the refusal is a row
      // somebody can find later, and the CHECK in 0541 makes a refusal without a
      // reason impossible to write.
      const refused = await asTenant(() =>
        versions().generate(scene.orgId, scene.plannerId, {
          productVariantId: scene.gappyVariantId,
          warehouseId: scene.northWh,
          historyWeeks: 26,
        }),
      );
      expect(refused.version.applicable).toBe(false);
      expect(refused.version.safetyStock).toBeNull();
      expect(refused.version.reorderPoint).toBeNull();
      expect(refused.version.refusalReason).toBeTruthy();
      expect(["intermittent", "lumpy"]).toContain(refused.version.demandCategory);

      const stored = await asTenant(() =>
        versions().latest(scene.orgId, scene.gappyVariantId, scene.northWh),
      );
      expect(stored!.id).toBe(refused.version.id);
      expect(stored!.refusalReason).toMatch(/does not describe it|nothing to buffer/);
    });

    it("stores the censoring alongside the forecast it undermines", async () => {
      const version = await asTenant(() =>
        versions().generate(scene.orgId, scene.plannerId, {
          productVariantId: scene.stockoutVariantId,
          warehouseId: scene.northWh,
          historyWeeks: 26,
        }),
      );
      expect(version.version.stockoutCensored).toBe(true);
      expect(version.version.censoredPeriods).toBeGreaterThan(0);
      expect(version.version.assumptions.censoringNote).toMatch(/lower bound/);
    });
  });

  describe("the warehouse gate", () => {
    it("answers a restricted operator with their own warehouse", async () => {
      // One assignment is an unambiguous choice; making them type it out buys
      // nothing.
      const scoped = await asTenant(() =>
        baselines().scopeFor(scene.orgId, scene.operatorId),
      );
      expect(scoped).toBe(scene.northWh);
    });

    it("refuses a warehouse the operator is not assigned to, as a 404", async () => {
      // A 403 on somebody else's id confirms it exists, which turns a probe into
      // an existence oracle.
      await expect(
        asTenant(() => baselines().scopeFor(scene.orgId, scene.operatorId, scene.southWh)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("lets an org-wide planner ask for the organisation or for one site", async () => {
      expect(await asTenant(() => baselines().scopeFor(scene.orgId, scene.plannerId))).toBeNull();
      expect(
        await asTenant(() => baselines().scopeFor(scene.orgId, scene.plannerId, scene.southWh)),
      ).toBe(scene.southWh);
    });
  });
});
