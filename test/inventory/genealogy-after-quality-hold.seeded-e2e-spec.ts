import { randomUUID } from "node:crypto";
import request from "supertest";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
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
 * INV-42 — the lot genealogy graph, read after a *manual* quality hold.
 *
 * `genealogy-after-recall.seeded-e2e-spec.ts` makes this assertion for the
 * recall path and passes, because `RecallsService` posts its quarantine under
 * the recall's own id. Its header names the hold path as the place the same
 * claim was one copy-paste from being false, and this file is that claim.
 *
 * Every hop of the walk keys documents on `(reference_type, reference_id)` —
 * `expandDocuments` in `lib/genealogy-queries.ts`. `HoldsService.create` posted
 * its `QUARANTINE_IN` with `sourceId: String(orgId)`, so every manually-raised
 * hold in an organisation collapsed into the single node
 * `QUALITY_HOLD:<orgId>`, and expanding it fanned out to every lot and serial
 * the tenant had ever held. An operator tracing a contaminated batch would
 * arrive at a batch that shares nothing with it — no receipt, no despatch, no
 * transfer — and read that as genealogy.
 *
 * The cause was ordering, not intent: the movement was posted before the
 * `inv_quality_holds` row existed, so there was no hold id to name. Inserting
 * the document first inside the same claim gives the movement a real id and
 * changes nothing else — the engine's `HOLD_EXCEEDS_ON_HAND` refusal still
 * rolls both writes back together, which the last test here asserts.
 *
 * Why this shape:
 *
 *   - The two lots share **no** document. They are received on different GRNs,
 *     so before any hold exists there is no path between them at all. That
 *     makes the reachability assertion a statement about the hold node and
 *     nothing else.
 *   - The stranger lot is held **too**. Without a second hold, "not reachable"
 *     would pass against a graph that simply never draws hold nodes, and would
 *     have passed against the broken code as well.
 *   - Both lots are the same product variant, so a walk that ever hopped
 *     variant-to-variant would also be caught. The variant is not a hop today;
 *     this keeps it that way.
 *
 *   pnpm test:e2e:seeded --testPathPattern=genealogy-after-quality-hold
 */

const PERMISSIONS = [
  "inventory:warehouses:scope-all",
  "inventory:stock:read",
  "inventory:stock:adjust",
  "inventory:quality:read",
  "inventory:quality:inspect",
  "inventory:quality:release",
];

/** Received on each lot. Comfortably more than either hold takes. */
const RECEIVED = "100.0000";
const HELD = "10.0000";

interface Scene {
  orgId: string;
  userId: string;
  variantId: number;
  binA: number;
  binB: number;
  /** The batch the operator is tracing. */
  lot: number;
  /** Held under its own hold, and sharing no document with the first. */
  strangerLot: number;
  grnId: string;
  strangerGrnId: string;
}

describe(`${SEEDED_HARNESS} INV-42 — lot genealogy after a manual quality hold`, () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;
  let tag = "";
  let holdId = 0;
  let strangerHoldId = 0;

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
   * Every cap at its ceiling, so a stranger that fails to appear did so because
   * no edge leads there and not because the walk ran out of budget. The
   * mirror-image mistake — asserting unreachability under a cap that stopped
   * the walk early — is the one way this test could pass while the defect
   * stands, so `truncation.complete` is asserted alongside.
   */
  const lotGraph = (lotId = scene.lot) =>
    graph(`lotId=${String(lotId)}&includeReversed=true&maxDepth=8&maxNodes=100&maxFanout=50`);

  const holdRowsFor = (lotId: number) =>
    asTenant(() =>
      db().execute<{ id: number }>(sql`
        SELECT id FROM inv_quality_holds
         WHERE org_id = ${scene.orgId} AND lot_id = ${lotId}
         ORDER BY id`),
    );

  const quarantineRefsFor = (lotId: number) =>
    asTenant(() =>
      db().execute<{ reference_id: string }>(sql`
        SELECT reference_id FROM inv_stock_transactions
         WHERE org_id = ${scene.orgId}
           AND lot_id = ${lotId}
           AND reference_type = 'QUALITY_HOLD'
         ORDER BY id`),
    );

  const receive = (key: string, lotId: number, locationId: number, ref: string) =>
    asTenant(() =>
      app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
        idempotencyKey: key,
        sourceType: "inv_grn",
        sourceId: ref,
        postingDate: "2026-07-01",
        movements: [
          {
            transactionType: "PURCHASE",
            productVariantId: scene.variantId,
            locationId,
            lotId,
            quantityDelta: RECEIVED,
            unitCost: "3.0000",
          },
        ],
      }),
    );

  const hold = (key: string, lotId: number, locationId: number, quantity = HELD) =>
    asTenant(() =>
      app.app.get(HoldsService).create(scene.orgId, scene.userId, key, {
        productVariantId: scene.variantId,
        locationId,
        lotId,
        quantity,
        reason: `Damaged packaging ${tag}`,
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
        VALUES (${seeded.orgId}, ${uom.id}, 'Held goods', ${`QH-${tag}`}, 'LOT', ${userId})
        RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`QH-${tag}-V`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Main', ${`QHW${tag}`}, ${userId}) RETURNING id`);
      const bin = async (name: string) =>
        one<{ id: number }>(sql`
          INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable)
          VALUES (${seeded.orgId}, ${warehouse.id}, ${name}, ${`${name}${tag}`.slice(0, 20)}, 'BIN', true)
          RETURNING id`);
      const lot = async (suffix: string) =>
        one<{ id: number }>(sql`
          INSERT INTO inv_lots (org_id, product_variant_id, lot_number, status, expiry_date)
          VALUES (${seeded.orgId}, ${variant.id}, ${`QH-${suffix}-${tag}`}, 'ACTIVE', '2027-06-01')
          RETURNING id`);

      const binA = await bin("QA");
      const binB = await bin("QB");
      const grnId = String(60_000 + Math.floor(Math.random() * 8_000));
      return {
        orgId: seeded.orgId,
        userId,
        variantId: variant.id,
        binA: binA.id,
        binB: binB.id,
        lot: (await lot("HELD")).id,
        strangerLot: (await lot("STRANGER")).id,
        grnId,
        strangerGrnId: `${grnId}1`,
      };
    });

    // The graph is read over HTTP, so `ModuleGuard` runs and answers 402 for an
    // organisation with no `org_modules` row. The service calls below bypass
    // that guard, which is how this suite can set a scene the API would refuse
    // to serve.
    await asTenant(async () => {
      await db().execute(sql`
        INSERT INTO org_modules (org_id, module_key, enabled)
        VALUES (${scene.orgId}, 'inventory', true) ON CONFLICT DO NOTHING`);
    });

    // Two batches, two receipts, two different GRNs: no document is common to
    // both, so the only edge that could ever join them is one this test is
    // about.
    await receive(`qh-recv-${tag}`, scene.lot, scene.binA, scene.grnId);
    await receive(`qh-recv-stranger-${tag}`, scene.strangerLot, scene.binB, scene.strangerGrnId);
  }, 600_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app?.close();
  }, 300_000);

  describe("before any hold", () => {
    it("cannot reach the stranger batch, because nothing joins them yet", async () => {
      // The baseline the rest of the file rests on. If these two lots were
      // already connected through the fixture, every later "not reachable"
      // would be measuring the fixture rather than the hold.
      const { status, body } = await lotGraph();
      expect(status).toBe(200);
      expect(body.truncation.complete).toBe(true);
      expect(body.nodes.map((n) => n.key)).toContain(`inv_grn:${scene.grnId}`);
      expect(body.nodes.some((n) => n.lotId === scene.strangerLot)).toBe(false);
    }, 300_000);
  });

  describe("after two unrelated holds", () => {
    it("raises a hold on each batch", async () => {
      const held = await hold(`qh-hold-${tag}`, scene.lot, scene.binA);
      const stranger = await hold(`qh-hold-stranger-${tag}`, scene.strangerLot, scene.binB);
      holdId = held!.id;
      strangerHoldId = stranger!.id;

      // Two documents, not one. Everything below is a claim about telling them
      // apart, so a fixture that produced a single hold would make it vacuous.
      expect(holdId).toBeGreaterThan(0);
      expect(strangerHoldId).not.toBe(holdId);
    }, 300_000);

    it("keys the quarantine movement on the hold, not on the tenant", async () => {
      // The defect at its source, before any walking: `reference_id` is what
      // every hop joins on, and `String(orgId)` made it the same string for
      // every hold in the organisation.
      const refs = await quarantineRefsFor(scene.lot);
      expect(refs).toHaveLength(1);
      expect(refs[0]!.reference_id).toBe(String(holdId));
      expect(refs[0]!.reference_id).not.toBe(scene.orgId);

      const strangerRefs = await quarantineRefsFor(scene.strangerLot);
      expect(strangerRefs[0]!.reference_id).toBe(String(strangerHoldId));
      // The two holds are distinguishable in the ledger. This is the whole
      // property; the graph assertions below are its consequence.
      expect(strangerRefs[0]!.reference_id).not.toBe(refs[0]!.reference_id);
    }, 300_000);

    it("gives the hold its own document node", async () => {
      // The positive half. Asserting only that the stranger is absent would be
      // satisfied by a walk that dropped hold movements altogether, which would
      // be a different and equally wrong graph.
      const { body } = await lotGraph();
      expect(body.truncation.complete).toBe(true);

      const node = body.nodes.find((n) => n.referenceType === "QUALITY_HOLD");
      expect(node).toBeDefined();
      expect(node!.referenceId).toBe(String(holdId));
      expect(node!.referenceId).not.toBe(scene.orgId);

      // And the movement is drawn as a hold, not as goods leaving: a quarantine
      // is arithmetic inside the grain's own row.
      const quarantine = body.edges.filter((e) => e.transactionType === "QUARANTINE_IN");
      expect(quarantine).toHaveLength(1);
      expect(quarantine[0]!.quantity?.startsWith("-")).toBe(false);
    }, 300_000);

    it("does not reach the stranger batch through the hold", async () => {
      // The defect, stated as the thing an operator would actually suffer.
      // Against `sourceId: String(orgId)` the walk goes
      //   lot:HELD → QUALITY_HOLD:<orgId> → lot:STRANGER
      // in two hops, and this is the assertion that fails.
      const { body } = await lotGraph();
      expect(body.truncation.complete).toBe(true);

      expect(body.nodes.some((n) => n.lotId === scene.strangerLot)).toBe(false);
      expect(body.nodes.some((n) => n.referenceId === String(strangerHoldId))).toBe(false);
      expect(body.nodes.map((n) => n.key)).not.toContain(`QUALITY_HOLD:${scene.orgId}`);
      expect(body.nodes.map((n) => n.key)).not.toContain(`inv_grn:${scene.strangerGrnId}`);
    }, 300_000);

    it("is symmetric: the stranger cannot reach this batch either", async () => {
      // A one-directional check would pass against a walk that happened to
      // expand the smaller side first and hit a cap.
      const { body } = await lotGraph(scene.strangerLot);
      expect(body.truncation.complete).toBe(true);
      expect(body.nodes.some((n) => n.lotId === scene.lot)).toBe(false);
      expect(body.nodes.find((n) => n.referenceType === "QUALITY_HOLD")!.referenceId).toBe(
        String(strangerHoldId),
      );
    }, 300_000);
  });

  describe("the ordering the fix depends on", () => {
    it("rolls the hold document back with the movement it could not post", async () => {
      // The fix inserts `inv_quality_holds` *before* the movement, so the
      // document now exists when the engine refuses. If that insert were
      // outside the engine's claim — or the transaction — a refused hold would
      // leave an ACTIVE hold row against stock that was never quarantined,
      // which is worse than the bug being fixed. Holding more than is on hand
      // is the cheapest way to make the engine refuse.
      const before = await holdRowsFor(scene.lot);

      await expect(
        hold(`qh-hold-toomuch-${tag}`, scene.lot, scene.binA, "999999.0000"),
      ).rejects.toThrow();

      expect(await holdRowsFor(scene.lot)).toHaveLength(before.length);
    }, 300_000);
  });
});
