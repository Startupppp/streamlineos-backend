import { randomUUID } from "node:crypto";
import request from "supertest";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import type { StockMovement } from "src/modules/inventory/stock-engine/stock-engine.types";
import type { GenealogyResult } from "src/modules/inventory/traceability/genealogy.types";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * D1 — the lot genealogy graph, and the caps that make it safe to ask for.
 *
 * The history below is the one the ticket names: a receipt puts two lots on the
 * dock, one of them is transferred twice and shipped, and the shipment is then
 * reversed. Every movement goes through the real `StockEngineService`, because a
 * ledger built by INSERT can hold a state the engine would never produce and
 * then a traversal test proves nothing about the traversal.
 *
 * The half these assertions exist for is the second one. A graph that answers
 * "complete" when a cap stopped it is worse than no graph at all: an operator
 * running a recall reads the absence of a customer as the goods not having
 * reached one.
 */
const SCOPE_ALL = "inventory:warehouses:scope-all";
const READER = ["inventory:stock:read", "inventory:export", SCOPE_ALL];

interface Scene {
  orgId: string;
  userId: string;
  variantId: number;
  warehouseId: number;
  dockBin: number;
  mainBin: number;
  shipBin: number;
  lotA: number;
  lotB: number;
  grnId: number;
  grnNumber: string;
  transferOneId: number;
  salesOrderId: number;
  shipmentTransactionId: number;
}

describe(`${SEEDED_HARNESS} lot genealogy graph`, () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let otherOrgLotId = 0;
  let scopedUserId = "";
  let unassignedUserId = "";
  const teardowns: Array<() => Promise<void>> = [];
  let tag = "";

  const server = () => app.app.getHttpServer();
  const engine = () => app.app.get(StockEngineService);
  const db = () => app.app.get<Db>(DRIZZLE);
  const asTenant = <T>(orgId: string, work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(db(), orgId, work);
  const auth = async (userId: string, orgId: string) =>
    `Bearer ${await signSeededToken(userId, orgId)}`;

  const graph = async (
    query: string,
    userId = scene.userId,
    orgId = scene.orgId,
  ): Promise<{ status: number; body: GenealogyResult }> => {
    const response = await request(server())
      .get(`/inventory/traceability/genealogy?${query}`)
      .set("Authorization", await auth(userId, orgId));
    return { status: response.status, body: response.body as GenealogyResult };
  };

  async function enableInventory(target: string) {
    await asTenant(target, async () => {
      await db().execute(sql`
        INSERT INTO org_modules (org_id, module_key, enabled)
        VALUES (${target}, 'inventory', true) ON CONFLICT DO NOTHING`);
    });
  }

  async function seedCatalogue(orgId: string, userId: string, label: string) {
    return asTenant(orgId, async () => {
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db().execute<T>(q))[0]!;
      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${orgId}, ${`Each ${label}`}, ${`E${label}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
        VALUES (${orgId}, ${uom.id}, 'Traced goods', ${`GEN-${label}`}, ${userId}) RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${orgId}, ${product.id}, 'Default', ${`GEN-${label}-V`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${orgId}, 'Main', ${`GW${label}`}, ${userId}) RETURNING id`);
      const bin = async (name: string) =>
        one<{ id: number }>(sql`
          INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable)
          VALUES (${orgId}, ${warehouse.id}, ${name}, ${`${name}-${label}`}, 'BIN', true)
          RETURNING id`);
      const lot = async (number: string) =>
        one<{ id: number }>(sql`
          INSERT INTO inv_lots (org_id, product_variant_id, lot_number)
          VALUES (${orgId}, ${variant.id}, ${number}) RETURNING id`);
      return {
        variantId: variant.id,
        warehouseId: warehouse.id,
        dockBin: (await bin("DOCK")).id,
        mainBin: (await bin("MAIN")).id,
        shipBin: (await bin("SHIP")).id,
        lotA: (await lot(`LOT-A-${label}`)).id,
        lotB: (await lot(`LOT-B-${label}`)).id,
      };
    });
  }

  /** A real receipt document, so the graph's document label is a GRN number. */
  async function seedReceiptDocument(orgId: string, userId: string, label: string) {
    return asTenant(orgId, async () => {
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db().execute<T>(q))[0]!;
      const vendor = await one<{ id: number }>(sql`
        INSERT INTO inv_vendors (org_id, name, code, created_by)
        VALUES (${orgId}, 'Trace Supplies', ${`V${label}`}, ${userId}) RETURNING id`);
      const po = await one<{ id: number }>(sql`
        INSERT INTO inv_purchase_orders (org_id, vendor_id, po_number, order_date, created_by)
        VALUES (${orgId}, ${vendor.id}, ${`PO-${label}`}, CURRENT_DATE, ${userId}) RETURNING id`);
      const grnNumber = `GRN-${label}`;
      const grn = await one<{ id: number }>(sql`
        INSERT INTO inv_grns (org_id, po_id, grn_number, received_date, status, created_by)
        VALUES (${orgId}, ${po.id}, ${grnNumber}, CURRENT_DATE, 'POSTED', ${userId}) RETURNING id`);
      return { grnId: grn.id, grnNumber };
    });
  }

  beforeAll(async () => {
    app = await createSeededE2eApp();
    tag = randomUUID().slice(0, 6).toUpperCase();

    const fixture = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("tracer", { permissionKeys: READER })
      .addMember("scoped", { permissionKeys: ["inventory:stock:read"] })
      .addMember("unassigned", { permissionKeys: ["inventory:stock:read"] })
      .build();
    teardowns.push(() => fixture.teardown());
    const orgId = fixture.orgId;
    const userId = fixture.members["tracer"]!.userId;
    scopedUserId = fixture.members["scoped"]!.userId;
    unassignedUserId = fixture.members["unassigned"]!.userId;
    await enableInventory(orgId);

    const catalogue = await seedCatalogue(orgId, userId, tag);
    const receipt = await seedReceiptDocument(orgId, userId, tag);
    await asTenant(orgId, async () => {
      await db().execute(sql`
        INSERT INTO inv_user_warehouses (org_id, user_id, warehouse_id, granted_by)
        VALUES (${orgId}, ${scopedUserId}, ${catalogue.warehouseId}, ${userId})
        ON CONFLICT DO NOTHING`);
      await db().execute(sql`
        INSERT INTO inv_serial_numbers (org_id, product_variant_id, serial_number, lot_id, current_location_id)
        VALUES (${orgId}, ${catalogue.variantId}, ${`SER-${tag}`}, ${catalogue.lotA}, ${catalogue.dockBin})`);
    });

    const post = (key: string, sourceType: string, sourceId: string, movements: StockMovement[]) =>
      asTenant(orgId, () =>
        engine().execute(orgId, userId, {
          idempotencyKey: `${key}-${tag}`,
          sourceType,
          sourceId,
          movements,
        }),
      );

    const grnRef = String(receipt.grnId);
    await post("gen-recv-a", "inv_grn", grnRef, [
      {
        transactionType: "GRN",
        productVariantId: catalogue.variantId,
        locationId: catalogue.dockBin,
        lotId: catalogue.lotA,
        quantityDelta: "100.0000",
        unitCost: "5.0000",
      },
    ]);
    // The same receipt brought a second lot in. That co-participation is the
    // edge a recall walks, and the reason an uncapped traversal fans out.
    await post("gen-recv-b", "inv_grn", grnRef, [
      {
        transactionType: "GRN",
        productVariantId: catalogue.variantId,
        locationId: catalogue.dockBin,
        lotId: catalogue.lotB,
        quantityDelta: "40.0000",
        unitCost: "5.0000",
      },
    ]);

    const transferOneId = 90_001;
    await post("gen-xfer-1", "inv_transfer", String(transferOneId), [
      {
        transactionType: "TRANSFER_OUT",
        productVariantId: catalogue.variantId,
        locationId: catalogue.dockBin,
        lotId: catalogue.lotA,
        quantityDelta: "-60.0000",
      },
      {
        transactionType: "TRANSFER_IN",
        productVariantId: catalogue.variantId,
        locationId: catalogue.mainBin,
        lotId: catalogue.lotA,
        quantityDelta: "60.0000",
        costFromMovementIndex: 0,
      },
    ]);
    // The split: part of what arrived at MAIN goes on to the pick face.
    await post("gen-xfer-2", "inv_transfer", "90002", [
      {
        transactionType: "TRANSFER_OUT",
        productVariantId: catalogue.variantId,
        locationId: catalogue.mainBin,
        lotId: catalogue.lotA,
        quantityDelta: "-20.0000",
      },
      {
        transactionType: "TRANSFER_IN",
        productVariantId: catalogue.variantId,
        locationId: catalogue.shipBin,
        lotId: catalogue.lotA,
        quantityDelta: "20.0000",
        costFromMovementIndex: 0,
      },
    ]);

    const salesOrderId = 70_001;
    const shipment = await post("gen-ship", "inv_sales_order", String(salesOrderId), [
      {
        transactionType: "SALE",
        productVariantId: catalogue.variantId,
        locationId: catalogue.shipBin,
        lotId: catalogue.lotA,
        quantityDelta: "-20.0000",
      },
    ]);

    scene = {
      orgId,
      userId,
      ...catalogue,
      grnId: receipt.grnId,
      grnNumber: receipt.grnNumber,
      transferOneId,
      salesOrderId,
      shipmentTransactionId: shipment.transactionIds[0]!,
    };

    // The shipment never happened. Everything below has to agree.
    await asTenant(orgId, () =>
      engine().reverse(orgId, userId, {
        idempotencyKey: `gen-ship-rev-${tag}`,
        stockTransactionId: scene.shipmentTransactionId,
        reason: "picked from the wrong pallet",
      }),
    );

    const neighbour = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("neighbour", { permissionKeys: READER })
      .build();
    teardowns.push(() => neighbour.teardown());
    await enableInventory(neighbour.orgId);
    const otherCatalogue = await seedCatalogue(
      neighbour.orgId,
      neighbour.members["neighbour"]!.userId,
      `${tag}X`,
    );
    otherOrgLotId = otherCatalogue.lotA;
  }, 300_000);

  afterAll(async () => {
    for (const drop of teardowns) await drop().catch(() => undefined);
    await app?.close();
  }, 120_000);

  it("reconstructs receipt → transfer → split → ship from the lot", async () => {
    const { status, body } = await graph(
      `lotId=${String(scene.lotA)}&includeReversed=true&maxDepth=4`,
    );
    expect(status).toBe(200);
    expect(body.anchor).toMatchObject({ kind: "lot", id: scene.lotA });

    const documents = body.nodes.filter((n) => n.kind === "document").map((n) => n.key);
    expect(documents).toEqual(
      expect.arrayContaining([
        `inv_grn:${String(scene.grnId)}`,
        `inv_transfer:${String(scene.transferOneId)}`,
        "inv_transfer:90002",
        `inv_sales_order:${String(scene.salesOrderId)}`,
      ]),
    );

    // The receipt renders as its GRN number, not as a row id.
    const receiptNode = body.nodes.find((n) => n.key === `inv_grn:${String(scene.grnId)}`);
    expect(receiptNode?.label).toBe(scene.grnNumber);

    // The lot contains the serial, through the one real parent/child FK.
    expect(body.nodes.some((n) => n.kind === "serial")).toBe(true);
    expect(body.edges.some((e) => e.kind === "CONTAINS")).toBe(true);

    // Two hops out: the receipt also brought lot B, which is how a recall
    // reaches a sibling batch.
    const siblingLot = body.nodes.find((n) => n.lotId === scene.lotB);
    expect(siblingLot).toBeDefined();
    expect(siblingLot?.depth).toBe(2);

    // Decimal quantities travel as text. A float here would be the bug.
    const shipEdge = body.edges.find(
      (e) => e.transactionId === scene.shipmentTransactionId,
    );
    expect(shipEdge?.quantity).toBe("-20.0000");
    expect(shipEdge?.direction).toBe("forward");
  }, 90_000);

  it("leaves a reversed shipment out of the graph unless it is asked for", async () => {
    const excluded = await graph(`lotId=${String(scene.lotA)}&maxDepth=4`);
    expect(excluded.status).toBe(200);
    expect(excluded.body.corrections.excludedFromWalk).toBe(true);
    expect(
      excluded.body.edges.some((e) => e.transactionId === scene.shipmentTransactionId),
    ).toBe(false);
    // The sales order is only reachable through that one movement, so with the
    // correction honoured the customer never appears — which is the truth.
    expect(
      excluded.body.nodes.some((n) => n.key === `inv_sales_order:${String(scene.salesOrderId)}`),
    ).toBe(false);

    const included = await graph(`lotId=${String(scene.lotA)}&maxDepth=4&includeReversed=true`);
    const shipEdge = included.body.edges.find(
      (e) => e.transactionId === scene.shipmentTransactionId,
    );
    expect(shipEdge).toBeDefined();
    expect(shipEdge?.reversed).toBe(true);
    expect(included.body.corrections.excludedFromWalk).toBe(false);
  }, 90_000);

  it("stops at the node cap and says the answer is not complete", async () => {
    const { status, body } = await graph(
      `lotId=${String(scene.lotA)}&maxDepth=6&maxNodes=3&includeReversed=true`,
    );
    expect(status).toBe(200);
    expect(body.nodes.length).toBeLessThanOrEqual(3);
    expect(body.truncation.complete).toBe(false);
    expect(body.truncation.reasons).toContain("MAX_NODES");
    expect(body.truncation.nodeCount).toBe(body.nodes.length);
    // Every edge still points at a node that is present: a cut graph must not
    // be a broken one.
    const keys = new Set(body.nodes.map((n) => n.key));
    for (const edge of body.edges) {
      expect(keys.has(edge.from) && keys.has(edge.to)).toBe(true);
    }
  }, 90_000);

  it("stops at the depth cap and flags what it never expanded", async () => {
    const { body } = await graph(
      `lotId=${String(scene.lotA)}&maxDepth=1&includeReversed=true`,
    );
    expect(body.truncation.complete).toBe(false);
    expect(body.truncation.reasons).toContain("MAX_DEPTH");
    expect(body.truncation.depthReached).toBe(1);
    expect(body.truncation.unexploredNodes).toBeGreaterThan(0);
    expect(body.nodes.some((n) => n.unexplored)).toBe(true);
  }, 90_000);

  it("stops at the per-node fan-out cap and names the node it cut", async () => {
    const { body } = await graph(
      `lotId=${String(scene.lotA)}&maxDepth=3&maxFanout=1&includeReversed=true`,
    );
    expect(body.truncation.complete).toBe(false);
    expect(body.truncation.reasons).toContain("MAX_FANOUT");
    expect(body.truncation.fanoutTruncatedNodes.length).toBeGreaterThan(0);
    expect(
      body.nodes.filter((n) => n.fanoutTruncated).map((n) => n.key),
    ).toEqual(body.truncation.fanoutTruncatedNodes);
  }, 90_000);

  it("an unbounded request is refused rather than served", async () => {
    const overDepth = await request(server())
      .get(`/inventory/traceability/genealogy?lotId=${String(scene.lotA)}&maxDepth=99`)
      .set("Authorization", await auth(scene.userId, scene.orgId));
    const overNodes = await request(server())
      .get(`/inventory/traceability/genealogy?lotId=${String(scene.lotA)}&maxNodes=100000`)
      .set("Authorization", await auth(scene.userId, scene.orgId));
    expect(overDepth.status).toBe(400);
    expect(overNodes.status).toBe(400);
  }, 60_000);

  it("another organisation's lot is 404, never 403", async () => {
    const { status } = await graph(`lotId=${String(otherOrgLotId)}`);
    expect(status).toBe(404);
  }, 60_000);

  it("a warehouse-scoped caller gets a graph that admits it is partial", async () => {
    const scoped = await graph(`lotId=${String(scene.lotA)}`, scopedUserId);
    expect(scoped.status).toBe(200);
    expect(scoped.body.warehouseScoped).toBe(true);
    expect(scoped.body.truncation.complete).toBe(false);
    expect(scoped.body.truncation.reasons).toContain("WAREHOUSE_SCOPE");

    // Assigned to no warehouse, the lot is attributable to none of theirs: not
    // an empty graph, which would read as "this lot never moved".
    const nowhere = await graph(`lotId=${String(scene.lotA)}`, unassignedUserId);
    expect(nowhere.status).toBe(404);
  }, 90_000);

  it("exports the graph as CSV that carries its own truncation warning", async () => {
    const response = await request(server())
      .get(
        `/inventory/traceability/genealogy/export?lotId=${String(scene.lotA)}&maxNodes=3&maxDepth=6`,
      )
      .set("Authorization", await auth(scene.userId, scene.orgId));
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["x-genealogy-complete"]).toBe("false");

    const lines = response.text.trim().split("\n");
    expect(lines[0]).toContain("graph_complete");
    expect(lines.length).toBeGreaterThan(1);
    // The caveat rides on every row, because a spreadsheet outlives the header
    // it was downloaded with.
    for (const line of lines.slice(1)) expect(line).toMatch(/,false,[A-Z_ ]+$/);
  }, 90_000);

  it("rejects a duplicate serial at the tenant and SKU", async () => {
    // Drizzle wraps the driver error and leaves the real one on `cause`, so
    // matching on the outer message silently matches nothing.
    let code: string | null = null;
    try {
      await asTenant(scene.orgId, () =>
        db().execute(sql`
          INSERT INTO inv_serial_numbers (org_id, product_variant_id, serial_number)
          VALUES (${scene.orgId}, ${scene.variantId}, ${`SER-${tag}`})`),
      );
    } catch (error) {
      let current: unknown = error;
      while (current instanceof Error && code === null) {
        if ("code" in current && typeof current.code === "string") code = current.code;
        current = (current as { cause?: unknown }).cause;
      }
    }
    expect(code).toBe("23505");
  }, 60_000);

  it("resolves the receipt through the movement's real source id", async () => {
    // The trace chain matched `reference_type = 'GRN'`, which the engine never
    // writes, and joined every GRN in the organisation. Neither is true now.
    const response = await request(server())
      .get(`/inventory/traceability?lotId=${String(scene.lotA)}`)
      .set("Authorization", await auth(scene.userId, scene.orgId));
    expect(response.status).toBe(200);
    const body = response.body as {
      receipts: Array<{ grnId: number; grnNumber: string; qtyReceived: string; reversed: boolean }>;
    };
    expect(body.receipts).toHaveLength(1);
    expect(body.receipts[0]).toMatchObject({
      grnId: scene.grnId,
      grnNumber: scene.grnNumber,
      qtyReceived: "100.0000",
      reversed: false,
    });
  }, 60_000);
});
