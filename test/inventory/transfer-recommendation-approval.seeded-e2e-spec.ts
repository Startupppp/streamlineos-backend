import { randomUUID } from "node:crypto";
import request from "supertest";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * C5 — approving a transfer recommendation, over HTTP, twice.
 *
 * Two warehouses: one selling twenty a week with ten on the shelf, one selling
 * nothing and holding four hundred. The plan should want to move goods from the
 * idle site to the busy one, and approving it should raise exactly one standard
 * transfer — PENDING, unreserved, and the same document on a retry.
 *
 * The three assertions that matter are the three ways this goes wrong: a second
 * approve raising a second transfer, an approve reserving the donor's stock, and
 * a quantity taken from the request body rather than re-derived.
 */
interface Scene {
  orgId: string;
  plannerId: string;
  variantId: number;
  shortWh: number;
  idleWh: number;
  idleLocationId: number;
}

describe(`${SEEDED_HARNESS} approving a transfer recommendation`, () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let plannerToken = "";
  let readerToken = "";
  let teardown: () => Promise<void>;

  const server = () => app.app.getHttpServer();
  const db = () => app.app.get<Db>(DRIZZLE);
  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(db(), scene.orgId, work);

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("planner", {
        permissionKeys: [
          "inventory:warehouses:scope-all",
          "inventory:replenishment:read",
          "inventory:stock:transfer",
        ],
      })
      .addMember("reader", {
        permissionKeys: ["inventory:warehouses:scope-all", "inventory:replenishment:read"],
      })
      .build();
    teardown = () => seeded.teardown();

    await runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), seeded.orgId, async () => {
      await app.app.get<Db>(DRIZZLE).execute(sql`
        INSERT INTO org_modules (org_id, module_key, enabled)
        VALUES (${seeded.orgId}, 'inventory', true) ON CONFLICT DO NOTHING`);
    });

    const tag = randomUUID().slice(0, 6);
    scene = await runInNewTenantTransaction(db(), seeded.orgId, async () => {
      const orgId = seeded.orgId;
      const userId = seeded.members["planner"]!.userId;
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db().execute<T>(q))[0]!;

      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
        VALUES (${orgId}, ${uom.id}, 'Movable goods', ${`TA-${tag}`}, ${userId})
        RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${orgId}, ${product.id}, 'Default', ${`TA-${tag}-V`}) RETURNING id`);

      const site = async (name: string, onHand: number, weeklySales: number) => {
        const wh = await one<{ id: number }>(sql`
          INSERT INTO inv_warehouses (org_id, name, code, created_by)
          VALUES (${orgId}, ${name}, ${`${name.slice(0, 3)}${tag}`}, ${userId})
          RETURNING id`);
        const loc = await one<{ id: number }>(sql`
          INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
          VALUES (${orgId}, ${wh.id}, 'Bin', ${`${name.slice(0, 3)}B${tag}`}, 'BIN')
          RETURNING id`);
        await db().execute(sql`
          INSERT INTO inv_stock_levels (org_id, product_variant_id, location_id, on_hand)
          VALUES (${orgId}, ${variant.id}, ${loc.id}, ${String(onHand)})`);
        for (let w = 1; w <= 12 && weeklySales > 0; w += 1) {
          await db().execute(sql`
            INSERT INTO inv_stock_transactions
              (org_id, product_variant_id, location_id, transaction_type,
               quantity_change, quantity_before, quantity_after, posting_date, created_by)
            VALUES (${orgId}, ${variant.id}, ${loc.id}, 'SALE',
                    ${-weeklySales}, 1000, ${1000 - weeklySales},
                    (CURRENT_DATE - (${w} * 7))::date, ${userId})`);
        }
        return { warehouseId: wh.id, locationId: loc.id };
      };

      const short = await site("Short", 10, 20);
      const idle = await site("Idle", 400, 0);
      return {
        orgId,
        plannerId: userId,
        variantId: variant.id,
        shortWh: short.warehouseId,
        idleWh: idle.warehouseId,
        idleLocationId: idle.locationId,
      };
    });

    plannerToken = `Bearer ${await signSeededToken(app, seeded.members["planner"]!.userId, seeded.orgId)}`;
    readerToken = `Bearer ${await signSeededToken(app, seeded.members["reader"]!.userId, seeded.orgId)}`;
  }, 300_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  const transferCount = async () => {
    const [row] = await asTenant(() =>
      db().execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM inv_stock_transfers
        WHERE org_id = ${scene.orgId} AND from_warehouse_id = ${scene.idleWh}`),
    );
    return Number(row?.count ?? 0);
  };

  it("serves the plan over HTTP to a holder of the read key", async () => {
    const response = await request(server())
      .get(`/inventory/replenishment/transfer-recommendations/${scene.variantId}`)
      .set("Authorization", plannerToken);
    expect(response.status).toBe(200);
    const body = response.body as {
      recommendations: Array<{ fromWarehouseId: number; toWarehouseId: number; quantity: number }>;
    };
    expect(body.recommendations.length).toBeGreaterThan(0);
    expect(body.recommendations[0]!.fromWarehouseId).toBe(scene.idleWh);
    expect(body.recommendations[0]!.toWarehouseId).toBe(scene.shortWh);
  });

  it("refuses the plan to somebody without the read key", async () => {
    const response = await request(server())
      .get(`/inventory/replenishment/transfer-recommendations/${scene.variantId}`)
      .set("Authorization", `Bearer ${await signSeededToken(app, randomUUID(), scene.orgId)}`);
    expect([401, 403]).toContain(response.status);
  });

  it("refuses approval to a reader who may not move stock", async () => {
    // Reading the network and moving goods around it are different authorities.
    const response = await request(server())
      .post("/inventory/replenishment/transfer-recommendations/approve")
      .set("Authorization", readerToken)
      .set("Idempotency-Key", `denied-${randomUUID()}`)
      .send({
        productVariantId: scene.variantId,
        fromWarehouseId: scene.idleWh,
        toWarehouseId: scene.shortWh,
      });
    expect(response.status).toBe(403);
  });

  it("refuses an approval that carries no Idempotency-Key", async () => {
    const response = await request(server())
      .post("/inventory/replenishment/transfer-recommendations/approve")
      .set("Authorization", plannerToken)
      .send({
        productVariantId: scene.variantId,
        fromWarehouseId: scene.idleWh,
        toWarehouseId: scene.shortWh,
      });
    expect(response.status).toBe(400);
  });

  it("rejects a client-sent quantity rather than obeying it", async () => {
    // The server owns the number. `.strict()` refuses the field outright, so a
    // caller cannot believe they set it.
    const response = await request(server())
      .post("/inventory/replenishment/transfer-recommendations/approve")
      .set("Authorization", plannerToken)
      .set("Idempotency-Key", `qty-${randomUUID()}`)
      .send({
        productVariantId: scene.variantId,
        fromWarehouseId: scene.idleWh,
        toWarehouseId: scene.shortWh,
        quantity: 9999,
      });
    expect(response.status).toBe(400);
  });

  it("creates one standard transfer, and a second approve on the same key creates nothing", async () => {
    const before = await transferCount();
    const key = `approve-${randomUUID()}`;
    const body = {
      productVariantId: scene.variantId,
      fromWarehouseId: scene.idleWh,
      toWarehouseId: scene.shortWh,
    };

    const first = await request(server())
      .post("/inventory/replenishment/transfer-recommendations/approve")
      .set("Authorization", plannerToken)
      .set("Idempotency-Key", key)
      .send(body);
    expect(first.status).toBe(201);
    const firstBody = first.body as {
      transferId: number;
      quantity: string;
      status: string;
      created: boolean;
    };
    expect(firstBody.created).toBe(true);
    expect(await transferCount()).toBe(before + 1);

    const second = await request(server())
      .post("/inventory/replenishment/transfer-recommendations/approve")
      .set("Authorization", plannerToken)
      .set("Idempotency-Key", key)
      .send(body);
    expect(second.status).toBe(201);
    const secondBody = second.body as { transferId: number; created: boolean };
    expect(secondBody.transferId).toBe(firstBody.transferId);
    expect(secondBody.created).toBe(false);
    expect(await transferCount()).toBe(before + 1);
  });

  it("leaves the transfer PENDING and reserves nothing", async () => {
    // Approving a plan is a planning decision, not a hold on stock. A plan that
    // committed inventory at every site it touched would be unusable.
    const key = `noreserve-${randomUUID()}`;
    const response = await request(server())
      .post("/inventory/replenishment/transfer-recommendations/approve")
      .set("Authorization", plannerToken)
      .set("Idempotency-Key", key)
      .send({
        productVariantId: scene.variantId,
        fromWarehouseId: scene.idleWh,
        toWarehouseId: scene.shortWh,
      });
    expect(response.status).toBe(201);
    const body = response.body as { transferId: number; status: string };
    expect(body.status).toBe("PENDING");

    const [reservations] = await asTenant(() =>
      db().execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM inv_stock_reservations
        WHERE org_id = ${scene.orgId}
          AND source_type = 'inv_transfer'
          AND source_id = ${String(body.transferId)}`),
    );
    expect(Number(reservations?.count ?? 0)).toBe(0);

    const [committed] = await asTenant(() =>
      db().execute<{ committed: string }>(sql`
        SELECT committed::text AS committed FROM inv_stock_levels
        WHERE org_id = ${scene.orgId} AND location_id = ${scene.idleLocationId}`),
    );
    expect(Number(committed?.committed ?? "0")).toBe(0);
  });

  it("refuses a move between one warehouse and itself", async () => {
    const response = await request(server())
      .post("/inventory/replenishment/transfer-recommendations/approve")
      .set("Authorization", plannerToken)
      .set("Idempotency-Key", `same-${randomUUID()}`)
      .send({
        productVariantId: scene.variantId,
        fromWarehouseId: scene.idleWh,
        toWarehouseId: scene.idleWh,
      });
    expect(response.status).toBe(400);
  });

  it("refuses a move the plan does not recommend", async () => {
    const response = await request(server())
      .post("/inventory/replenishment/transfer-recommendations/approve")
      .set("Authorization", plannerToken)
      .set("Idempotency-Key", `reverse-${randomUUID()}`)
      .send({
        productVariantId: scene.variantId,
        fromWarehouseId: scene.shortWh,
        toWarehouseId: scene.idleWh,
      });
    expect(response.status).toBe(400);
  });
});
