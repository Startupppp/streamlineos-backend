import { randomUUID } from "node:crypto";
import request from "supertest";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { ForecastPersistenceService } from "src/modules/inventory/replenishment/forecast/forecast-persistence.service";
import { InventorySettingsService } from "src/modules/inventory/stock-engine/inventory-settings.service";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * C6 — two SKUs from one supplier make one purchase order.
 *
 * The fixture is three SKUs at one site: two supplied by Acme, one by Globex,
 * each with a year of smooth weekly demand so the safety-stock model applies and
 * a persisted forecast carries a real reorder point. On-hand is left well below
 * that reorder point, so every one of them genuinely needs ordering.
 *
 * The four assertions are the four ways batching goes wrong: one order per SKU
 * instead of per supplier, an order that silently mixes two suppliers, a second
 * order for goods already on an open draft, and a quantity taken from the
 * request body.
 */
interface Scene {
  orgId: string;
  buyerId: string;
  warehouseId: number;
  acmeVendorId: number;
  globexVendorId: number;
  acmeProposalA: number;
  acmeProposalB: number;
  globexProposal: number;
  /** Reserved for the approval test, which must not race the ones that batch. */
  approvalProposal: number;
}

describe(`${SEEDED_HARNESS} purchase-order batching`, () => {
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
        VALUES (${orgId}, 'Main', ${`MN${tag}`}, ${userId}) RETURNING id`);
      const location = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
        VALUES (${orgId}, ${warehouse.id}, 'Bin', ${`MB${tag}`}, 'BIN') RETURNING id`);

      const vendor = async (name: string, code: string, currency: string) =>
        one<{ id: number }>(sql`
          INSERT INTO inv_vendors (org_id, name, code, currency, created_by)
          VALUES (${orgId}, ${name}, ${code}, ${currency}, ${userId}) RETURNING id`);
      const acme = await vendor("Acme Supplies", `AC${tag}`, "INR");
      const globex = await vendor("Globex Trading", `GX${tag}`, "INR");

      /** A SKU with a year of smooth demand and almost nothing on the shelf. */
      const sku = async (suffix: string, vendorId: number, weekly: number) => {
        const product = await one<{ id: number }>(sql`
          INSERT INTO inv_products (org_id, uom_id, name, sku, default_vendor_id, created_by)
          VALUES (${orgId}, ${uom.id}, ${`Stocked ${suffix}`}, ${`PB-${tag}-${suffix}`},
                  ${vendorId}, ${userId})
          RETURNING id`);
        const variant = await one<{ id: number }>(sql`
          INSERT INTO inv_product_variants (org_id, product_id, name, sku)
          VALUES (${orgId}, ${product.id}, 'Default', ${`PB-${tag}-${suffix}-V`})
          RETURNING id`);
        await db().execute(sql`
          INSERT INTO inv_stock_levels (org_id, product_variant_id, location_id, on_hand)
          VALUES (${orgId}, ${variant.id}, ${location.id}, '2')`);
        for (let w = 1; w <= 52; w += 1) {
          // A small deterministic wobble keeps the series smooth rather than
          // perfectly flat, which is what the classifier is looking at.
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

      const acmeA = await sku("A", acme.id, 20);
      const acmeB = await sku("B", acme.id, 15);
      const globexC = await sku("C", globex.id, 25);
      const globexD = await sku("D", globex.id, 30);

      const persistence = app.app.get(ForecastPersistenceService);
      const persist = async (variantId: number) => {
        const { version } = await persistence.generate(orgId, userId, {
          productVariantId: variantId,
          warehouseId: warehouse.id,
        });
        return version.id;
      };

      return {
        orgId,
        buyerId: userId,
        warehouseId: warehouse.id,
        acmeVendorId: acme.id,
        globexVendorId: globex.id,
        acmeProposalA: await persist(acmeA),
        acmeProposalB: await persist(acmeB),
        globexProposal: await persist(globexC),
        approvalProposal: await persist(globexD),
      };
    });

    buyerToken = `Bearer ${await signSeededToken(app, seeded.members["buyer"]!.userId, seeded.orgId)}`;
    readerToken = `Bearer ${await signSeededToken(app, seeded.members["reader"]!.userId, seeded.orgId)}`;
  }, 300_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  const poLines = async (poId: number) =>
    asTenant(() =>
      db().execute<{ product_variant_id: number; quantity: string }>(sql`
        SELECT product_variant_id, quantity::text AS quantity
        FROM inv_po_lines WHERE org_id = ${scene.orgId} AND po_id = ${poId}
        ORDER BY line_order`),
    );

  const draftCount = async () => {
    const [row] = await asTenant(() =>
      db().execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM inv_purchase_orders
        WHERE org_id = ${scene.orgId} AND status = 'DRAFT'`),
    );
    return Number(row?.count ?? 0);
  };

  it("lists the persisted proposals a buyer could order against", async () => {
    const response = await request(server())
      .get(`/inventory/replenishment/po-batches/proposals?warehouseId=${scene.warehouseId}`)
      .set("Authorization", buyerToken);
    expect(response.status).toBe(200);
    const body = response.body as {
      items: Array<{ proposalId: number; vendorId: number | null; suggestedQuantity: string }>;
      total: number;
    };
    expect(body.total).toBeGreaterThanOrEqual(3);
    const acme = body.items.filter((i) => i.vendorId === scene.acmeVendorId);
    expect(acme.length).toBe(2);
    for (const item of acme) expect(Number(item.suggestedQuantity)).toBeGreaterThan(0);
  });

  it("previews two same-supplier proposals as one batch", async () => {
    const response = await request(server())
      .post("/inventory/replenishment/po-batches/preview")
      .set("Authorization", buyerToken)
      .send({ proposalIds: [scene.acmeProposalA, scene.acmeProposalB] });
    expect(response.status).toBe(201);
    const body = response.body as {
      batches: Array<{ vendorId: number; currency: string; lines: unknown[] }>;
    };
    expect(body.batches).toHaveLength(1);
    expect(body.batches[0]!.vendorId).toBe(scene.acmeVendorId);
    expect(body.batches[0]!.lines).toHaveLength(2);
  });

  it("previews a cross-supplier set as two batches rather than one", async () => {
    const response = await request(server())
      .post("/inventory/replenishment/po-batches/preview")
      .set("Authorization", buyerToken)
      .send({ proposalIds: [scene.acmeProposalA, scene.globexProposal] });
    expect(response.status).toBe(201);
    const body = response.body as { batches: Array<{ vendorId: number }> };
    expect(body.batches).toHaveLength(2);
  });

  it("creates ONE draft purchase order for two SKUs from the same supplier", async () => {
    const before = await draftCount();
    const response = await request(server())
      .post("/inventory/replenishment/po-batches")
      .set("Authorization", buyerToken)
      .set("Idempotency-Key", `batch-${randomUUID()}`)
      .send({
        proposalIds: [scene.acmeProposalA, scene.acmeProposalB],
        vendorId: scene.acmeVendorId,
      });
    expect(response.status).toBe(201);
    const body = response.body as { poId: number; lineCount: number; created: boolean };
    expect(body.created).toBe(true);
    expect(body.lineCount).toBe(2);
    expect(await draftCount()).toBe(before + 1);
    expect(await poLines(body.poId)).toHaveLength(2);
  });

  it("refuses a batch spanning two suppliers, naming both", async () => {
    const before = await draftCount();
    const response = await request(server())
      .post("/inventory/replenishment/po-batches")
      .set("Authorization", buyerToken)
      .set("Idempotency-Key", `cross-${randomUUID()}`)
      .send({
        proposalIds: [scene.acmeProposalA, scene.globexProposal],
        vendorId: scene.acmeVendorId,
      });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toMatch(/Globex Trading/);
    expect(await draftCount()).toBe(before);
  });

  it("refuses to batch a proposal already sitting on an open draft order", async () => {
    // The Acme pair is already on the draft raised above.
    const before = await draftCount();
    const response = await request(server())
      .post("/inventory/replenishment/po-batches")
      .set("Authorization", buyerToken)
      .set("Idempotency-Key", `dupe-${randomUUID()}`)
      .send({
        proposalIds: [scene.acmeProposalA, scene.acmeProposalB],
        vendorId: scene.acmeVendorId,
      });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toMatch(/draft purchase order/);
    expect(await draftCount()).toBe(before);
  });

  it("replays the same draft order on a repeated Idempotency-Key", async () => {
    const key = `idem-${randomUUID()}`;
    const send = () =>
      request(server())
        .post("/inventory/replenishment/po-batches")
        .set("Authorization", buyerToken)
        .set("Idempotency-Key", key)
        .send({ proposalIds: [scene.globexProposal], vendorId: scene.globexVendorId });

    const before = await draftCount();
    const first = await send();
    expect(first.status).toBe(201);
    const firstBody = first.body as { poId: number; created: boolean };
    expect(firstBody.created).toBe(true);
    expect(await draftCount()).toBe(before + 1);

    const second = await send();
    expect(second.status).toBe(201);
    const secondBody = second.body as { poId: number; created: boolean };
    expect(secondBody.poId).toBe(firstBody.poId);
    expect(secondBody.created).toBe(false);
    expect(await draftCount()).toBe(before + 1);
  });

  it("rejects a client-sent quantity instead of ordering it", async () => {
    const response = await request(server())
      .post("/inventory/replenishment/po-batches")
      .set("Authorization", buyerToken)
      .set("Idempotency-Key", `qty-${randomUUID()}`)
      .send({
        proposalIds: [scene.acmeProposalA],
        vendorId: scene.acmeVendorId,
        quantity: 9999,
      });
    expect(response.status).toBe(400);
  });

  it("refuses creation to a reader who may not raise purchase orders", async () => {
    const response = await request(server())
      .post("/inventory/replenishment/po-batches")
      .set("Authorization", readerToken)
      .set("Idempotency-Key", `denied-${randomUUID()}`)
      .send({ proposalIds: [scene.acmeProposalA], vendorId: scene.acmeVendorId });
    expect(response.status).toBe(403);
  });

  it("says a draft needs approval when the organisation requires one", async () => {
    // Through the service rather than the table: the settings row is cached, and
    // a direct UPDATE would leave the cache holding the old answer.
    await asTenant(() =>
      app.app
        .get(InventorySettingsService)
        .update(scene.orgId, { requirePoApproval: true }, scene.buyerId),
    );
    const response = await request(server())
      .post("/inventory/replenishment/po-batches/preview")
      .set("Authorization", buyerToken)
      // Its own proposal. `globexProposal` is batched into a draft by the
      // idempotency test above, so previewing it here returned `skipped` and an
      // empty `batches` — and `requiresApproval` on the envelope is the org
      // setting, which is true either way, so only the per-batch assertion saw it.
      .send({ proposalIds: [scene.approvalProposal] });
    expect(response.status).toBe(201);
    const body = response.body as {
      requiresApproval: boolean;
      batches: Array<{ requiresApproval: boolean; approvalReason?: string }>;
    };
    expect(body.requiresApproval).toBe(true);
    expect(body.batches[0]?.requiresApproval).toBe(true);
  });

  it("answers 404 for a proposal belonging to nobody, never 403", async () => {
    const response = await request(server())
      .post("/inventory/replenishment/po-batches/preview")
      .set("Authorization", buyerToken)
      .send({ proposalIds: [2_000_000_000] });
    expect(response.status).toBe(404);
  });
});
