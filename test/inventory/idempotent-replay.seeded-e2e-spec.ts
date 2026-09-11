import { randomUUID } from "node:crypto";
import request from "supertest";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { InvStockTransfersService } from "src/modules/inventory/stock/inv-stock-transfers.service";
import { InvStockAdjustmentsService } from "src/modules/inventory/stock/inv-stock-adjustments.service";
import { SoCoreService } from "src/modules/inventory/sales-orders/so-core.service";
import { LoadsService } from "src/modules/inventory/shipments/loads.service";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * T04 — a command a client may retry.
 *
 * `runIdempotent` exists so that a client whose request timed out can send it
 * again and be told what happened the first time. It cannot do that from behind
 * a precondition the command's own effect invalidates: the first call flips the
 * status, the retry is refused on the status its own first run set, and the
 * guard that would have replayed the answer is never reached.
 *
 * That defect was fixed in `po-batch` and `quality-recalls` by 6c8f68fc9. A
 * sweep of all 40 `runIdempotent` call sites under `src/modules/inventory` found
 * four more, and three of them carry a doc comment diagnosing this exact failure
 * while leaving the guard outside:
 *
 *   loads.service.ts             — "the dispatch had in fact happened, and the
 *                                   driver had left"
 *   so-lifecycle.service.ts      — "told the order could not be confirmed — when
 *                                   it already had been"
 *   inv-stock-transfers.service  — "told the transfer could not be cancelled —
 *                                   the request had in fact succeeded"
 *   inv-stock-adjustments.service
 *
 * Each test below sends one request twice under one key. The seam is HTTP,
 * because the defect is about what a retrying client is told — a service-level
 * call would prove the arithmetic and nothing about the answer.
 */
interface Scene {
  orgId: string;
  keeperId: string;
  approverId: string;
  variantId: number;
  warehouseId: number;
  locationId: number;
  destWarehouseId: number;
  destLocationId: number;
}

const SEEDED_QTY = 500;

describe(`${SEEDED_HARNESS} a command a client may retry`, () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let keeperToken = "";
  let approverToken = "";
  let teardown: () => Promise<void>;

  const server = () => app.app.getHttpServer();
  const db = () => app.app.get<Db>(DRIZZLE);
  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(db(), scene.orgId, work);

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("keeper", {
        permissionKeys: [
          "inventory:warehouses:scope-all",
          "inventory:stock:read",
          "inventory:stock:adjust",
          "inventory:stock:transfer",
          "inventory:sales-orders:confirm",
          "inventory:loads:manage",
        ],
      })
      // Writing off stock is how theft is concealed, so approval is a second
      // person. The maker-checker rule is not what this spec is testing, but it
      // is what the fixture has to satisfy to reach the replay path at all.
      .addMember("approver", {
        permissionKeys: [
          "inventory:warehouses:scope-all",
          "inventory:stock:read",
          "inventory:adjustments:approve",
        ],
      })
      .build();
    teardown = () => seeded.teardown();

    const tag = randomUUID().slice(0, 6);
    scene = await runInNewTenantTransaction(db(), seeded.orgId, async () => {
      const keeperId = seeded.members["keeper"]!.userId;
      await db().execute(sql`
        INSERT INTO org_modules (org_id, module_key, enabled)
        VALUES (${seeded.orgId}, 'inventory', true) ON CONFLICT DO NOTHING`);
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db().execute<T>(q))[0]!;
      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Retryable goods', ${`RE-${tag}`}, ${keeperId})
        RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`RE-${tag}-V`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Main', ${`MN${tag}`}, ${keeperId}) RETURNING id`);
      const destWarehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Far', ${`FR${tag}`}, ${keeperId}) RETURNING id`);
      const location = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Main bin', ${`MB${tag}`}, 'BIN', true)
        RETURNING id`);
      const destLocation = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable)
        VALUES (${seeded.orgId}, ${destWarehouse.id}, 'Far bin', ${`FB${tag}`}, 'BIN', true)
        RETURNING id`);
      // Every adjustment must stop at PENDING_APPROVAL, so the approve path is reachable.
      await db().execute(sql`
        INSERT INTO inv_settings (org_id, adjustment_approval_threshold)
        VALUES (${seeded.orgId}, '1')
        ON CONFLICT (org_id) DO UPDATE SET adjustment_approval_threshold = '1'`);
      return {
        orgId: seeded.orgId,
        keeperId,
        approverId: seeded.members["approver"]!.userId,
        variantId: variant.id,
        warehouseId: warehouse.id,
        locationId: location.id,
        destWarehouseId: destWarehouse.id,
        destLocationId: destLocation.id,
      };
    });

    keeperToken = `Bearer ${await signSeededToken(app, scene.keeperId, scene.orgId)}`;
    approverToken = `Bearer ${await signSeededToken(app, scene.approverId, scene.orgId)}`;

    await asTenant(() =>
      app.app.get(StockEngineService).execute(scene.orgId, scene.keeperId, {
        idempotencyKey: `retry-seed-${tag}`,
        sourceType: "retry-fixture",
        sourceId: tag,
        movements: [
          {
            transactionType: "PURCHASE",
            productVariantId: scene.variantId,
            locationId: scene.locationId,
            quantityDelta: `${SEEDED_QTY}.0000`,
            unitCost: "3.0000",
          },
        ],
      }),
    );
  }, 300_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  /**
   * Surfaces the response body when a status assertion fails. A bare "expected <300,
   * received 402" says nothing, and the first run of this spec lost time to exactly
   * that: the 402 was MODULE_NOT_ENABLED, a fixture gap, not the defect under test.
   */
  const expectAccepted = (res: { status: number; body: unknown }) => {
    if (res.status >= 300) {
      throw new Error(`expected a 2xx, got ${res.status}: ${JSON.stringify(res.body)}`);
    }
  };

  const statusOf = async (table: string, id: number) => {
    const [row] = await asTenant(() =>
      db().execute<{ status: string }>(
        sql`SELECT status FROM ${sql.raw(table)} WHERE org_id = ${scene.orgId} AND id = ${id}`,
      ),
    );
    return row?.status ?? null;
  };

  it("replays a transfer cancel instead of refusing the retry", async () => {
    const transfer = (await asTenant(() =>
      app.app.get(InvStockTransfersService).createTransfer(
        scene.orgId,
        scene.keeperId,
        {
          fromLocationId: scene.locationId,
          toLocationId: scene.destLocationId,
          fromWarehouseId: scene.warehouseId,
          toWarehouseId: scene.destWarehouseId,
          lines: [{ productVariantId: scene.variantId, quantity: 5 }],
        } as never,
        `mk-transfer-${randomUUID()}`,
      ),
    )) as { id: number };

    const key = `cancel-${randomUUID()}`;
    const send = () =>
      request(server())
        .post(`/inventory/stock/transfers/${transfer.id}/cancel`)
        .set("Authorization", keeperToken)
        .set("Idempotency-Key", key)
        .send({});

    const first = await send();
    expectAccepted(first);
    expect(await statusOf("inv_stock_transfers", transfer.id)).toBe("CANCELLED");

    const second = await send();
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    expect(await statusOf("inv_stock_transfers", transfer.id)).toBe("CANCELLED");
  });

  it("replays a sales-order confirm instead of refusing the retry", async () => {
    const so = (await asTenant(() =>
      app.app.get(SoCoreService).createSo(scene.orgId, scene.keeperId, {
        orderDate: new Date().toISOString().slice(0, 10),
        warehouseId: scene.warehouseId,
        currency: "INR",
        lines: [
          {
            productVariantId: scene.variantId,
            quantity: 3,
            unitPrice: "10.0000",
            taxRate: "0",
            lineOrder: 0,
          },
        ],
      } as never),
    )) as { id: number };

    const key = `confirm-${randomUUID()}`;
    const send = () =>
      request(server())
        .post(`/inventory/sales-orders/${so.id}/confirm`)
        .set("Authorization", keeperToken)
        .set("Idempotency-Key", key)
        .send({});

    const first = await send();
    expectAccepted(first);
    // `autoReserveOnConfirm` runs straight after the confirm, so the terminal status
    // is CONFIRMED or RESERVED. What matters here is that it left DRAFT — and that
    // the retry is answered rather than refused on the status the first call set.
    const afterFirst = await statusOf("inv_sales_orders", so.id);
    expect(["CONFIRMED", "RESERVED"]).toContain(afterFirst);

    const second = await send();
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    expect(await statusOf("inv_sales_orders", so.id)).toBe(afterFirst);
  });

  it("replays an adjustment approval instead of refusing the retry", async () => {
    const adjustment = (await asTenant(() =>
      app.app.get(InvStockAdjustmentsService).createAdjustment(
        scene.orgId,
        scene.keeperId,
        {
          reason: "RECOUNT",
          lines: [
            { productVariantId: scene.variantId, locationId: scene.locationId, quantityChange: 4 },
          ],
        } as never,
        `mk-adj-${randomUUID()}`,
      ),
    )) as { id: number };

    expect(await statusOf("inv_stock_adjustments", adjustment.id)).toBe("PENDING_APPROVAL");

    const key = `approve-${randomUUID()}`;
    const send = () =>
      request(server())
        .post(`/inventory/stock/adjustments/${adjustment.id}/approve`)
        .set("Authorization", approverToken)
        .set("Idempotency-Key", key)
        .send({});

    const first = await send();
    expectAccepted(first);
    expect(await statusOf("inv_stock_adjustments", adjustment.id)).toBe("APPROVED");

    const second = await send();
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    expect(await statusOf("inv_stock_adjustments", adjustment.id)).toBe("APPROVED");
  });

  /**
   * §4 asks what a crash between the claim and the side effect costs. Auto-reserve
   * cannot join the idempotent unit, so a confirm that commits and then dies leaves
   * a CONFIRMED order that was never reserved. Gating the reserve on "was this a
   * replay?" would strand it for ever, silently. Gating it on "is there anything
   * left to do?" lets the retry finish the job — which is what this asserts, by
   * confirming an order and then replaying the key against an order deliberately
   * left at CONFIRMED.
   */
  it("finishes a reserve the first call never got to, on the retry", async () => {
    const so = (await asTenant(() =>
      app.app.get(SoCoreService).createSo(scene.orgId, scene.keeperId, {
        orderDate: new Date().toISOString().slice(0, 10),
        warehouseId: scene.warehouseId,
        currency: "INR",
        lines: [
          { productVariantId: scene.variantId, quantity: 2, unitPrice: "10.0000", taxRate: "0", lineOrder: 0 },
        ],
      } as never),
    )) as { id: number };

    const key = `crash-${randomUUID()}`;
    const send = () =>
      request(server())
        .post(`/inventory/sales-orders/${so.id}/confirm`)
        .set("Authorization", keeperToken)
        .set("Idempotency-Key", key)
        .send({});

    expectAccepted(await send());

    // Stand in for "committed CONFIRMED, then the process died before reserving".
    await asTenant(() =>
      db().execute(sql`
        UPDATE inv_sales_orders SET status = 'CONFIRMED'
        WHERE org_id = ${scene.orgId} AND id = ${so.id}`),
    );

    expectAccepted(await send());
    // The retry replayed the confirm and still did the reserve that was outstanding.
    expect(await statusOf("inv_sales_orders", so.id)).not.toBe("CONFIRMED");
  });

  it("hides another organisation's load rather than refusing it", async () => {
    // §8 — a cross-tenant probe belongs beside the happy path, not in a separate
    // file nobody runs. Absent, never forbidden: a 403 would confirm the id exists.
    const other = await seedOrg(app.seedDb).onPlan("PAID").addMember("stranger", {
      permissionKeys: ["inventory:warehouses:scope-all", "inventory:loads:manage"],
    }).build();
    try {
      const strangerToken = `Bearer ${await signSeededToken(app, 
        other.members["stranger"]!.userId,
        other.orgId,
      )}`;
      await runInNewTenantTransaction(db(), other.orgId, () =>
        db().execute(sql`
          INSERT INTO org_modules (org_id, module_key, enabled)
          VALUES (${other.orgId}, 'inventory', true) ON CONFLICT DO NOTHING`),
      );
      const load = (await asTenant(() =>
        app.app.get(LoadsService).create(scene.orgId, scene.keeperId, {
          sourceWarehouseId: scene.warehouseId,
          destination: "Depot",
          shipmentIds: [],
          transferIds: [],
        } as never),
      )) as { id: number };

      const res = await request(server())
        .post(`/inventory/loads/${load.id}/dispatch`)
        .set("Authorization", strangerToken)
        .set("Idempotency-Key", `xt-${randomUUID()}`)
        .send({});

      expect(res.status).toBe(404);
      expect(await statusOf("inv_loads", load.id)).toBe("DRAFT");
    } finally {
      await other.teardown().catch(() => undefined);
    }
  });

  it("replays a load dispatch instead of refusing the retry", async () => {
    const load = (await asTenant(() =>
      app.app.get(LoadsService).create(scene.orgId, scene.keeperId, {
        sourceWarehouseId: scene.warehouseId,
        destination: "Depot",
        shipmentIds: [],
        transferIds: [],
      } as never),
    )) as { id: number };

    const key = `dispatch-${randomUUID()}`;
    const send = () =>
      request(server())
        .post(`/inventory/loads/${load.id}/dispatch`)
        .set("Authorization", keeperToken)
        .set("Idempotency-Key", key)
        .send({});

    const first = await send();
    expectAccepted(first);
    expect(await statusOf("inv_loads", load.id)).toBe("DISPATCHED");

    const second = await send();
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    expect(await statusOf("inv_loads", load.id)).toBe("DISPATCHED");
  });
});
