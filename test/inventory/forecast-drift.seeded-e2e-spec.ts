import { randomUUID } from "node:crypto";
import request from "supertest";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { ForecastPersistenceService } from "src/modules/inventory/replenishment/forecast/forecast-persistence.service";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * C7 — the SKU whose error has blown out shows up without being asked about.
 *
 * Two SKUs at one site. One sells a steady twenty a week; the other lurches
 * between almost nothing and several hundred, so any method fitted to it carries
 * an average error the size of an average week or worse. The watchlist has to
 * surface the second one ahead of the first, and hand back the stored versions
 * the number came from — a drift status with no route to its evidence is an
 * assertion, and an assertion about a forecast is what nobody acts on.
 *
 * The other half is the guarantee: reading this page must not regenerate
 * anything. The forecast id and the row count are captured before and compared
 * after.
 */
interface Scene {
  orgId: string;
  analystId: string;
  warehouseId: number;
  steadyVariantId: number;
  erraticVariantId: number;
  erraticForecastId: number;
}

describe(`${SEEDED_HARNESS} forecast drift monitoring`, () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let analystToken = "";
  let strangerToken = "";
  let teardown: () => Promise<void>;

  const server = () => app.app.getHttpServer();
  const db = () => app.app.get<Db>(DRIZZLE);
  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(db(), scene.orgId, work);

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("analyst", {
        permissionKeys: [
          "inventory:warehouses:scope-all",
          "inventory:replenishment:read",
          "inventory:replenishment:manage",
        ],
      })
      .addMember("stranger", { permissionKeys: ["inventory:reports:read"] })
      .build();
    teardown = () => seeded.teardown();

    const tag = randomUUID().slice(0, 6);
    scene = await runInNewTenantTransaction(db(), seeded.orgId, async () => {
      const orgId = seeded.orgId;
      const userId = seeded.members["analyst"]!.userId;
      await db().execute(sql`
        INSERT INTO org_modules (org_id, module_key, enabled)
        VALUES (${orgId}, 'inventory', true) ON CONFLICT DO NOTHING`);

      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db().execute<T>(q))[0]!;

      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${orgId}, 'Main', ${`DR${tag}`}, ${userId}) RETURNING id`);
      const location = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
        VALUES (${orgId}, ${warehouse.id}, 'Bin', ${`DB${tag}`}, 'BIN') RETURNING id`);

      const sku = async (suffix: string, weekly: (week: number) => number) => {
        const product = await one<{ id: number }>(sql`
          INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
          VALUES (${orgId}, ${uom.id}, ${`Watched ${suffix}`}, ${`DF-${tag}-${suffix}`}, ${userId})
          RETURNING id`);
        const variant = await one<{ id: number }>(sql`
          INSERT INTO inv_product_variants (org_id, product_id, name, sku)
          VALUES (${orgId}, ${product.id}, 'Default', ${`DF-${tag}-${suffix}-V`})
          RETURNING id`);
        await db().execute(sql`
          INSERT INTO inv_stock_levels (org_id, product_variant_id, location_id, on_hand)
          VALUES (${orgId}, ${variant.id}, ${location.id}, '500')`);
        for (let w = 1; w <= 52; w += 1) {
          const qty = weekly(w);
          if (qty <= 0) continue;
          await db().execute(sql`
            INSERT INTO inv_stock_transactions
              (org_id, product_variant_id, location_id, transaction_type,
               quantity_change, quantity_before, quantity_after, posting_date, created_by)
            VALUES (${orgId}, ${variant.id}, ${location.id}, 'SALE',
                    ${-qty}, 1000, ${1000 - qty}, (CURRENT_DATE - (${w} * 7))::date, ${userId})`);
        }
        return variant.id;
      };

      const steady = await sku("STEADY", (w) => 20 + (w % 3));
      // Alternating 4 and 400: whatever the champion is, its average error is
      // roughly the size of an average week, which is the threshold.
      const erratic = await sku("ERRATIC", (w) => (w % 2 === 0 ? 400 : 4));

      const persistence = app.app.get(ForecastPersistenceService);
      const persist = async (variantId: number) => {
        const { version } = await persistence.generate(orgId, userId, {
          productVariantId: variantId,
          warehouseId: warehouse.id,
        });
        return version.id;
      };
      await persist(steady);

      return {
        orgId,
        analystId: userId,
        warehouseId: warehouse.id,
        steadyVariantId: steady,
        erraticVariantId: erratic,
        erraticForecastId: await persist(erratic),
      };
    });

    analystToken = `Bearer ${await signSeededToken(app, seeded.members["analyst"]!.userId, seeded.orgId)}`;
    strangerToken = `Bearer ${await signSeededToken(app, seeded.members["stranger"]!.userId, seeded.orgId)}`;
  }, 300_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  const forecastRowCount = async () => {
    const [row] = await asTenant(() =>
      db().execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM inv_demand_forecasts WHERE org_id = ${scene.orgId}`),
    );
    return Number(row?.count ?? 0);
  };

  interface WatchBody {
    items: Array<{
      forecastId: number;
      productVariantId: number;
      maeRatio: string | null;
      breachesThreshold: boolean;
      storedVersions: number;
      stale: boolean;
      coverage: { periods: number };
    }>;
    total: number;
    threshold: number;
    summary: {
      tracked: number;
      breaching: number;
      coverage: { variantsForecast: number; variantsTotal: number; percent: string };
      proposals: { total: number; accepted: number; acceptedPercent: string };
    };
  }

  it("puts the SKU whose MAE blew the threshold at the top, with a link to its evidence", async () => {
    const response = await request(server())
      .get("/inventory/replenishment/drift?limit=50")
      .set("Authorization", analystToken);
    expect(response.status).toBe(200);
    const body = response.body as WatchBody;

    const erratic = body.items.find((i) => i.productVariantId === scene.erraticVariantId);
    expect(erratic).toBeDefined();
    expect(erratic!.breachesThreshold).toBe(true);
    expect(Number(erratic!.maeRatio)).toBeGreaterThanOrEqual(body.threshold);
    // The evidence link: the stored version it came from, and how many stand
    // behind it. Without these the status is an assertion nobody can check.
    expect(erratic!.forecastId).toBe(scene.erraticForecastId);
    expect(erratic!.storedVersions).toBeGreaterThanOrEqual(1);

    const steady = body.items.find((i) => i.productVariantId === scene.steadyVariantId);
    expect(steady).toBeDefined();
    expect(steady!.breachesThreshold).toBe(false);
  });

  it("filters to the breaching rows when asked", async () => {
    const response = await request(server())
      .get("/inventory/replenishment/drift?breachingOnly=true&limit=50")
      .set("Authorization", analystToken);
    expect(response.status).toBe(200);
    const body = response.body as WatchBody;
    expect(body.items.every((i) => i.breachesThreshold)).toBe(true);
    expect(body.items.some((i) => i.productVariantId === scene.erraticVariantId)).toBe(true);
    expect(body.items.some((i) => i.productVariantId === scene.steadyVariantId)).toBe(false);
  });

  it("honours a threshold the caller tightened", async () => {
    const response = await request(server())
      .get("/inventory/replenishment/drift?maeRatioThreshold=0.01&limit=50")
      .set("Authorization", analystToken);
    expect(response.status).toBe(200);
    const body = response.body as WatchBody;
    expect(body.threshold).toBeCloseTo(0.01, 3);
    expect(body.items.every((i) => i.maeRatio === null || i.breachesThreshold)).toBe(true);
  });

  it("reports coverage and the proposal-acceptance rate beside the rows", async () => {
    // Five healthy SKUs read as a healthy forecast until you notice the
    // catalogue has four hundred.
    const response = await request(server())
      .get("/inventory/replenishment/drift?limit=50")
      .set("Authorization", analystToken);
    const body = response.body as WatchBody;
    expect(body.summary.tracked).toBeGreaterThanOrEqual(2);
    expect(body.summary.breaching).toBeGreaterThanOrEqual(1);
    expect(body.summary.coverage.variantsTotal).toBeGreaterThanOrEqual(2);
    expect(body.summary.coverage.variantsForecast).toBeGreaterThanOrEqual(2);
    expect(body.summary.proposals.acceptedPercent).toMatch(/^\d+\.\d{2}$/);
  });

  it("serves the deep report beside the persisted versions behind it", async () => {
    const response = await request(server())
      .get(`/inventory/replenishment/drift/${scene.erraticVariantId}?warehouseId=${scene.warehouseId}`)
      .set("Authorization", analystToken);
    expect(response.status).toBe(200);
    const body = response.body as {
      report: { status: string; findings: string[] };
      evidence: { totalVersions: number; versions: Array<{ id: number }> };
    };
    expect(typeof body.report.status).toBe("string");
    expect(body.evidence.totalVersions).toBeGreaterThanOrEqual(1);
    expect(body.evidence.versions.some((v) => v.id === scene.erraticForecastId)).toBe(true);
  });

  it("changes no forecast row by being read", async () => {
    // A monitor that regenerates what it monitors destroys the evidence it
    // exists to preserve.
    const before = await forecastRowCount();
    await request(server())
      .get("/inventory/replenishment/drift?limit=50")
      .set("Authorization", analystToken);
    await request(server())
      .get(`/inventory/replenishment/drift/${scene.erraticVariantId}?warehouseId=${scene.warehouseId}`)
      .set("Authorization", analystToken);
    expect(await forecastRowCount()).toBe(before);
  });

  it("refuses the watchlist to somebody without the replenishment read key", async () => {
    const response = await request(server())
      .get("/inventory/replenishment/drift")
      .set("Authorization", strangerToken);
    expect(response.status).toBe(403);
  });

  it("caps the page size at a hundred", async () => {
    const response = await request(server())
      .get("/inventory/replenishment/drift?limit=500")
      .set("Authorization", analystToken);
    expect(response.status).toBe(400);
  });
});
