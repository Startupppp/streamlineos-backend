import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { HandlingUnitService } from "src/modules/inventory/handling-units/handling-unit.service";
import { RecallsService } from "src/modules/inventory/quality/quality-recalls.service";
import { ReservationService } from "src/modules/inventory/stock-engine/reservation.service";
import { OwnershipService } from "src/modules/inventory/stock-types/ownership.service";
import { InvReconciliationService } from "src/modules/inventory/reconciliation/inv-reconciliation.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * INV-18 — a consigned, handling-unit-controlled pallet through receive, move,
 * pick and recall, proving neither grain component is ever collapsed.
 *
 * The two components exist for opposite reasons and fail in opposite ways.
 * Losing the **handling unit** merges a pallet's twelve with four loose on the
 * same shelf, and the total still adds up, so nothing complains. Losing
 * **ownership** takes a supplier's goods onto our books, and the total still
 * adds up there too.
 *
 * This found a live defect. `HandlingUnitService.move` selected five of the six
 * key components and built both transfer legs without `ownership`, so every
 * movement defaulted to `OWNED`. Moving a consigned pallet decremented an owned
 * row that did not hold the goods; and a pallet carrying an owned *and* a
 * consigned grain of one variant produced two movements `levelKey` could not
 * tell apart, which posted twice against the owned row and never touched the
 * vendor's. `check:stock-writers` could not see it: that gate reads writers,
 * and this is a caller of the kernel, not a writer.
 *
 *   pnpm test:e2e:seeded --testPathPattern=consigned-handling-unit-grain
 */

const PERMISSIONS = [
  "inventory:warehouses:scope-all",
  "inventory:stock:read",
  "inventory:stock:adjust",
  "inventory:stock:reserve",
  "inventory:stock:reconcile",
  "inventory:quality:read",
  "inventory:quality:recall",
  // Handling units are authorized as stock, not as a namespace of their own:
  // `handling-units.controller.ts` reads with `inventory:stock:read` and moves
  // with `inventory:stock:transfer`. `inventory:handling-units:manage` was a
  // key that has never existed in the catalogue, and the FK on
  // `role_permission_grants.permission_key` refuses it — which is what made
  // this suite red the first time the whole of `test/inventory` was run.
  "inventory:stock:transfer",
] as const;

/** On the pallet, and the supplier's. */
const CONSIGNED_ON_PALLET = "60.0000";
/** On the same pallet, same variant and lot, and ours. */
const OWNED_ON_PALLET = "25.0000";
/** Loose in the same bin, ours, no pallet. */
const OWNED_LOOSE = "18.0000";

interface Scene {
  orgId: string;
  userId: string;
  variantId: number;
  warehouseId: number;
  dock: number;
  aisle: number;
  lotId: number;
  palletId: number;
}

interface Row extends Record<string, unknown> {
  location_id: number;
  handling_unit_id: number | null;
  ownership: string;
  on_hand: string;
  committed: string;
}

describe("[seeded-e2e] INV-18 — consigned, handling-unit-controlled stock keeps its grain", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;
  let tag: string;

  const db = () => app.app.get<Db>(DRIZZLE);
  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(db(), scene.orgId, work);

  /**
   * Every row of this variant, keyed the way `inv_stock_levels` keys them. The
   * whole point is that three rows exist where a collapsed grain would leave
   * one or two, so the shape of this list is the assertion.
   */
  const rows = (): Promise<Row[]> =>
    asTenant(async () => {
      const out = await db().execute<Row>(sql`
        SELECT location_id, handling_unit_id, ownership::text AS ownership, on_hand, committed
          FROM inv_stock_levels
         WHERE org_id = ${scene.orgId} AND product_variant_id = ${scene.variantId}
           AND on_hand <> 0
         ORDER BY location_id, ownership, handling_unit_id NULLS FIRST`);
      return [...out];
    });

  const describeRows = (list: Row[]) =>
    list.map((r) => ({
      location: r.location_id,
      hu: r.handling_unit_id,
      ownership: r.ownership,
      onHand: r.on_hand,
    }));

  const expectReconciled = async (): Promise<void> => {
    const report = await asTenant(() =>
      app.app.get(InvReconciliationService).report(scene.orgId, scene.userId, { limit: 100 }),
    );
    expect(report.drift).toEqual([]);
  };

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("keeper", { permissionKeys: PERMISSIONS })
      .build();
    teardown = () => seeded.teardown();

    tag = randomUUID().slice(0, 6);
    const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
      (await db().execute<T>(q))[0]!;

    scene = await runInNewTenantTransaction(db(), seeded.orgId, async () => {
      const userId = seeded.members["keeper"]!.userId;
      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, tracking_method, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Consigned goods', ${`CG-${tag}`}, 'LOT', ${userId})
        RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`CG-${tag}-V`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Main', ${`CGW${tag}`}, ${userId}) RETURNING id`);
      const dock = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Dock', ${`CGD${tag}`}, 'BIN', true) RETURNING id`);
      const aisle = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable, is_pickable)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Aisle', ${`CGA${tag}`}, 'BIN', true, true) RETURNING id`);
      const lot = await one<{ id: number }>(sql`
        INSERT INTO inv_lots (org_id, product_variant_id, lot_number, status, expiry_date)
        VALUES (${seeded.orgId}, ${variant.id}, ${`L-CG-${tag}`}, 'ACTIVE', '2027-06-01') RETURNING id`);
      return {
        orgId: seeded.orgId,
        userId,
        variantId: variant.id,
        warehouseId: warehouse.id,
        dock: dock.id,
        aisle: aisle.id,
        lotId: lot.id,
        palletId: 0,
      };
    });
  }, 600_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app?.close();
  }, 600_000);

  describe("receive — one bin, one variant, one lot, three different rows", () => {
    it("raises a pallet to receive onto", async () => {
      const created = await asTenant(() =>
        app.app.get(HandlingUnitService).create(
          scene.orgId,
          scene.userId,
          { huCode: `PAL-${tag}`, kind: "PALLET", locationId: scene.dock },
          `cg-hu-${tag}`,
        ),
      );
      scene.palletId = created.handlingUnitId;
      expect(scene.palletId).toBeGreaterThan(0);
    }, 300_000);

    it("receives the supplier's cartons onto the pallet, and ours beside them", async () => {
      // Three receipts that differ only in the two components under test. If
      // either were dropped these would merge, and every quantity below would
      // still add up to 103 — which is exactly why totals are not the assertion.
      await asTenant(() =>
        app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
          idempotencyKey: `cg-recv-${tag}`,
          sourceType: "inv_grn",
          sourceId: `cg-recv-${tag}`,
          movements: [
            {
              transactionType: "PURCHASE",
              productVariantId: scene.variantId,
              locationId: scene.dock,
              lotId: scene.lotId,
              handlingUnitId: scene.palletId,
              ownership: "VENDOR",
              quantityDelta: CONSIGNED_ON_PALLET,
              unitCost: "4.0000",
            },
            {
              transactionType: "PURCHASE",
              productVariantId: scene.variantId,
              locationId: scene.dock,
              lotId: scene.lotId,
              handlingUnitId: scene.palletId,
              ownership: "OWNED",
              quantityDelta: OWNED_ON_PALLET,
              unitCost: "4.0000",
            },
            {
              transactionType: "PURCHASE",
              productVariantId: scene.variantId,
              locationId: scene.dock,
              lotId: scene.lotId,
              handlingUnitId: null,
              ownership: "OWNED",
              quantityDelta: OWNED_LOOSE,
              unitCost: "4.0000",
            },
          ],
        }),
      );

      expect(describeRows(await rows())).toEqual([
        { location: scene.dock, hu: null, ownership: "OWNED", onHand: OWNED_LOOSE },
        { location: scene.dock, hu: scene.palletId, ownership: "OWNED", onHand: OWNED_ON_PALLET },
        { location: scene.dock, hu: scene.palletId, ownership: "VENDOR", onHand: CONSIGNED_ON_PALLET },
      ]);
      await expectReconciled();
    }, 300_000);

    it("does not promise the supplier's stock to a customer", async () => {
      // The consignment gate. On-hand is 103; what may be sold is 43.
      const [row] = await asTenant(() =>
        db().execute<{ on_hand: string; available: string }>(sql`
          SELECT COALESCE(SUM(on_hand), 0)::text AS on_hand,
                 COALESCE(SUM(on_hand - committed - blocked_qty - quality_hold_qty - outgoing_qty)
                          FILTER (WHERE ownership = 'OWNED'), 0)::text AS available
            FROM inv_stock_levels
           WHERE org_id = ${scene.orgId} AND product_variant_id = ${scene.variantId}`),
      );
      expect(Number(row!.on_hand)).toBe(103);
      expect(Number(row!.available)).toBe(43);
    });
  });

  describe("move — the pallet goes to the aisle and takes both ownerships with it", () => {
    it("moves every grain on the pallet without merging any of them", async () => {
      await asTenant(() =>
        app.app.get(HandlingUnitService).move(
          scene.orgId,
          scene.userId,
          scene.palletId,
          { toLocationId: scene.aisle },
          `cg-move-${tag}`,
        ),
      );

      // The loose stock stays on the dock; both pallet rows arrive in the aisle
      // still telling owned from consigned. Before the fix this either refused
      // with INSUFFICIENT_STOCK, or — with negative stock allowed — decremented
      // the owned row twice and left the vendor's 60 sitting on the dock.
      expect(describeRows(await rows())).toEqual([
        { location: scene.dock, hu: null, ownership: "OWNED", onHand: OWNED_LOOSE },
        { location: scene.aisle, hu: scene.palletId, ownership: "OWNED", onHand: OWNED_ON_PALLET },
        { location: scene.aisle, hu: scene.palletId, ownership: "VENDOR", onHand: CONSIGNED_ON_PALLET },
      ]);
      await expectReconciled();
    }, 300_000);

    it("reports the ownership of what it is carrying", async () => {
      // An operator reading the pallet's label has to be able to see that most
      // of it belongs to a supplier. The read dropped the column too.
      const detail = await asTenant(() =>
        app.app.get(HandlingUnitService).detail(scene.orgId, scene.palletId),
      );
      expect(
        detail.contents.map((c) => ({ ownership: c.ownership, onHand: c.onHand })).sort((a, b) =>
          a.ownership.localeCompare(b.ownership),
        ),
      ).toEqual([
        { ownership: "OWNED", onHand: OWNED_ON_PALLET },
        { ownership: "VENDOR", onHand: CONSIGNED_ON_PALLET },
      ]);
    });

    it("posts the move as paired legs at each grain, not as one netted movement", async () => {
      const [row] = await asTenant(() =>
        db().execute<{ outs: number; ins: number }>(sql`
          SELECT
            count(*) FILTER (WHERE transaction_type = 'TRANSFER_OUT')::int AS outs,
            count(*) FILTER (WHERE transaction_type = 'TRANSFER_IN')::int  AS ins
          FROM inv_stock_transactions
          WHERE org_id = ${scene.orgId}
            AND product_variant_id = ${scene.variantId}
            AND handling_unit_id = ${scene.palletId}`),
      );
      // Two grains on the pallet, so two out legs and two in legs. One of each
      // would mean the two ownerships had been folded into a single movement.
      expect(row!.outs).toBe(2);
      expect(row!.ins).toBe(2);
    });
  });

  describe("pick — a reservation cannot reach the supplier's pallet", () => {
    it("refuses to commit more than the owned stock, however much is on the shelf", async () => {
      // 103 units of this variant are in the building and 43 are ours. Asking
      // for 50 must fail on the consignment gate, not succeed by counting the
      // vendor's 60.
      await expect(
        asTenant(() =>
          app.app.get(ReservationService).createReservation(scene.orgId, scene.userId, {
            sourceType: "inv18-probe",
            sourceId: `cg-res-over-${tag}`,
            productVariantId: scene.variantId,
            warehouseId: scene.warehouseId,
            qty: "50.0000",
          }),
        ),
      ).rejects.toThrow();

      const committed = (await rows()).map((r) => r.committed);
      expect(committed).toEqual(["0.0000", "0.0000", "0.0000"]);
    }, 300_000);

    it("commits against the owned rows only, and leaves the vendor's untouched", async () => {
      await asTenant(() =>
        app.app.get(ReservationService).createReservation(scene.orgId, scene.userId, {
          sourceType: "inv18-probe",
          sourceId: `cg-res-ok-${tag}`,
          productVariantId: scene.variantId,
          warehouseId: scene.warehouseId,
          qty: "40.0000",
        }),
      );

      const after = await rows();
      const vendorRow = after.find((r) => r.ownership === "VENDOR");
      expect(vendorRow).toBeDefined();
      // The single assertion this whole section exists for.
      expect(vendorRow!.committed).toBe("0.0000");

      const ownedCommitted = after
        .filter((r) => r.ownership === "OWNED")
        .reduce((sum, r) => sum + Number(r.committed), 0);
      expect(ownedCommitted).toBe(40);
      await expectReconciled();
    }, 300_000);
  });

  describe("recall — the lot is held per grain, not per lot", () => {
    it("raises one hold for each of the three rows, each naming its own grain", async () => {
      await asTenant(() =>
        app.app.get(RecallsService).create(
          scene.orgId,
          scene.userId,
          { title: `Consigned recall ${tag}`, lines: [{ lotId: scene.lotId }] },
          `cg-recall-${tag}`,
        ),
      );

      const holds = await asTenant(async () => {
        const out = await db().execute<{
          location_id: number;
          handling_unit_id: number | null;
          ownership: string;
          quantity: string;
        }>(sql`
          SELECT location_id, handling_unit_id, ownership::text AS ownership, quantity
            FROM inv_quality_holds
           WHERE org_id = ${scene.orgId} AND lot_id = ${scene.lotId}
           ORDER BY location_id, ownership, handling_unit_id NULLS FIRST`);
        return [...out];
      });

      // Three rows on the shelf, three holds. A recall that grouped by lot
      // would raise one hold for 103 units and an operator could no longer say
      // whose 103 they were, or which pallet to go and find.
      expect(holds).toEqual([
        { location_id: scene.dock, handling_unit_id: null, ownership: "OWNED", quantity: OWNED_LOOSE },
        { location_id: scene.aisle, handling_unit_id: scene.palletId, ownership: "OWNED", quantity: OWNED_ON_PALLET },
        { location_id: scene.aisle, handling_unit_id: scene.palletId, ownership: "VENDOR", quantity: CONSIGNED_ON_PALLET },
      ]);
      await expectReconciled();
    }, 300_000);

    it("quarantines the consigned units as the supplier's, never as ours", async () => {
      const after = await rows();
      // Every row fully held, and no row's ownership changed on the way.
      expect(
        after.map((r) => ({ ownership: r.ownership, hu: r.handling_unit_id, onHand: r.on_hand })),
      ).toEqual([
        { ownership: "OWNED", hu: null, onHand: OWNED_LOOSE },
        { ownership: "OWNED", hu: scene.palletId, onHand: OWNED_ON_PALLET },
        { ownership: "VENDOR", hu: scene.palletId, onHand: CONSIGNED_ON_PALLET },
      ]);

      const [q] = await asTenant(() =>
        db().execute<{ n: number; vendor: number }>(sql`
          SELECT count(*)::int AS n,
                 count(*) FILTER (WHERE ownership = 'VENDOR')::int AS vendor
            FROM inv_stock_transactions
           WHERE org_id = ${scene.orgId} AND lot_id = ${scene.lotId}
             AND transaction_type = 'QUARANTINE_IN'`),
      );
      expect(q!.n).toBe(3);
      expect(q!.vendor).toBe(1);
    });

    it("still refuses to convert more of the consignment than the supplier left", async () => {
      // Title only passes for stock that is actually there and actually theirs.
      await expect(
        asTenant(() =>
          app.app.get(OwnershipService).convert(
            scene.orgId,
            scene.userId,
            {
              productVariantId: scene.variantId,
              locationId: scene.aisle,
              quantity: "999.0000",
              fromOwnership: "VENDOR",
              toOwnership: "OWNED",
              unitCost: "4.0000",
            },
            `cg-title-over-${tag}`,
          ),
        ),
      ).rejects.toThrow();

      const vendorRow = (await rows()).find((r) => r.ownership === "VENDOR");
      expect(vendorRow!.on_hand).toBe(CONSIGNED_ON_PALLET);
      await expectReconciled();
    }, 300_000);
  });
});
