import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { LeadTimeService } from "src/modules/inventory/replenishment/forecast/lead-time.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * INV-304 — lead time and fill rate, measured rather than configured.
 *
 * A vendor record's lead time is a promise. The receipts are the evidence, and
 * planning against the promise is how a warehouse finds out its supplier runs
 * three days late only when it stocks out.
 */
interface Scene {
  orgId: string;
  userId: string;
  vendorId: number;
  quietVendorId: number;
  variantId: number;
}

describe("[seeded-e2e] lead time and fill rate", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const svc = () => app.app.get(LeadTimeService);
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
        VALUES (${seeded.orgId}, ${uom.id}, 'Sourced goods', ${`LT-${tag}`}, ${userId})
        RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`LT-${tag}-V`}) RETURNING id`);
      const vendor = await one<{ id: number }>(sql`
        INSERT INTO inv_vendors (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Slow supplier', ${`VS${tag}`}, ${userId}) RETURNING id`);
      const quietVendor = await one<{ id: number }>(sql`
        INSERT INTO inv_vendors (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Untried supplier', ${`VQ${tag}`}, ${userId}) RETURNING id`);

      // Receipts at 5, 6, 7, 8 and 30 days. The mean is dragged by the 30; the
      // p90 is what a planner has to live with.
      for (const [i, days] of [5, 6, 7, 8, 30].entries()) {
        const po = await one<{ id: number }>(sql`
          INSERT INTO inv_purchase_orders
            (org_id, vendor_id, po_number, order_date, status, created_by)
          VALUES (${seeded.orgId}, ${vendor.id}, ${`PO-${tag}-${i}`},
                  '2026-06-01'::date, 'RECEIVED', ${userId})
          RETURNING id`);
        // The interval cast is deliberate: `date + $n` with an untyped
        // parameter is ambiguous to Postgres and fails at bind time.
        await db.execute(sql`
          INSERT INTO inv_grns
            (org_id, grn_number, po_id, received_date, created_by)
          VALUES (${seeded.orgId}, ${`GRN-${tag}-${i}`}, ${po.id},
                  '2026-06-01'::date + (${days} || ' days')::interval, ${userId})`);
      }

      return {
        orgId: seeded.orgId,
        userId,
        vendorId: vendor.id,
        quietVendorId: quietVendor.id,
        variantId: variant.id,
      };
    });
  }, 240_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  it("measures a vendor's lead time from its receipts", async () => {
    const estimate = await asTenant(() => svc().vendorLeadTime(scene.orgId, scene.vendorId));
    expect(estimate.observations).toBe(5);
    expect(estimate.reliable).toBe(true);
    expect(estimate.meanDays).toBeCloseTo(11.2, 1);
  });

  it("reports p90 as well as the mean, because the mean is met half the time", () => {
    // Stated as its own probe because it is the number a planner should use and
    // the one most systems omit.
    return asTenant(() => svc().vendorLeadTime(scene.orgId, scene.vendorId)).then(
      (estimate) => {
        expect(estimate.p50Days).toBe(7);
        expect(estimate.p90Days).toBe(30);
        expect(estimate.p90Days).toBeGreaterThan(estimate.meanDays);
      },
    );
  });

  it("says plainly when a vendor has never delivered", async () => {
    // Silence here would be read as "zero days", which is the most dangerous
    // possible default for a lead time.
    const estimate = await asTenant(() =>
      svc().vendorLeadTime(scene.orgId, scene.quietVendorId),
    );
    expect(estimate.observations).toBe(0);
    expect(estimate.reliable).toBe(false);
    expect(estimate.note).toMatch(/configured assumption, not a measurement/);
  });

  it("reports no fill rate for a window with no demand", async () => {
    const fill = await asTenant(() =>
      svc().fillRate(scene.orgId, scene.variantId, { from: "2026-01-01", to: "2026-01-31" }),
    );
    expect(fill.linesRequested).toBe(0);
    expect(fill.lineFillRate).toBe(0);
    expect(fill.note).toMatch(/no fill rate to report/);
  });
});
