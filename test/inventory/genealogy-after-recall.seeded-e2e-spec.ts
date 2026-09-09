import { randomUUID } from "node:crypto";
import request from "supertest";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { RecallsService } from "src/modules/inventory/quality/quality-recalls.service";
import { HoldsService } from "src/modules/inventory/quality/quality-holds.service";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import type { GenealogyResult } from "src/modules/inventory/traceability/genealogy.types";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * INV-42 — the lot genealogy graph, read after a recall.
 *
 * `lot-genealogy.seeded-e2e-spec.ts` proves the walk itself thoroughly:
 * receipt → transfer → split → ship, the three caps, warehouse scope,
 * cross-tenant 404, CSV export. It never runs a recall. INV-42's whole subject
 * is the state *after* one, and its acceptance is "report matches txs" — so the
 * one thing nothing checked was whether the graph an operator reads while
 * deciding what to do about a recalled batch still corresponds to the ledger.
 *
 * A recall is the moment that question is expensive to get wrong, and it is
 * also the moment the graph changes shape: quarantining posts real
 * `inv_stock_transactions` rows against the lot, so the walk gains edges for
 * movements that did not move anything. Two failure modes follow from that, and
 * each has a test below.
 *
 *   1. **The graph invents goods leaving the building.** A hold is arithmetic
 *      inside the grain's own row — `quality_hold_qty` is a subset of
 *      `on_hand`, not a pool beside it. If a quarantine edge read as a
 *      despatch, an operator tracing a contaminated batch would see stock that
 *      had gone somewhere, and go looking for a customer who does not exist.
 *
 *   2. **The recall is not its own document.** Every walk hop keys on
 *      `(reference_type, reference_id)`, so two recalls sharing a reference
 *      would share a graph node, and expanding it would walk from one recalled
 *      batch into an unrelated one. The recall path passes the recall's own id
 *      and is correct; the assertion exists because the neighbouring manual
 *      hold path passes `String(orgId)` instead, which is one copy-paste away
 *      from being true here too.
 *
 * The central assertion is neither of those, though — it is set equality
 * between the edges the API returned and the rows the ledger holds, run after
 * every stage. That is "report matches txs" said literally rather than
 * approximated by spot checks, and it is what catches an edge the walk invented
 * as well as a movement it silently dropped.
 *
 *   pnpm test:e2e:seeded --testPathPattern=genealogy-after-recall
 */

const PERMISSIONS = [
  "inventory:warehouses:scope-all",
  "inventory:stock:read",
  "inventory:stock:adjust",
  "inventory:quality:read",
  "inventory:quality:recall",
  "inventory:quality:inspect",
  "inventory:quality:release",
];

const RECEIVED = "100.0000";
const SHIPPED = "-30.0000";

interface Scene {
  orgId: string;
  userId: string;
  variantId: number;
  binA: number;
  binB: number;
  /** The batch that gets recalled. */
  lot: number;
  /** Recalled under a *different* document, so the two must not share a node. */
  strangerLot: number;
  grnId: string;
  soId: string;
}

describe(`${SEEDED_HARNESS} INV-42 — lot genealogy after a recall`, () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;
  let tag = "";
  let recallId = 0;
  let strangerRecallId = 0;

  const db = () => app.app.get<Db>(DRIZZLE);
  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(db(), scene.orgId, work);

  const graph = async (query: string): Promise<{ status: number; body: GenealogyResult }> => {
    const response = await request(app.app.getHttpServer())
      .get(`/inventory/traceability/genealogy?${query}`)
      .set("Authorization", `Bearer ${await signSeededToken(scene.userId, scene.orgId)}`);
    return { status: response.status, body: response.body as GenealogyResult };
  };

  /**
   * The whole graph around the recalled lot, corrections included and every cap
   * at its ceiling — `maxNodes` is capped at 100 and `maxFanout` at 50, so
   * asking for more is a 400 rather than a bigger answer. At the ceiling a
   * truncated result is a fixture that outgrew the caps, not a walk that lost
   * an edge, which is why `truncation.complete` is asserted alongside.
   */
  const lotGraph = (lotId = scene.lot) =>
    graph(`lotId=${String(lotId)}&includeReversed=true&maxDepth=4&maxNodes=100&maxFanout=50`);

  /**
   * Every movement the ledger holds for this lot that the walk is allowed to
   * see, as its transaction ids.
   *
   * The predicate mirrors `expandItemsOfKind` deliberately — a reference is what
   * makes a movement reachable, because the walk hops lot → document → lot. A
   * looser predicate here would report the walk as lossy; a tighter one would
   * hide a dropped edge, which is the failure this assertion exists to catch.
   */
  const ledgerIdsFor = (lotId: number): Promise<number[]> =>
    asTenant(async () => {
      const rows = await db().execute<{ id: number }>(sql`
        SELECT id FROM inv_stock_transactions
         WHERE org_id = ${scene.orgId}
           AND lot_id = ${lotId}
           AND reference_type IS NOT NULL
           AND reference_id IS NOT NULL
         ORDER BY id`);
      return rows.map((r) => r.id);
    });

  /** The movement edges the graph drew that are anchored on this lot. */
  const graphIdsFor = (body: GenealogyResult, lotId: number): number[] => {
    const key = `lot:${String(lotId)}`;
    return [
      ...new Set(
        body.edges
          .filter((e) => e.kind === "MOVEMENT" && (e.from === key || e.to === key))
          .map((e) => e.transactionId)
          .filter((id): id is number => id !== null),
      ),
    ].sort((a, b) => a - b);
  };

  const onHandOf = (lotId: number): Promise<string> =>
    asTenant(async () => {
      const rows = await db().execute<{ total: string }>(sql`
        SELECT COALESCE(SUM(on_hand), 0)::text AS total FROM inv_stock_levels
         WHERE org_id = ${scene.orgId} AND lot_id = ${lotId}`);
      return rows[0]!.total;
    });

  const post = (key: string, lotId: number, locationId: number, qty: string, ref: [string, string]) =>
    asTenant(() =>
      app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
        idempotencyKey: key,
        sourceType: ref[0],
        sourceId: ref[1],
        postingDate: "2026-07-01",
        movements: [
          {
            transactionType: qty.startsWith("-") ? "SALE" : "PURCHASE",
            productVariantId: scene.variantId,
            locationId,
            lotId,
            quantityDelta: qty,
            ...(qty.startsWith("-") ? {} : { unitCost: "3.0000" }),
          },
        ],
      }),
    );

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("tracer", { permissionKeys: PERMISSIONS })
      .build();
    teardown = () => seeded.teardown();

    tag = randomUUID().slice(0, 6);
    scene = await runInNewTenantTransaction(db(), seeded.orgId, async () => {
      const userId = seeded.members["tracer"]!.userId;
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db().execute<T>(q))[0]!;

      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, tracking_method, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Traced goods', ${`GR-${tag}`}, 'LOT', ${userId})
        RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`GR-${tag}-V`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Main', ${`GRW${tag}`}, ${userId}) RETURNING id`);
      const bin = async (name: string) =>
        one<{ id: number }>(sql`
          INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable)
          VALUES (${seeded.orgId}, ${warehouse.id}, ${name}, ${`${name}${tag}`.slice(0, 20)}, 'BIN', true)
          RETURNING id`);
      const lot = async (suffix: string) =>
        one<{ id: number }>(sql`
          INSERT INTO inv_lots (org_id, product_variant_id, lot_number, status, expiry_date)
          VALUES (${seeded.orgId}, ${variant.id}, ${`GL-${suffix}-${tag}`}, 'ACTIVE', '2027-06-01')
          RETURNING id`);

      const binA = await bin("GA");
      const binB = await bin("GB");
      return {
        orgId: seeded.orgId,
        userId,
        variantId: variant.id,
        binA: binA.id,
        binB: binB.id,
        lot: (await lot("BAD")).id,
        strangerLot: (await lot("STRANGER")).id,
        grnId: String(90_000 + Math.floor(Math.random() * 8_000)),
        soId: String(70_000 + Math.floor(Math.random() * 8_000)),
      };
    });

    // The graph is read over HTTP, so `ModuleGuard` runs and answers 402 for an
    // organisation with no `org_modules` row. Every service call below bypasses
    // that guard, which is exactly how a suite can exercise a feature the API
    // would refuse to serve.
    await asTenant(async () => {
      await db().execute(sql`
        INSERT INTO org_modules (org_id, module_key, enabled)
        VALUES (${scene.orgId}, 'inventory', true) ON CONFLICT DO NOTHING`);
    });

    // A history worth walking: a receipt into two bins and a despatch to a
    // customer, so the graph has a document on either side of the lot before
    // anything is recalled.
    await post(`gr-recv-a-${tag}`, scene.lot, scene.binA, RECEIVED, ["inv_grn", scene.grnId]);
    await post(`gr-recv-b-${tag}`, scene.lot, scene.binB, "40.0000", ["inv_grn", scene.grnId]);
    await post(`gr-ship-${tag}`, scene.lot, scene.binA, SHIPPED, ["inv_sales_order", scene.soId]);
    // A batch that never shared a document with the first one.
    await post(`gr-strange-${tag}`, scene.strangerLot, scene.binB, "25.0000", [
      "inv_grn",
      `${scene.grnId}1`,
    ]);
  }, 600_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app?.close();
  }, 300_000);

  describe("before the recall", () => {
    it("draws exactly the movements the ledger holds", async () => {
      const { status, body } = await lotGraph();
      expect(status).toBe(200);
      // Set equality below is only a claim about the walk while the walk ran to
      // the end. A truncated answer would make every later comparison a
      // statement about the caps instead.
      expect(body.truncation.complete).toBe(true);

      const ledger = await ledgerIdsFor(scene.lot);
      // The floor. Two empty sets are equal and would prove nothing, and an
      // empty ledger is exactly what a broken fixture produces.
      expect(ledger.length).toBeGreaterThanOrEqual(3);
      expect(graphIdsFor(body, scene.lot)).toEqual(ledger);
    }, 300_000);

    it("reaches the customer through the despatch, and not the stranger batch", async () => {
      const { body } = await lotGraph();
      const keys = body.nodes.map((n) => n.key);
      expect(keys).toContain(`inv_sales_order:${scene.soId}`);
      expect(keys).toContain(`inv_grn:${scene.grnId}`);
      expect(keys).not.toContain(`lot:${String(scene.strangerLot)}`);
    }, 300_000);
  });

  describe("after the recall", () => {
    let before: GenealogyResult;

    it("quarantines the batch", async () => {
      before = (await lotGraph()).body;

      const created = await asTenant(() =>
        app.app.get(RecallsService).create(
          scene.orgId,
          scene.userId,
          { title: `Recall ${tag}`, lines: [{ lotId: scene.lot }] },
          `gr-recall-${tag}`,
        ),
      );
      recallId = created.id;

      // The stranger is recalled too, under its own document. Without this the
      // "not reachable" assertion below would pass against a graph that simply
      // never draws recall nodes at all.
      const stranger = await asTenant(() =>
        app.app.get(RecallsService).create(
          scene.orgId,
          scene.userId,
          { title: `Recall stranger ${tag}`, lines: [{ lotId: scene.strangerLot }] },
          `gr-recall-stranger-${tag}`,
        ),
      );
      strangerRecallId = stranger.id;

      expect(recallId).toBeGreaterThan(0);
      expect(strangerRecallId).not.toBe(recallId);
    }, 300_000);

    it("still draws exactly the movements the ledger holds", async () => {
      // INV-42's acceptance, at the moment it matters. The quarantine added
      // real ledger rows; the graph must have gained exactly those and nothing
      // else.
      const { body } = await lotGraph();
      const ledger = await ledgerIdsFor(scene.lot);
      // The recall really did add rows — otherwise "still matches" would be the
      // same claim the pre-recall test already made.
      expect(ledger.length).toBeGreaterThan(graphIdsFor(before, scene.lot).length);
      expect(graphIdsFor(body, scene.lot)).toEqual(ledger);
    }, 300_000);

    it("shows the quarantine as a hold, not as goods that left the building", async () => {
      // `quality_hold_qty` is a subset of `on_hand`, so a recall changes what
      // may be sold and not what is on the shelf. An edge reading as a despatch
      // would send somebody looking for a customer who does not exist.
      const { body } = await lotGraph();
      const quarantine = body.edges.filter((e) => e.transactionType === "QUARANTINE_IN");
      expect(quarantine.length).toBeGreaterThanOrEqual(2);
      for (const edge of quarantine) {
        expect(edge.quantity?.startsWith("-")).toBe(false);
        expect(edge.reversed).toBe(false);
      }
      expect(await onHandOf(scene.lot)).toBe("110.0000");
    }, 300_000);

    it("leaves the receipt and the despatch exactly as they were", async () => {
      // The control for the assertion above: the recall added edges, it did not
      // rewrite the ones already there. A walk that re-derived history from the
      // current state rather than from the ledger would move these.
      const { body } = await lotGraph();
      const settled = (result: GenealogyResult) =>
        result.edges
          .filter((e) => e.transactionType === "PURCHASE" || e.transactionType === "SALE")
          .map((e) => `${e.transactionType ?? ""}:${String(e.transactionId)}:${e.quantity ?? ""}`)
          .sort();
      expect(settled(body)).toEqual(settled(before));
      expect(body.nodes.map((n) => n.key)).toEqual(
        expect.arrayContaining([`inv_sales_order:${scene.soId}`, `inv_grn:${scene.grnId}`]),
      );
    }, 300_000);

    it("gives the recall its own document, keyed on the recall and not the tenant", async () => {
      // Every hop keys on (reference_type, reference_id). A recall that
      // referenced the organisation instead of itself would put every recalled
      // batch in the tenant behind one node — which is what the neighbouring
      // manual hold path does at `quality-holds.service.ts:113`
      // (`sourceId: String(orgId)`), so this is one copy-paste from being true
      // here.
      const { body } = await lotGraph();
      const node = body.nodes.find((n) => n.referenceType === "RECALL");
      expect(node).toBeDefined();
      expect(node!.referenceId).toBe(String(recallId));
      expect(node!.referenceId).not.toBe(scene.orgId);

      // And the consequence, stated as reachability: the stranger batch is
      // recalled, so it has a RECALL node of its own, and no walk from this lot
      // arrives at it.
      expect(body.nodes.some((n) => n.lotId === scene.strangerLot)).toBe(false);
      expect(
        body.nodes.some((n) => n.referenceId === String(strangerRecallId)),
      ).toBe(false);
    }, 300_000);
  });

  describe("after the release", () => {
    it("draws the reversal beside the hold, and still matches the ledger", async () => {
      const holds = await asTenant(async () =>
        db().execute<{ id: number }>(sql`
          SELECT id FROM inv_quality_holds
           WHERE org_id = ${scene.orgId} AND lot_id = ${scene.lot} AND status = 'ACTIVE'
           ORDER BY id`),
      );
      expect(holds.length).toBeGreaterThanOrEqual(2);
      for (const hold of holds) {
        await asTenant(() =>
          app.app
            .get(HoldsService)
            .release(scene.orgId, scene.userId, hold.id, `gr-release-${String(hold.id)}-${tag}`),
        );
      }

      const { body } = await lotGraph();
      const ledger = await ledgerIdsFor(scene.lot);
      expect(graphIdsFor(body, scene.lot)).toEqual(ledger);

      // A release is a `QUARANTINE_OUT`, and it is NOT a correction: it does not
      // set `correction_of_transaction_id`, so it stands in the graph as its own
      // movement rather than deleting the hold from history. That is what makes
      // "this batch was held and then let back out" readable six months later.
      const out = body.edges.filter((e) => e.transactionType === "QUARANTINE_OUT");
      expect(out.length).toBeGreaterThanOrEqual(2);
      for (const edge of out) expect(edge.quantity?.startsWith("-")).toBe(true);
      expect(body.edges.some((e) => e.transactionType === "QUARANTINE_IN")).toBe(true);
    }, 300_000);

    it("has still moved no stock at all", async () => {
      expect(await onHandOf(scene.lot)).toBe("110.0000");
    }, 300_000);
  });
});
