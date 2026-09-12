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
 * C2 — the server owns the quantity, and a person overruling it says so.
 *
 * The screen used to compute a reorder quantity from a min/max rule in the
 * browser and post it, so the number on a purchase order came from the client.
 * C1 persisted the forecast and C6 made the batch quantity the server's; this
 * spec asserts the last two claims C2 adds on top of them.
 *
 * **A tampered payload cannot change the order.** The create schema has no
 * quantity field at all, and the line quantity equals what the preview said the
 * server would order — so there is nothing to tamper with, and the assertion is
 * that the two agree rather than that a smuggled number was clamped.
 *
 * **An override is a distinct, recorded act.** A buyer who knows something the
 * ledger does not may order a different quantity, but only by naming the
 * proposal, stating a reason, and having both written to
 * `inv_proposal_overrides` beside the order in the same transaction. The
 * engine's own number survives on the row, so "what would we have bought" stays
 * answerable after the fact.
 *
 * The fixture is one SKU at one site with a year of smooth weekly demand, almost
 * nothing on the shelf, and a supplier who ships in cases of 12 — so the order
 * policy has something to do to both the engine's number and the person's.
 */
interface Scene {
  orgId: string;
  buyerId: string;
  warehouseId: number;
  vendorId: number;
  variantId: number;
  proposalId: number;
  secondVariantId: number;
  secondProposalId: number;
}

describe(`${SEEDED_HARNESS} replenishment proposal overrides`, () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let buyerToken = "";
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
      .addMember("buyer", {
        permissionKeys: [
          "inventory:warehouses:scope-all",
          "inventory:replenishment:read",
          "inventory:replenishment:manage",
          "inventory:purchase-orders:create",
        ],
      })
      .addMember("reader", {
        permissionKeys: ["inventory:warehouses:scope-all", "inventory:replenishment:read"],
      })
      .build();
    teardown = () => seeded.teardown();

    const tag = randomUUID().slice(0, 6);
    scene = await runInNewTenantTransaction(db(), seeded.orgId, async () => {
      const orgId = seeded.orgId;
      const userId = seeded.members["buyer"]!.userId;
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
        VALUES (${orgId}, 'Main', ${`OV${tag}`}, ${userId}) RETURNING id`);
      const location = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
        VALUES (${orgId}, ${warehouse.id}, 'Bin', ${`OB${tag}`}, 'BIN') RETURNING id`);
      const vendor = await one<{ id: number }>(sql`
        INSERT INTO inv_vendors (org_id, name, code, currency, created_by)
        VALUES (${orgId}, 'Acme Supplies', ${`OA${tag}`}, 'INR', ${userId}) RETURNING id`);

      /** A SKU with a year of smooth demand, a case size, and an empty shelf. */
      const sku = async (suffix: string, weekly: number) => {
        const product = await one<{ id: number }>(sql`
          INSERT INTO inv_products
            (org_id, uom_id, name, sku, default_vendor_id, order_multiple, created_by)
          VALUES (${orgId}, ${uom.id}, ${`Overridable ${suffix}`}, ${`OV-${tag}-${suffix}`},
                  ${vendor.id}, 12, ${userId})
          RETURNING id`);
        const variant = await one<{ id: number }>(sql`
          INSERT INTO inv_product_variants (org_id, product_id, name, sku)
          VALUES (${orgId}, ${product.id}, 'Default', ${`OV-${tag}-${suffix}-V`})
          RETURNING id`);
        await db().execute(sql`
          INSERT INTO inv_stock_levels (org_id, product_variant_id, location_id, on_hand)
          VALUES (${orgId}, ${variant.id}, ${location.id}, '2')`);
        for (let w = 1; w <= 52; w += 1) {
          const qty = weekly + (w % 3);
          await db().execute(sql`
            INSERT INTO inv_stock_transactions
              (org_id, product_variant_id, location_id, transaction_type,
               quantity_change, quantity_before, quantity_after, posting_date, created_by)
            VALUES (${orgId}, ${variant.id}, ${location.id}, 'SALE',
                    ${-qty}, 1000, ${1000 - qty}, (CURRENT_DATE - (${w} * 7))::date, ${userId})`);
        }
        return variant.id;
      };

      const variantId = await sku("A", 20);
      const secondVariantId = await sku("B", 18);

      const persistence = app.app.get(ForecastPersistenceService);
      const persist = async (id: number) =>
        (
          await persistence.generate(orgId, userId, {
            productVariantId: id,
            warehouseId: warehouse.id,
          })
        ).version.id;

      return {
        orgId,
        buyerId: userId,
        warehouseId: warehouse.id,
        vendorId: vendor.id,
        variantId,
        proposalId: await persist(variantId),
        secondVariantId,
        secondProposalId: await persist(secondVariantId),
      };
    });

    buyerToken = `Bearer ${await signSeededToken(app, seeded.members["buyer"]!.userId, seeded.orgId)}`;
    readerToken = `Bearer ${await signSeededToken(app, seeded.members["reader"]!.userId, seeded.orgId)}`;
  }, 300_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  const lineQty = async (poId: number) => {
    const [row] = await asTenant(() =>
      db().execute<{ quantity: string }>(sql`
        SELECT quantity::text AS quantity FROM inv_po_lines
        WHERE org_id = ${scene.orgId} AND po_id = ${poId}
        ORDER BY line_order LIMIT 1`),
    );
    return row!.quantity;
  };

  const overrideRows = async (forecastId: number) =>
    asTenant(() =>
      db().execute<{
        engine_qty: string;
        requested_qty: string;
        ordered_qty: string;
        reason: string;
        po_id: number;
        created_by: string;
      }>(sql`
        SELECT engine_qty::text, requested_qty::text, ordered_qty::text, reason, po_id, created_by
        FROM inv_proposal_overrides
        WHERE org_id = ${scene.orgId} AND forecast_id = ${forecastId}
        ORDER BY id`),
    );

  const overrideCount = async () => {
    const [row] = await asTenant(() =>
      db().execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM inv_proposal_overrides
        WHERE org_id = ${scene.orgId}`),
    );
    return Number(row?.count ?? 0);
  };

  const preview = (body: Record<string, unknown>) =>
    request(server())
      .post("/inventory/replenishment/po-batches/preview")
      .set("Authorization", buyerToken)
      .send(body);

  const create = (body: Record<string, unknown>, token = buyerToken) =>
    request(server())
      .post("/inventory/replenishment/po-batches")
      .set("Authorization", token)
      .set("Idempotency-Key", `ovr-${randomUUID()}`)
      .send(body);

  it("records a proposal for every SKU with recent demand, and only once", async () => {
    // The entry point C2 added. `beforeAll` already persisted both variants
    // through the same service, so a sweep over unchanged data must land on the
    // rows that exist rather than appending a second history — which is what
    // makes this a record of forecasts rather than a log of refreshes.
    const response = await request(server())
      .post("/inventory/forecasting/versions/refresh")
      .set("Authorization", buyerToken)
      .send({ warehouseId: scene.warehouseId, limit: 50 });
    expect(response.status).toBe(201);
    const body = response.body as {
      scanned: number;
      recorded: number;
      unchanged: number;
      failed: unknown[];
    };
    expect(body.scanned).toBeGreaterThanOrEqual(2);
    expect(body.unchanged).toBeGreaterThanOrEqual(2);
    expect(body.recorded).toBe(0);
    expect(body.failed).toHaveLength(0);
  });

  it("refuses the sweep to a reader who may not record forecasts", async () => {
    const response = await request(server())
      .post("/inventory/forecasting/versions/refresh")
      .set("Authorization", readerToken)
      .send({ warehouseId: scene.warehouseId });
    expect(response.status).toBe(403);
  });

  it("labels an untouched line as the engine's own number", async () => {
    const response = await preview({ proposalIds: [scene.proposalId] });
    expect(response.status).toBe(201);
    const body = response.body as {
      batches: Array<{
        lines: Array<{ ordered: string; engineOrdered: string; override: unknown }>;
      }>;
    };
    const line = body.batches[0]!.lines[0]!;
    expect(line.override).toBeNull();
    expect(line.engineOrdered).toBe(line.ordered);
    // The supplier ships in cases of twelve, so the engine's own number is one.
    expect(Number(line.ordered) % 12).toBe(0);
  });

  it("orders exactly what the preview said the server would order", async () => {
    // There is no client quantity to tamper with — the schema has no field for
    // one — so the claim under test is that the number on the line is the
    // server's own, arrived at twice independently.
    const previewed = await preview({ proposalIds: [scene.proposalId] });
    const expected = (
      previewed.body as { batches: Array<{ lines: Array<{ ordered: string }> }> }
    ).batches[0]!.lines[0]!.ordered;

    const response = await create({
      proposalIds: [scene.proposalId],
      vendorId: scene.vendorId,
    });
    expect(response.status).toBe(201);
    const poId = (response.body as { poId: number }).poId;
    expect(await lineQty(poId)).toBe(expected);
    expect(await overrideCount()).toBe(0);
  });

  it("refuses a quantity smuggled onto the create body", async () => {
    const before = await overrideCount();
    const response = await create({
      proposalIds: [scene.secondProposalId],
      vendorId: scene.vendorId,
      quantity: 9999,
      suggestedQty: 9999,
    });
    expect(response.status).toBe(400);
    expect(await overrideCount()).toBe(before);
  });

  it("shows an override beside the engine's number rather than instead of it", async () => {
    const response = await preview({
      proposalIds: [scene.secondProposalId],
      overrides: [
        {
          proposalId: scene.secondProposalId,
          quantity: "500",
          reason: "Trade show in Pune next month; the ledger has not seen it yet.",
        },
      ],
    });
    expect(response.status).toBe(201);
    const line = (
      response.body as {
        batches: Array<{
          lines: Array<{
            ordered: string;
            engineOrdered: string;
            reasons: string[];
            override: { requested: string; reason: string } | null;
          }>;
        }>;
      }
    ).batches[0]!.lines[0]!;

    expect(line.override).not.toBeNull();
    expect(line.override!.requested).toBe("500");
    expect(line.override!.reason).toMatch(/Trade show/);
    // The engine's number is still there, and it is not the person's.
    expect(Number(line.engineOrdered)).toBeGreaterThan(0);
    expect(line.engineOrdered).not.toBe(line.ordered);
    expect(line.reasons[0]).toMatch(/Overridden by a person/);
    // The person overruled the quantity, not the case size: 500 is not a
    // multiple of 12, so the supplier's pack size still applies to their number.
    expect(line.ordered).toBe("504.0000");
  });

  it("records the override beside the order, with both numbers and the reason", async () => {
    const reason = "Supplier closes for a fortnight from the 12th; buying the gap up front.";
    const response = await create({
      proposalIds: [scene.secondProposalId],
      vendorId: scene.vendorId,
      overrides: [{ proposalId: scene.secondProposalId, quantity: "500", reason }],
    });
    expect(response.status).toBe(201);
    const poId = (response.body as { poId: number }).poId;

    expect(await lineQty(poId)).toBe("504.0000");

    const rows = await overrideRows(scene.secondProposalId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.po_id).toBe(poId);
    expect(row.reason).toBe(reason);
    expect(row.requested_qty).toBe("500.0000");
    expect(row.ordered_qty).toBe("504.0000");
    // What the engine would have bought is still on the record, so "what would
    // we have ordered" stays answerable after the fact.
    expect(Number(row.engine_qty)).toBeGreaterThan(0);
    expect(row.engine_qty).not.toBe(row.ordered_qty);
    expect(row.created_by).toBe(scene.buyerId);
  });

  it("refuses an override with no usable reason, and writes nothing", async () => {
    const before = await overrideCount();
    for (const reason of ["", "   ", "n/a"]) {
      const response = await create({
        proposalIds: [scene.proposalId],
        vendorId: scene.vendorId,
        overrides: [{ proposalId: scene.proposalId, quantity: "500", reason }],
      });
      expect(response.status).toBe(400);
    }
    expect(await overrideCount()).toBe(before);
  });

  it("refuses an override naming a proposal that is not in the batch", async () => {
    const before = await overrideCount();
    const response = await create({
      proposalIds: [scene.proposalId],
      vendorId: scene.vendorId,
      overrides: [
        {
          proposalId: scene.secondProposalId,
          quantity: "500",
          reason: "Trade show in Pune next month; the ledger has not seen it yet.",
        },
      ],
    });
    expect(response.status).toBe(400);
    expect(await overrideCount()).toBe(before);
  });

  it("refuses a float quantity on an override", async () => {
    // A `numeric(18,4)` order quantity that has been through a float is no
    // longer the quantity; the schema takes the exact decimal string only.
    const response = await create({
      proposalIds: [scene.proposalId],
      vendorId: scene.vendorId,
      overrides: [
        {
          proposalId: scene.proposalId,
          quantity: 500,
          reason: "Trade show in Pune next month; the ledger has not seen it yet.",
        },
      ],
    });
    expect(response.status).toBe(400);
  });

  it("refuses an override to a reader who may not raise purchase orders", async () => {
    const before = await overrideCount();
    const response = await create(
      {
        proposalIds: [scene.proposalId],
        vendorId: scene.vendorId,
        overrides: [
          {
            proposalId: scene.proposalId,
            quantity: "500",
            reason: "Trade show in Pune next month; the ledger has not seen it yet.",
          },
        ],
      },
      readerToken,
    );
    expect(response.status).toBe(403);
    expect(await overrideCount()).toBe(before);
  });
});
