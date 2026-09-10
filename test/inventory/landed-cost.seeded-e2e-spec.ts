import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { PoService } from "src/modules/inventory/purchase-orders/po.service";
import { GrnService } from "src/modules/inventory/purchase-orders/grn.service";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { LandedCostService } from "src/modules/inventory/landed-cost/landed-cost.service";
import { LandedCostApplyService } from "src/modules/inventory/landed-cost/landed-cost-apply.service";
import { LandedCostController } from "src/modules/inventory/landed-cost/landed-cost.controller";
import { InvLabelsService } from "src/modules/inventory/labels/inv-labels.service";
import { InvLabelsController } from "src/modules/inventory/labels/inv-labels.controller";
import { InvBarcodeService } from "src/modules/inventory/barcode/inv-barcode.service";
import { InventoryAccountingBridge } from "src/modules/inventory/stock-engine/accounting-bridge";
import { JournalPostingService } from "src/modules/accounting/posting/journal-posting.service";
import { REQUIRE_PERMISSION } from "src/modules/access/require-permission.decorator";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * G5 / G4 — landed cost reaching the cost layers, and the documents that come
 * off a receipt, against Postgres.
 *
 * The unit's "done when" for G5 is one sentence: a two-line goods receipt with
 * freight on it produces layer costs that sum to merchandise plus freight. That
 * is the first describe block, and every figure in it is worked out on paper
 * before the code runs:
 *
 *   line 1   100 units at 4.00   =   400.00
 *   line 2    50 units at 12.00  =   600.00
 *   freight                          100.00, allocated by value
 *
 *   layer 1  400.00 + 40.00 = 440.00 over 100 units = 4.40 each
 *   layer 2  600.00 + 60.00 = 660.00 over  50 units = 13.20 each
 *                                     -------
 *                                     1100.00 = 1000.00 + 100.00
 *
 * The block after it is the one that cannot be faked by a mock and is the real
 * point of the feature: an issue posted *after* the voucher draws at 4.40 and
 * costs 440.00, not the 400.00 the supplier's invoice line said. Both figures
 * are defensible-looking and only one of them is the truth.
 *
 * The third block is the design question the unit actually asks — freight that
 * arrives after the goods have started moving — and it is checked against
 * hand-worked figures too, including which side of the split the money that
 * cannot capitalise lands on.
 *
 *   pnpm test:e2e:seeded --testPathPattern=landed-cost
 */

const OPERATOR = [
  "inventory:warehouses:scope-all",
  "inventory:products:read",
  "inventory:stock:read",
  "inventory:purchase-orders:create",
  "inventory:purchase-orders:read",
  "inventory:purchase-orders:receive",
  "inventory:valuation:read",
  "inventory:landed-cost:manage",
  "inventory:labels:print",
] as const;

/** One posted journal line, named by the account code rather than its id. */
type JournalLineRow = {
  account_code: string;
  debit: string;
  credit: string;
  description: string | null;
};

interface Scene {
  orgId: string;
  userId: string;
  warehouseId: number;
  locationId: number;
  vendorId: number;
  /** FIFO, untracked. The two lines of the headline receipt. */
  cheapId: number;
  dearId: number;
  /** FIFO, untracked. The receipt that is partly issued before freight lands. */
  lateCheapId: number;
  lateDearId: number;
  /** FIFO, LOT-tracked, with a barcode — the label and the printed note. */
  batchedId: number;
  batchedSku: string;
  /** Weighted average, which landed cost refuses rather than mis-costs. */
  averagedId: number;
  /**
   * FIFO, untracked. The three receipts the accounting block costs, kept apart
   * from the ones above so a journal assertion cannot be satisfied by a layer
   * another test moved.
   */
  glSkipId: number;
  glOnHandId: number;
  glShippedId: number;
  vendorName: string;
  orgName: string;
}

describe("[seeded-e2e] landing freight onto a receipt's cost layers", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  const db = () => app.app.get<Db>(DRIZZLE);

  /** A sent order, and the ids of its lines in the order they were given. */
  async function sentOrder(
    lines: ReadonlyArray<{ variantId: number; quantity: number; unitCost: string }>,
  ) {
    const po = await asTenant(() =>
      app.app.get(PoService).createPo(scene.orgId, scene.userId, {
        vendorId: scene.vendorId,
        orderDate: "2026-08-01",
        warehouseId: scene.warehouseId,
        currency: "INR",
        lines: lines.map((line, index) => ({
          productVariantId: line.variantId,
          quantity: line.quantity,
          unitCost: line.unitCost,
          taxRate: "0",
          lineOrder: index,
        })),
      } as never),
    );
    await asTenant(() => app.app.get(PoService).sendPo(scene.orgId, po.id, scene.userId));
    const poLines = await asTenant(() =>
      db().execute<{ id: number }>(sql`
        SELECT id FROM inv_po_lines
        WHERE org_id = ${scene.orgId} AND po_id = ${po.id}
        ORDER BY line_order, id`),
    );
    return { poId: po.id, poLineIds: poLines.map((row) => Number(row.id)) };
  }

  /** Receives and posts in one command, which is what the dock actually does. */
  const receive = (poId: number, lines: ReadonlyArray<Record<string, unknown>>) =>
    asTenant(() =>
      app.app.get(GrnService).receiveGoods(
        scene.orgId,
        poId,
        scene.userId,
        `grn-${randomUUID()}`,
        { receivedDate: "2026-08-02", locationId: scene.locationId, lines } as never,
      ),
    );

  const layersFor = (grnId: number) =>
    asTenant(() =>
      db().execute<{
        id: number;
        product_variant_id: number;
        quantity: string;
        unit_cost: string;
        total_value: string;
        remaining_quantity: string;
        remaining_value: string;
      }>(sql`
        SELECT id, product_variant_id, quantity, unit_cost, total_value,
               remaining_quantity, remaining_value
        FROM inv_valuation_layers
        WHERE org_id = ${scene.orgId}
          AND source_type = 'inv_grn'
          AND source_id = ${String(grnId)}
        ORDER BY id`),
    );

  const voucherRow = (voucherId: number) =>
    asTenant(async () => {
      const [row] = await db().execute<{
        status: string;
        charge_total_cents: string;
        capitalised_value: string;
        expensed_value: string;
      }>(sql`
        SELECT status, charge_total_cents, capitalised_value, expensed_value
        FROM inv_landed_cost_vouchers
        WHERE org_id = ${scene.orgId} AND id = ${voucherId}`);
      return row!;
    });

  const allocationsFor = (voucherId: number) =>
    asTenant(() =>
      db().execute<{
        valuation_layer_id: number;
        allocated_value: string;
        capitalised_value: string;
        expensed_value: string;
        unit_cost_before: string;
        unit_cost_after: string;
        remaining_quantity: string;
      }>(sql`
        SELECT valuation_layer_id, allocated_value, capitalised_value, expensed_value,
               unit_cost_before, unit_cost_after, remaining_quantity
        FROM inv_landed_cost_allocations
        WHERE org_id = ${scene.orgId} AND voucher_id = ${voucherId}
        ORDER BY valuation_layer_id`),
    );

  /** A plain issue through the real engine, so the cost is the layers' cost. */
  const issue = (variantId: number, quantity: string, tag: string) =>
    asTenant(() =>
      app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
        idempotencyKey: `lc-issue-${tag}-${randomUUID()}`,
        sourceType: "landed-cost-fixture",
        sourceId: tag,
        movements: [
          {
            transactionType: "SALE",
            productVariantId: variantId,
            locationId: scene.locationId,
            quantityDelta: `-${quantity}`,
          },
        ],
      } as never),
    );

  const issueCost = (tag: string) =>
    asTenant(async () => {
      const [row] = await db().execute<{
        id: number;
        total_cost: string | null;
        unit_cost: string | null;
      }>(sql`
        SELECT id, total_cost, unit_cost
        FROM inv_stock_transactions
        WHERE org_id = ${scene.orgId}
          AND reference_type = 'landed-cost-fixture'
          AND reference_id = ${tag}
        ORDER BY id DESC
        LIMIT 1`);
      const [drawn] = await db().execute<{ drawn: string; layers: number }>(sql`
        SELECT COALESCE(SUM(total_cost), 0)::text AS drawn, count(*)::int AS layers
        FROM inv_valuation_consumptions
        WHERE org_id = ${scene.orgId} AND stock_transaction_id = ${row!.id}`);
      return { movement: row!, drawn: drawn! };
    });

  const createVoucher = (
    grnId: number,
    amountCents: number,
    basis: "VALUE" | "QUANTITY" = "VALUE",
    key = `lc-create-${randomUUID()}`,
  ) =>
    asTenant(() =>
      app.app.get(LandedCostService).createVoucher(
        scene.orgId,
        scene.userId,
        {
          grnId,
          allocationBasis: basis,
          currency: "INR",
          charges: [
            { chargeType: "FREIGHT", description: "Inbound haulage", amountCents },
          ],
        } as never,
        key,
      ),
    );

  const applyVoucher = (voucherId: number, key = `lc-apply-${randomUUID()}`) =>
    asTenant(() =>
      app.app
        .get(LandedCostApplyService)
        .applyVoucher(scene.orgId, scene.userId, voucherId, key),
    );

  /**
   * The journal `apply` posted for a voucher, read back out of the database.
   *
   * Joined to `ledger_accounts` so the assertion names the account *code* — that
   * is what `postJournal` writes, what a reader of the ledger recognises, and
   * what INV-38 is about. Asserting `account_id` instead would make the test
   * pass or fail on the order `seedChartOfAccountsForOrg` happened to insert in,
   * which is not a fact about landed cost.
   */
  const journalFor = (voucherId: number) =>
    asTenant(async () => {
      const [entry] = await db().execute<{
        id: number;
        entry_date: string;
        description: string | null;
        source_event: string | null;
        status: string;
      }>(sql`
        SELECT id, entry_date::text AS entry_date, description, source_event, status
        FROM journal_entries
        WHERE org_id = ${scene.orgId}
          AND source_type = 'inv_landed_cost'
          AND source_id = ${String(voucherId)}`);
      if (!entry) return { entry: null, lines: [] as JournalLineRow[] };
      const lines = await db().execute<JournalLineRow>(sql`
        SELECT a.code AS account_code, l.debit::text AS debit,
               l.credit::text AS credit, l.description
        FROM journal_lines l
        JOIN ledger_accounts a ON a.id = l.account_id
        WHERE l.org_id = ${scene.orgId} AND l.entry_id = ${entry.id}
        ORDER BY l.line_order, l.id`);
      return { entry, lines };
    });

  const ledgerAccountCount = () =>
    asTenant(async () => {
      const [row] = await db().execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM ledger_accounts WHERE org_id = ${scene.orgId}`);
      return row!.n;
    });

  /** Exactly what `postJournal` uses, rather than a date this file invents. */
  const today = () => new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("operator", { permissionKeys: OPERATOR })
      .build();
    teardown = () => seeded.teardown();

    const tag = randomUUID().slice(0, 6);
    const database = app.app.get<Db>(DRIZZLE);
    const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
      (await database.execute<T>(q))[0]!;

    scene = await runInNewTenantTransaction(database, seeded.orgId, async () => {
      const orgId = seeded.orgId;
      const userId = seeded.members["operator"]!.userId;

      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);

      const variant = async (
        alias: string,
        method: string,
        tracking: string,
        barcode: string | null,
      ) => {
        const product = await one<{ id: number }>(sql`
          INSERT INTO inv_products (org_id, uom_id, name, sku, costing_method, tracking_method, created_by)
          VALUES (${orgId}, ${uom.id}, ${alias}, ${`${alias}-${tag}`},
                  ${sql.raw(`'${method}'`)}, ${sql.raw(`'${tracking}'`)}, ${userId})
          RETURNING id`);
        const row = await one<{ id: number; sku: string }>(sql`
          INSERT INTO inv_product_variants (org_id, product_id, name, sku, barcode)
          VALUES (${orgId}, ${product.id}, 'Default', ${`${alias}-${tag}-V1`}, ${barcode})
          RETURNING id, sku`);
        return row;
      };

      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${orgId}, ${`Dockside ${tag}`}, ${`DK${tag}`}, ${userId}) RETURNING id`);
      const location = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
        VALUES (${orgId}, ${warehouse.id}, 'Bay 1', ${`B1${tag}`}, 'BIN') RETURNING id`);
      const vendorName = `Freighted Supplies ${tag}`;
      const vendor = await one<{ id: number }>(sql`
        INSERT INTO inv_vendors (org_id, name, code, created_by)
        VALUES (${orgId}, ${vendorName}, ${`VF${tag}`}, ${userId}) RETURNING id`);
      const org = await one<{ name: string }>(sql`
        SELECT name FROM organizations WHERE id = ${orgId}`);

      // A short alias on purpose: the printed note gives the SKU column a fixed
      // share of the page and truncates what does not fit, so a fixture SKU
      // longer than a real one would fail the PDF assertion for the wrong reason.
      const batched = await variant(
        "BW",
        "FIFO",
        "LOT",
        `0890${tag.replace(/\D/g, "0").padEnd(10, "7").slice(0, 10)}`,
      );

      return {
        orgId,
        userId,
        warehouseId: warehouse.id,
        locationId: location.id,
        vendorId: vendor.id,
        cheapId: (await variant("CHEAP", "FIFO", "NONE", null)).id,
        dearId: (await variant("DEAR", "FIFO", "NONE", null)).id,
        lateCheapId: (await variant("LATECHEAP", "FIFO", "NONE", null)).id,
        lateDearId: (await variant("LATEDEAR", "FIFO", "NONE", null)).id,
        batchedId: batched.id,
        batchedSku: batched.sku,
        averagedId: (await variant("AVERAGED", "WEIGHTED_AVERAGE", "NONE", null)).id,
        glSkipId: (await variant("GLSKIP", "FIFO", "NONE", null)).id,
        glOnHandId: (await variant("GLONHAND", "FIFO", "NONE", null)).id,
        glShippedId: (await variant("GLSHIPPED", "FIFO", "NONE", null)).id,
        vendorName,
        orgName: org.name,
      };
    });
  }, 300_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  describe("a two-line receipt with freight on it", () => {
    let grnId: number;
    let voucherId: number;

    beforeAll(async () => {
      const order = await sentOrder([
        { variantId: scene.cheapId, quantity: 100, unitCost: "4.0000" },
        { variantId: scene.dearId, quantity: 50, unitCost: "12.0000" },
      ]);
      const grn = (await receive(order.poId, [
        { poLineId: order.poLineIds[0], quantityReceived: "100" },
        { poLineId: order.poLineIds[1], quantityReceived: "50" },
      ])) as { id: number };
      grnId = grn.id;

      // 100.00 of freight, as 10000 paise. Money crosses the boundary as an
      // integer and never becomes a float on the way to the layers.
      voucherId = (await createVoucher(grnId, 10_000)).id;
    }, 120_000);

    it("starts with the layers the supplier's invoice paid for", async () => {
      const layers = await layersFor(grnId);
      expect(layers).toHaveLength(2);
      expect(layers[0]).toMatchObject({ unit_cost: "4.0000", total_value: "400.0000" });
      expect(layers[1]).toMatchObject({ unit_cost: "12.0000", total_value: "600.0000" });
    });

    it("produces layer costs that sum to merchandise plus freight", async () => {
      const result = await applyVoucher(voucherId);

      expect(result).toMatchObject({
        status: "APPLIED",
        chargeTotal: "100.0000",
        capitalisedValue: "100.0000",
        expensedValue: "0.0000",
        layersRevalued: 2,
      });

      const layers = await layersFor(grnId);
      // 400.00 + 40.00 = 440.00 over 100 units; 600.00 + 60.00 = 660.00 over 50.
      expect(layers[0]).toMatchObject({
        unit_cost: "4.4000",
        total_value: "440.0000",
        remaining_value: "440.0000",
        remaining_quantity: "100.0000",
      });
      expect(layers[1]).toMatchObject({
        unit_cost: "13.2000",
        total_value: "660.0000",
        remaining_value: "660.0000",
        remaining_quantity: "50.0000",
      });

      // The sentence the unit is written against, asserted as one figure.
      const held = layers.reduce(
        (sum, layer) => sum + Math.round(Number(layer.remaining_value) * 10000),
        0,
      );
      expect(held).toBe(11_000_000); // 1100.0000 = 1000.00 merchandise + 100.00 freight
    });

    it("records where every fraction of the charge went", async () => {
      const allocations = await allocationsFor(voucherId);
      expect(allocations).toHaveLength(2);
      expect(allocations[0]).toMatchObject({
        allocated_value: "40.0000",
        capitalised_value: "40.0000",
        expensed_value: "0.0000",
        unit_cost_before: "4.0000",
        unit_cost_after: "4.4000",
      });
      expect(allocations[1]).toMatchObject({
        allocated_value: "60.0000",
        capitalised_value: "60.0000",
        expensed_value: "0.0000",
        unit_cost_before: "12.0000",
        unit_cost_after: "13.2000",
      });

      const voucher = await voucherRow(voucherId);
      expect(voucher).toMatchObject({
        status: "APPLIED",
        charge_total_cents: "10000",
        capitalised_value: "100.0000",
        expensed_value: "0.0000",
      });
    });

    it("makes a later issue consume the true cost, not the invoice line", async () => {
      // 100 units of the cheap SKU, all from the one layer this receipt made.
      // At the landed rate that is 100 x 4.40 = 440.00. At the invoice line's
      // 4.00 it would have been 400.00, and that is the number this feature
      // exists to stop being reported as cost of sales.
      const tag = `after-${randomUUID().slice(0, 8)}`;
      await issue(scene.cheapId, "100.0000", tag);
      const { movement, drawn } = await issueCost(tag);

      expect(movement.total_cost).toBe("440.0000");
      expect(movement.unit_cost).toBe("4.4000");
      expect(drawn.layers).toBe(1);
      expect(drawn.drawn).toBe("440.0000");

      // The number it is not.
      expect(Number(movement.total_cost)).not.toBe(400);
    });

    it("refuses to apply the same voucher twice, and replays a retry of the first", async () => {
      // A second attempt under a fresh key is a second application, and would
      // put the freight in twice with no movement to reverse it.
      await expect(applyVoucher(voucherId)).rejects.toThrow(ConflictException);

      // The same key is a retry of one application, not a second one.
      const key = `lc-replay-${randomUUID()}`;
      const secondGrn = await (async () => {
        const order = await sentOrder([
          { variantId: scene.batchedId, quantity: 10, unitCost: "5.0000" },
        ]);
        return (await receive(order.poId, [
          {
            poLineId: order.poLineIds[0],
            quantityReceived: "10",
            lotNumber: `BATCH-${randomUUID().slice(0, 6)}`,
            expiryDate: "2027-06-30",
          },
        ])) as { id: number };
      })();
      const replayVoucher = (await createVoucher(secondGrn.id, 2_500)).id;

      const first = await applyVoucher(replayVoucher, key);
      const again = await applyVoucher(replayVoucher, key);
      expect(again).toEqual(first);

      const allocations = await allocationsFor(replayVoucher);
      expect(allocations).toHaveLength(1);
      // 25.00 over 10 units: 50.00 + 25.00 = 75.00, so 7.50 each.
      expect(allocations[0]).toMatchObject({
        allocated_value: "25.0000",
        capitalised_value: "25.0000",
        unit_cost_before: "5.0000",
        unit_cost_after: "7.5000",
      });
    }, 120_000);
  });

  describe("freight that arrives after the goods have started moving", () => {
    it("capitalises onto what is left and expenses what belongs to units already gone", async () => {
      const order = await sentOrder([
        { variantId: scene.lateCheapId, quantity: 100, unitCost: "4.0000" },
        { variantId: scene.lateDearId, quantity: 50, unitCost: "12.0000" },
      ]);
      const grn = (await receive(order.poId, [
        { poLineId: order.poLineIds[0], quantityReceived: "100" },
        { poLineId: order.poLineIds[1], quantityReceived: "50" },
      ])) as { id: number };

      // 60 units shipped before the carrier invoiced. That sale is on the books
      // at 4.00 and the ledger is append-only, so its cost cannot be restated.
      const beforeTag = `before-${randomUUID().slice(0, 8)}`;
      await issue(scene.lateCheapId, "60.0000", beforeTag);
      expect((await issueCost(beforeTag)).movement.total_cost).toBe("240.0000");

      const voucherId = (await createVoucher(grn.id, 10_000)).id;
      const result = await applyVoucher(voucherId);

      // The allocation is still 40.00 / 60.00, because the freight was charged
      // on what was delivered. Of the cheap layer's 40.00 only 40% — 16.00 —
      // can still reach stock; the other 24.00 is a cost of this period.
      expect(result).toMatchObject({
        chargeTotal: "100.0000",
        capitalisedValue: "76.0000",
        expensedValue: "24.0000",
      });

      const allocations = await allocationsFor(voucherId);
      expect(allocations[0]).toMatchObject({
        allocated_value: "40.0000",
        capitalised_value: "16.0000",
        expensed_value: "24.0000",
        remaining_quantity: "40.0000",
        unit_cost_before: "4.0000",
        unit_cost_after: "4.4000",
      });
      expect(allocations[1]).toMatchObject({
        allocated_value: "60.0000",
        capitalised_value: "60.0000",
        expensed_value: "0.0000",
      });

      const layers = await layersFor(grn.id);
      // 160.00 held + 16.00 landed = 176.00 over the 40 units left.
      expect(layers[0]).toMatchObject({
        unit_cost: "4.4000",
        remaining_value: "176.0000",
        total_value: "416.0000",
      });

      // And the units still on the shelf now cost the true figure when they go.
      const afterTag = `late-after-${randomUUID().slice(0, 8)}`;
      await issue(scene.lateCheapId, "40.0000", afterTag);
      expect((await issueCost(afterTag)).movement.total_cost).toBe("176.0000");
    }, 180_000);
  });

  describe("what it refuses rather than guesses", () => {
    it("will not land a cost on a receipt that has not posted", async () => {
      const order = await sentOrder([
        { variantId: scene.cheapId, quantity: 5, unitCost: "4.0000" },
      ]);
      const draft = await asTenant(() =>
        app.app.get(GrnService).createDraft(scene.orgId, scene.userId, `d-${randomUUID()}`, {
          poId: order.poId,
          receivedDate: "2026-08-02",
          locationId: scene.locationId,
          lines: [{ poLineId: order.poLineIds[0], quantityReceived: "5" }],
        } as never),
      );
      const voucherId = (await createVoucher((draft as { id: number }).id, 1_000)).id;
      await expect(applyVoucher(voucherId)).rejects.toThrow(BadRequestException);
    }, 120_000);

    it("will not silently mis-cost a weighted-average variant", async () => {
      // On weighted average an issue costs at `inv_stock_levels.average_cost`
      // and never looks at the layer, so revaluing the layer would change the
      // valuation report and change nothing an issue actually pays.
      const order = await sentOrder([
        { variantId: scene.averagedId, quantity: 20, unitCost: "9.0000" },
      ]);
      const grn = (await receive(order.poId, [
        { poLineId: order.poLineIds[0], quantityReceived: "20" },
      ])) as { id: number };
      const voucherId = (await createVoucher(grn.id, 5_000)).id;

      await expect(applyVoucher(voucherId)).rejects.toThrow(UnprocessableEntityException);
      expect((await voucherRow(voucherId)).status).toBe("DRAFT");
      const layers = await layersFor(grn.id);
      expect(layers[0]).toMatchObject({ unit_cost: "9.0000", total_value: "180.0000" });
    }, 120_000);

    it("raises one voucher when the create is retried under the same key", async () => {
      // The retry path is not decoration on a financial document: two vouchers
      // for one carrier invoice put the freight through twice the moment
      // somebody applies both, and there is no movement to reverse it with.
      const order = await sentOrder([
        { variantId: scene.dearId, quantity: 2, unitCost: "12.0000" },
      ]);
      const grn = (await receive(order.poId, [
        { poLineId: order.poLineIds[0], quantityReceived: "2" },
      ])) as { id: number };

      const key = `lc-create-retry-${randomUUID()}`;
      const first = await createVoucher(grn.id, 1_234, "VALUE", key);
      const again = await createVoucher(grn.id, 1_234, "VALUE", key);

      expect(again).toEqual(first);
      const [{ n }] = await asTenant(() =>
        db().execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM inv_landed_cost_vouchers
          WHERE org_id = ${scene.orgId} AND grn_id = ${grn.id}`),
      );
      expect(n).toBe(1);

      // And a second charge moves the header total in the same breath, so the
      // voucher can never disagree with the invoices hanging off it.
      const updated = await asTenant(() =>
        app.app.get(LandedCostService).addCharge(scene.orgId, scene.userId, first.id, {
          chargeType: "DUTY",
          description: "Customs assessment",
          amountCents: 766,
        } as never),
      );
      expect(updated.chargeTotalCents).toBe("2000");
    }, 120_000);

    it("gates raising and applying on a key a receiving clerk does not hold", () => {
      // The ladder is enforced in the service; which permission opens each rung
      // is enforced by the controller, and a rung whose key drifted to
      // `purchase-orders:receive` would let anyone who can sign for a pallet
      // restate the balance sheet.
      const keyOf = (method: keyof LandedCostController) =>
        Reflect.getMetadata(REQUIRE_PERMISSION, LandedCostController.prototype[method]) as string;
      expect(keyOf("create")).toBe("inventory:landed-cost:manage");
      expect(keyOf("applyVoucher")).toBe("inventory:landed-cost:manage");
      expect(keyOf("addCharge")).toBe("inventory:landed-cost:manage");
      expect(keyOf("remove")).toBe("inventory:landed-cost:manage");
      // Reads sit behind the key that already governs seeing what stock cost.
      expect(keyOf("list")).toBe("inventory:valuation:read");
      expect(keyOf("get")).toBe("inventory:valuation:read");
    });
  });

  describe("G4 — the label and the documents", () => {
    it("puts a code on the label that the lookup endpoint resolves", async () => {
      const label = await asTenant(() =>
        app.app.get(InvLabelsService).variantLabel(scene.orgId, scene.batchedId),
      );

      expect(label.sku).toBe(scene.batchedSku);
      expect(label.codeSource).toBe("barcode");
      expect(label.qrDataUri.startsWith("data:image/png;base64,")).toBe(true);

      // The whole claim a label makes: scan it back and you get these goods.
      const resolved = await asTenant(() =>
        app.app.get(InvBarcodeService).lookup(scene.orgId, scene.userId, label.code),
      );
      expect(resolved).toMatchObject({ type: "variant", variantId: scene.batchedId });
    }, 120_000);

    it("carries the lot on a batch label, as a GS1 string the scan endpoint reads", async () => {
      const order = await sentOrder([
        { variantId: scene.batchedId, quantity: 4, unitCost: "5.0000" },
      ]);
      const lotNumber = `LOT-${randomUUID().slice(0, 6).toUpperCase()}`;
      const grn = (await receive(order.poId, [
        {
          poLineId: order.poLineIds[0],
          quantityReceived: "4",
          lotNumber,
          expiryDate: "2027-09-30",
        },
      ])) as { id: number };

      const [lot] = await asTenant(() =>
        db().execute<{ id: number }>(sql`
          SELECT id FROM inv_lots
          WHERE org_id = ${scene.orgId} AND lot_number = ${lotNumber}`),
      );

      const label = await asTenant(() =>
        app.app.get(InvLabelsService).variantLabel(scene.orgId, scene.batchedId, Number(lot!.id)),
      );
      expect(label.lot).toMatchObject({ lotNumber, expiryDate: "2027-09-30" });
      expect(label.gs1).not.toBeNull();

      const scanned = await asTenant(() =>
        app.app.get(InvBarcodeService).scan(scene.orgId, scene.userId, label.gs1!),
      );
      expect(scanned.parsed.isGs1).toBe(true);
      expect(scanned.lot).toMatchObject({ lotNumber });
      expect(scanned.variant).toMatchObject({ id: scene.batchedId });
      expect(scanned.warnings).toEqual([]);

      // And the receipt this batch arrived on prints as a PDF carrying the four
      // things the unit names.
      const pdf = await asTenant(() =>
        app.app.get(InvLabelsService).grnNote(scene.orgId, grn.id, scene.userId),
      );
      expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");

      // `pdf-parse` is CommonJS, so under ts-jest it may arrive as the function
      // itself or under `default` depending on interop. Both are handled rather
      // than assumed, because getting it wrong fails as "not a function" in a
      // place that has nothing to do with the document being checked.
      const loaded: unknown = await import("pdf-parse");
      const parsePdf = (
        typeof loaded === "function" ? loaded : (loaded as { default: unknown }).default
      ) as (data: Buffer) => Promise<{ text: string }>;
      const { text } = await parsePdf(pdf);
      expect(text).toContain(scene.orgName);
      expect(text).toContain(scene.vendorName);
      expect(text).toContain(scene.batchedSku);
      expect(text).toContain(lotNumber);
      expect(text).toContain("2027-09-30");
      expect(text).toContain("POSTED");
    }, 180_000);

    it("gates printing on the key the catalogue already reserves for it", () => {
      const keyOf = (method: keyof InvLabelsController) =>
        Reflect.getMetadata(REQUIRE_PERMISSION, InvLabelsController.prototype[method]) as string;
      expect(keyOf("variantLabel")).toBe("inventory:labels:print");
      expect(keyOf("grnNote")).toBe("inventory:labels:print");
      expect(keyOf("pickList")).toBe("inventory:labels:print");
    });
  });

  /**
   * INV-38 — the half of "apply + accounting contract" that nothing asserted.
   *
   * Everything above this point proves the costing: the apportionment, the
   * layers, the audit trail, the split when freight lands after the goods have
   * moved. None of it looks at `journal_entries`, and until this block no test
   * anywhere in `test/` did — `grep -rn "ledger_accounts\|journal_entries" test/`
   * returned nothing, so the *posted* side of the accounting bridge was
   * unmeasured across the whole module, not only for landed cost.
   *
   * Two behaviours, and the second is the one a reader would assume was covered:
   *
   *   1. With no chart of accounts, `postJournalEntry` skips with a warning and
   *      the freight still reaches the layers. That is a deliberate decision —
   *      a receipt is a physical fact and a bookkeeping gap must not refuse it —
   *      and a decision nobody had checked holds.
   *   2. With one, the entry is actually written, names 1300 / 5000 / 2000, and
   *      balances.
   *
   * **This block runs last on purpose.** The chart of accounts is per-tenant and
   * the scene is one tenant, so seeding it is a one-way door for every `apply`
   * after it. The blocks above are written against the no-accounts state and
   * would start posting journals if this ran first.
   *
   * The credit is the payable, not a clearing account. INV-38's acceptance line
   * says "clearing account correct" and this asserts 2000 instead: a clearing
   * account sits between an accrual and the bill that settles it, and this
   * voucher *is* the bill — its charges carry the carrier's own vendor and
   * reference, and nothing in finance or accounting would ever debit the other
   * side. See `PAYABLE_ACCOUNT` in `landed-cost-apply.service.ts`. The test
   * therefore records what the code does and why, rather than asserting an
   * account that does not exist.
   */
  describe("INV-38 — the journal the apply claims to post", () => {
    describe("before the tenant has a chart of accounts", () => {
      it("lands the freight on the layers and writes no journal at all", async () => {
        // The two preconditions, asserted rather than assumed. Without them a
        // missing entry proves nothing: it would also be missing if accounting
        // were not migrated into this database, and that is a different answer
        // the bridge gives for a different reason.
        expect(await ledgerAccountCount()).toBe(0);
        expect(
          await asTenant(() => app.app.get(InventoryAccountingBridge).hasJournals()),
        ).toBe(true);

        const order = await sentOrder([
          { variantId: scene.glSkipId, quantity: 20, unitCost: "5.0000" },
        ]);
        const grn = (await receive(order.poId, [
          { poLineId: order.poLineIds[0], quantityReceived: "20" },
        ])) as { id: number };

        // 100.00 of goods, 20.00 of freight, nothing issued: 120.00 over 20.
        const voucherId = (await createVoucher(grn.id, 2_000)).id;
        expect(await applyVoucher(voucherId)).toMatchObject({
          status: "APPLIED",
          chargeTotal: "20.0000",
          capitalisedValue: "20.0000",
          expensedValue: "0.0000",
        });

        // The stock side happened in full...
        const layers = await layersFor(grn.id);
        expect(layers[0]).toMatchObject({
          unit_cost: "6.0000",
          total_value: "120.0000",
          remaining_value: "120.0000",
        });

        // ...and the ledger side did not, which is the documented bargain.
        expect((await journalFor(voucherId)).entry).toBeNull();
      }, 180_000);
    });

    describe("once the tenant has one", () => {
      beforeAll(async () => {
        await asTenant(() =>
          app.app.get(JournalPostingService).seedChartOfAccountsForOrg(scene.orgId),
        );
      }, 120_000);

      it("seeds the codes the inventory posting rules name", async () => {
        // The block below is only meaningful if these three exist; a journal
        // missing because 1300 was never seeded looks exactly like a journal
        // missing because the posting broke.
        const codes = await asTenant(() =>
          db().execute<{ code: string }>(sql`
            SELECT code FROM ledger_accounts
            WHERE org_id = ${scene.orgId} AND code IN ('1300', '2000', '5000')
            ORDER BY code`),
        );
        expect(codes.map((row) => row.code)).toEqual(["1300", "2000", "5000"]);
      });

      it("debits inventory and credits the payable when nothing has shipped", async () => {
        // 400.00 of goods, 50.00 of freight, all 40 units still on the shelf.
        // 450.00 over 40 is 11.25, so the whole charge capitalises.
        const order = await sentOrder([
          { variantId: scene.glOnHandId, quantity: 40, unitCost: "10.0000" },
        ]);
        const grn = (await receive(order.poId, [
          { poLineId: order.poLineIds[0], quantityReceived: "40" },
        ])) as { id: number };

        const voucherId = (await createVoucher(grn.id, 5_000)).id;
        expect(await applyVoucher(voucherId)).toMatchObject({
          capitalisedValue: "50.0000",
          expensedValue: "0.0000",
        });
        expect((await layersFor(grn.id))[0]).toMatchObject({
          unit_cost: "11.2500",
          total_value: "450.0000",
        });

        const { entry, lines } = await journalFor(voucherId);
        expect(entry).toMatchObject({
          source_event: "apply",
          status: "POSTED",
          entry_date: today(),
        });

        // Two lines, not three. A zero COGS line is omitted rather than posted,
        // so the common case reads as the two-line entry it is.
        expect(lines).toEqual([
          expect.objectContaining({ account_code: "1300", debit: "50.0000", credit: "0.0000" }),
          expect.objectContaining({ account_code: "2000", debit: "0.0000", credit: "50.0000" }),
        ]);
      }, 180_000);

      it("splits the debit across inventory and cost of sales when some has, and still balances", async () => {
        // 400.00 of goods over 100 units, 60 of them shipped before the carrier
        // invoiced, then 100.00 of freight.
        //
        //   capitalisable  100.00 x 40/100        =  40.00
        //   layer          160.00 held + 40.00    = 200.00 over 40 = 5.0000
        //   expensed       100.00 - 40.00         =  60.00
        //
        // The 60.00 can never reach stock: those units are gone and their sale
        // is already on the books at 4.00 in an append-only ledger. It is a cost
        // of the period the freight bill landed in, and 5000 is where it goes.
        const order = await sentOrder([
          { variantId: scene.glShippedId, quantity: 100, unitCost: "4.0000" },
        ]);
        const grn = (await receive(order.poId, [
          { poLineId: order.poLineIds[0], quantityReceived: "100" },
        ])) as { id: number };

        const shipped = `gl-shipped-${randomUUID().slice(0, 8)}`;
        await issue(scene.glShippedId, "60.0000", shipped);
        expect((await issueCost(shipped)).movement.total_cost).toBe("240.0000");

        const voucherId = (await createVoucher(grn.id, 10_000)).id;
        expect(await applyVoucher(voucherId)).toMatchObject({
          chargeTotal: "100.0000",
          capitalisedValue: "40.0000",
          expensedValue: "60.0000",
        });

        const { entry, lines } = await journalFor(voucherId);
        expect(entry).not.toBeNull();
        expect(lines).toEqual([
          expect.objectContaining({ account_code: "1300", debit: "40.0000", credit: "0.0000" }),
          expect.objectContaining({ account_code: "5000", debit: "60.0000", credit: "0.0000" }),
          expect.objectContaining({ account_code: "2000", debit: "0.0000", credit: "100.0000" }),
        ]);

        // The identity the whole feature rests on, asserted on the ledger rows
        // themselves rather than on what `apply` said it did. Summed in integer
        // ten-thousandths: these columns are numeric(18,4) and comparing them as
        // floats is the arithmetic this module bans everywhere else.
        const scaled = (v: string) => Math.round(Number(v) * 10_000);
        const debits = lines.reduce((sum, line) => sum + scaled(line.debit), 0);
        const credits = lines.reduce((sum, line) => sum + scaled(line.credit), 0);
        expect(debits).toBe(credits);
        expect(debits).toBe(1_000_000); // 100.0000, the voucher's charge total

        // And what the freight did reach is what the next issue draws at.
        const after = `gl-after-${randomUUID().slice(0, 8)}`;
        await issue(scene.glShippedId, "40.0000", after);
        expect((await issueCost(after)).movement.total_cost).toBe("200.0000");
      }, 180_000);
    });
  });
});
