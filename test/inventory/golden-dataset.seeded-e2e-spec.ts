import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { InvStockService, type StockLevelItem } from "src/modules/inventory/stock/inv-stock.service";
import { InvReconciliationService } from "src/modules/inventory/reconciliation/inv-reconciliation.service";
import { InvTraceabilityService } from "src/modules/inventory/traceability/inv-traceability.service";
import { PackagesService } from "src/modules/inventory/shipments/packages.service";
import { CustomerReturnsService } from "src/modules/inventory/returns/customer-returns.service";
import { VendorReturnsService } from "src/modules/inventory/returns/vendor-returns.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";
import { buildInventoryFixture, type InventoryFixture } from "test/helpers/inventory-fixture";
import { RecallsService } from "src/modules/inventory/quality/quality-recalls.service";

/**
 * INV-103 — the golden dataset, and every reader agreeing with it.
 *
 * The dataset is built through the real stock engine, so ledger and projection
 * agree by construction. What these tests check is the layer above: that the
 * stock list, the availability endpoint, the movement history, the reservation
 * totals and the reconciliation report all describe the same 420 units — and
 * that a second tenant holding identically-named SKUs is invisible to the first.
 *
 *   pnpm test:e2e:seeded --testPathPattern=golden-dataset
 */

/**
 * Stock rows carry the camelCase keys the client parses, with each quantity a
 * decimal string.
 *
 * This summed `row.on_hand` and said so in a comment: the read was a raw
 * `db.execute`, so what reached the wire was the driver's own column names and
 * the browser rendered `NaN` in every quantity column. The spec agreed with the
 * defect. Reading `onHand` is now the assertion that it is gone.
 */
function sumOnHand(rows: readonly StockLevelItem[]): number {
  return rows.reduce((sum, row) => sum + Number(row.onHand), 0);
}

const SCOPE_ALL = "inventory:warehouses:scope-all";
const INVENTORY_READS = [SCOPE_ALL, "inventory:stock:read", "inventory:stock:reconcile", "inventory:stock:reserve"] as const;

describe("[seeded-e2e] the golden inventory dataset", () => {
  let seededApp: SeededE2eApp;
  let fixture: InventoryFixture;
  const teardowns: Array<() => Promise<void>> = [];

  const asTenant = <T>(orgId: string, work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(seededApp.app.get<Db>(DRIZZLE), orgId, work);

  beforeAll(async () => {
    seededApp = await createSeededE2eApp();

    const seeded = await seedOrg(seededApp.seedDb)
      .onPlan("PAID")
      .addMember("keeper", { permissionKeys: INVENTORY_READS })
      .build();
    teardowns.push(() => seeded.teardown());

    fixture = await buildInventoryFixture(
      seededApp.app,
      seeded.orgId,
      seeded.members.keeper!.userId,
      "g1",
    );
  }, 180_000);

  afterAll(async () => {
    for (const teardown of teardowns) await teardown().catch(() => undefined);
    await seededApp.close();
  });

  describe("the ledger", () => {
    it("wrote exactly the movements the dataset describes", async () => {
      const rows = await asTenant(fixture.orgId, () =>
        seededApp.app.get<Db>(DRIZZLE).execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM inv_stock_transactions WHERE org_id = ${fixture.orgId}`),
      );
      expect(rows[0]!.n).toBe(fixture.expected.ledgerRows);
    });

    it("sums to the same on-hand the projection holds", async () => {
      const rows = await asTenant(fixture.orgId, () =>
        seededApp.app.get<Db>(DRIZZLE).execute<{ ledger: string; projection: string }>(sql`
          SELECT
            (SELECT COALESCE(SUM(quantity_change), 0)::text FROM inv_stock_transactions
              WHERE org_id = ${fixture.orgId} AND quantity_bucket = 'ON_HAND') AS ledger,
            (SELECT COALESCE(SUM(on_hand), 0)::text FROM inv_stock_levels
              WHERE org_id = ${fixture.orgId}) AS projection`),
      );
      expect(Number(rows[0]!.ledger)).toBe(Number(fixture.expected.totalOnHand));
      expect(Number(rows[0]!.projection)).toBe(Number(fixture.expected.totalOnHand));
    });

    it("keeps the quality hold out of on-hand and in its own bucket", async () => {
      const rows = await asTenant(fixture.orgId, () =>
        seededApp.app.get<Db>(DRIZZLE).execute<{ held: string; on_hand: string }>(sql`
          SELECT COALESCE(SUM(quality_hold_qty), 0)::text AS held,
                 COALESCE(SUM(on_hand), 0)::text AS on_hand
          FROM inv_stock_levels WHERE org_id = ${fixture.orgId} AND lot_id = ${fixture.lots.lotA}`),
      );
      // A hold marks part of what is physically present as unsellable. It does
      // not remove it from on_hand — availability is what subtracts it.
      expect(Number(rows[0]!.held)).toBe(Number(fixture.expected.qualityHeld));
      expect(Number(rows[0]!.on_hand)).toBe(Number(fixture.expected.onHand.gadgetLotA));
    });
  });

  describe("the readers", () => {
    it("the stock list adds up to the dataset", async () => {
      const stock = seededApp.app.get(InvStockService);
      const result = await asTenant(fixture.orgId, () =>
        stock.listStockLevels(fixture.orgId, fixture.userId, { page: 1, limit: 100 }),
      );
      const total = sumOnHand(result.items);
      expect(total).toBe(Number(fixture.expected.totalOnHand));
    });

    it("availability subtracts the reservation from on-hand", async () => {
      const stock = seededApp.app.get(InvStockService);
      const result = await asTenant(fixture.orgId, () =>
        stock.getAvailability(fixture.orgId, fixture.userId, {
          variantId: fixture.variants.widget.variantId,
          warehouseId: fixture.warehouses.main,
        }),
      );
      expect(Number(result.available)).toBe(Number(fixture.expected.widgetAvailable));
    });

    it("the movement history returns every ledger row", async () => {
      const stock = seededApp.app.get(InvStockService);
      const result = await asTenant(fixture.orgId, () =>
        stock.listTransactions(fixture.orgId, fixture.userId, { page: 1, limit: 100 }),
      );
      expect(result.total).toBe(fixture.expected.ledgerRows);
    });

    it("the reservation is the only thing committed", async () => {
      const rows = await asTenant(fixture.orgId, () =>
        seededApp.app.get<Db>(DRIZZLE).execute<{ committed: string; reserved: string }>(sql`
          SELECT
            (SELECT COALESCE(SUM(committed), 0)::text FROM inv_stock_levels WHERE org_id = ${fixture.orgId}) AS committed,
            (SELECT COALESCE(SUM(reserved_qty), 0)::text FROM inv_stock_reservations
              WHERE org_id = ${fixture.orgId} AND status = 'ACTIVE') AS reserved`),
      );
      expect(Number(rows[0]!.committed)).toBe(Number(fixture.expected.committed));
      expect(Number(rows[0]!.reserved)).toBe(Number(fixture.expected.committed));
    });
  });

  describe("reconciliation", () => {
    it("finds nothing to reconcile on a dataset the engine built", async () => {
      const reconciliation = seededApp.app.get(InvReconciliationService);
      const report = await asTenant(fixture.orgId, () =>
        reconciliation.report(fixture.orgId, fixture.userId, { limit: 100 }),
      );
      // The strongest single assertion in this file: every ledger-derived bucket
      // matches its movements, and committed matches its reservations.
      expect(report.drift).toEqual([]);
      expect(report.driftCount).toBe(0);
    });

    it("sees drift the moment the projection is edited behind the engine's back", async () => {
      const db = seededApp.app.get<Db>(DRIZZLE);
      const reconciliation = seededApp.app.get(InvReconciliationService);
      await asTenant(fixture.orgId, async () => {
        await db.execute(sql`
          UPDATE inv_stock_levels SET on_hand = on_hand + 7
          WHERE org_id = ${fixture.orgId} AND product_variant_id = ${fixture.variants.widget.variantId}`);
      });
      try {
        const report = await asTenant(fixture.orgId, () =>
          reconciliation.report(fixture.orgId, fixture.userId, { limit: 100 }),
        );
        const widget = report.drift.find((row) => row.productVariantId === fixture.variants.widget.variantId);
        expect(widget).toBeDefined();
        expect(Number(widget!.difference)).toBe(7);
      } finally {
        await asTenant(fixture.orgId, async () => {
          await db.execute(sql`
            UPDATE inv_stock_levels SET on_hand = on_hand - 7
            WHERE org_id = ${fixture.orgId} AND product_variant_id = ${fixture.variants.widget.variantId}`);
        });
      }
    });
  });

  describe("warehouse scope", () => {
    /**
     * These lists were unscoped until INV-109, and each is now filtered through
     * whatever carries the warehouse — a serial by its location, a package by
     * its shipment, a customer return by its order or shipment, a vendor return
     * by its receipt, and (third pass) a lot by the stock it holds, a recall by
     * the lots its lines name. Scope predicates are raw SQL fragments, so a
     * malformed one only fails when it runs, and a service whose module never
     * imported the provider it injects type-checks perfectly and cannot boot.
     * Calling each once is what proves both.
     */
    it("every newly scoped list executes and stays inside the tenant", async () => {
      // Every one of these returns a differently-shaped page, and the loop below

      // asserts only that each has an `items` array — so the array's type is that

      // shared contract rather than a union TypeScript cannot reconcile.

      const lists: Array<() => Promise<{ items: unknown[] }>> = [
        () => seededApp.app.get(InvTraceabilityService).listSerials(fixture.orgId, fixture.userId, { page: 1, limit: 50 }),
        () => seededApp.app.get(PackagesService).list(fixture.orgId, fixture.userId, { page: 1, limit: 50 }),
        () => seededApp.app.get(CustomerReturnsService).list(fixture.orgId, fixture.userId, { page: 1, limit: 50 }),
        () => seededApp.app.get(VendorReturnsService).list(fixture.orgId, fixture.userId, { page: 1, limit: 50 }),
        () => seededApp.app.get(InvTraceabilityService).listLots(fixture.orgId, fixture.userId, { page: 1, limit: 50 }),
        () => seededApp.app.get(RecallsService).list(fixture.orgId, fixture.userId, { page: 1, limit: 50 }),
      ];
      for (const read of lists) {
        const result = await asTenant(fixture.orgId, read);
        expect(Array.isArray(result.items)).toBe(true);
      }
    });
  });

  describe("tenant isolation", () => {
    it("hides a second tenant's identically-named SKUs", async () => {
      const other = await seedOrg(seededApp.seedDb)
        .onPlan("PAID")
        .addMember("keeper", { permissionKeys: INVENTORY_READS })
        .build();
      teardowns.push(() => other.teardown());

      // Deliberately the same product names and a parallel dataset. If anything
      // leaks, the first tenant's totals move.
      const second = await buildInventoryFixture(
        seededApp.app,
        other.orgId,
        other.members.keeper!.userId,
        "g2",
      );

      const stock = seededApp.app.get(InvStockService);
      const first = await asTenant(fixture.orgId, () =>
        stock.listStockLevels(fixture.orgId, fixture.userId, { page: 1, limit: 100 }),
      );
      const firstTotal = sumOnHand(first.items);
      expect(firstTotal).toBe(Number(fixture.expected.totalOnHand));

      const secondReport = await asTenant(second.orgId, () =>
        stock.listStockLevels(second.orgId, second.userId, { page: 1, limit: 100 }),
      );
      const secondTotal = sumOnHand(secondReport.items);
      expect(secondTotal).toBe(Number(second.expected.totalOnHand));

      const firstIds = new Set(first.items.map((row) => Number(row.id)));
      const overlap = secondReport.items.filter((row) => firstIds.has(Number(row.id)));
      expect(overlap).toEqual([]);
    });
  });
});
