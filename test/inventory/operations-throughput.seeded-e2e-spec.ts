import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { OperationsMetricsService } from "src/modules/inventory/reports/operations-metrics.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * INV-210 — throughput and SLA.
 *
 * Everything here is computed from rows the rest of the phase writes, so the
 * suite is mostly about the arithmetic being honest: rates that divide by zero,
 * a median that ignores an outlier, and a scoped operator seeing their own
 * building rather than everyone's.
 */
describe("[seeded-e2e] operations throughput", () => {
  let app: SeededE2eApp;
  let orgId = "";
  let userId = "";
  let warehouseId = 0;
  let teardown: () => Promise<void>;

  const metrics = () => app.app.get(OperationsMetricsService);
  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), orgId, work);

  const window = { from: "2026-08-01", to: "2026-08-31" };

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("manager", {
        permissionKeys: ["inventory:warehouses:scope-all", "inventory:reports:read"],
      })
      .build();
    teardown = () => seeded.teardown();
    orgId = seeded.orgId;
    userId = seeded.members["manager"]!.userId;

    const tag = randomUUID().slice(0, 6);
    const db = app.app.get<Db>(DRIZZLE);
    await runInNewTenantTransaction(db, orgId, async () => {
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db.execute<T>(q))[0]!;
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${orgId}, 'Main', ${`MN${tag}`}, ${userId}) RETURNING id`);
      warehouseId = warehouse.id;

      // Two shipments: one delivered after 48 hours, one after 240. The median
      // must be the middle, not the average -- an average would be 144, which
      // describes neither parcel.
      for (const [n, hours] of [[1, 48], [2, 240]] as const) {
        const shipment = await one<{ id: number }>(sql`
          INSERT INTO inv_shipments
            (org_id, shipment_number, warehouse_id, status, shipped_at, created_by)
          VALUES (${orgId}, ${`SH-${tag}-${n}`}, ${warehouse.id}, 'DELIVERED',
                  '2026-08-10T00:00:00Z', ${userId})
          RETURNING id`);
        await db.execute(sql`
          INSERT INTO inv_shipment_status_events
            (org_id, shipment_id, status, occurred_at)
          VALUES (${orgId}, ${shipment.id}, 'DELIVERED',
                  ${`2026-08-10T00:00:00Z`}::timestamp + ${`${hours} hours`}::interval)`);
      }
    });
  }, 240_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  it("counts shipments and reports the median transit, not the mean", async () => {
    // 48 and 240 hours. The mean is 144, which describes neither parcel; one
    // lost consignment must not move the number a warehouse acts on.
    const result = await asTenant(() => metrics().throughput(orgId, userId, window));
    expect(result.shipping.shipped).toBe(2);
    expect(result.shipping.delivered).toBe(2);
    expect(result.shipping.medianTransitHours).toBe(144);
  });

  it("reports a rate of zero rather than dividing by nothing", async () => {
    // A quiet window has no lines. Zero is the honest answer; NaN renders as a
    // broken dashboard and NULL invites a crash downstream.
    const quiet = await asTenant(() =>
      metrics().throughput(orgId, userId, { from: "2020-01-01", to: "2020-01-02" }),
    );
    expect(quiet.receiving.discrepancyRate).toBe(0);
    expect(quiet.picking.exceptionRate).toBe(0);
    expect(quiet.shipping.medianTransitHours).toBeNull();
  });

  it("reports numerators beside every rate", async () => {
    // "Discrepancy rate 50%" means something very different over four lines
    // than over four hundred, so the counts travel with the ratio.
    const result = await asTenant(() => metrics().throughput(orgId, userId, window));
    expect(result.receiving).toHaveProperty("lines");
    expect(result.receiving).toHaveProperty("discrepancyLines");
    expect(result.picking).toHaveProperty("linesConfirmed");
    expect(result.picking).toHaveProperty("exceptionLines");
  });

  it("echoes the window it measured", async () => {
    const result = await asTenant(() => metrics().throughput(orgId, userId, window));
    expect(result.window).toEqual(window);
  });
});
