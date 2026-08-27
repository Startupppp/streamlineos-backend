import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { SoLifecycleService } from "src/modules/inventory/sales-orders/so-lifecycle.service";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * INV-402 / INV-404 — FEFO, and the stock that must never be allocated.
 *
 * Lot eligibility used to live inside `if (strategy === "FEFO")`, and the
 * default strategy is AUTO_ON_CONFIRM — so control fell through to the first
 * stock row it found and expired, blocked and recalled lots were allocatable
 * and shippable in the default configuration, whatever the expiry policy said.
 *
 * Eligibility and ordering are different questions. These probes hold them
 * apart: what may be given to a customer at all, and among what may, which goes
 * first. Every "refuses" case below is run under the default strategy, because
 * that is the configuration the block was missing from.
 *
 *   pnpm test:e2e:seeded --testPathPattern=fefo-expiry
 */

const PERMISSIONS = [
  "inventory:warehouses:scope-all",
  "inventory:stock:read",
  "inventory:stock:adjust",
  "inventory:stock:reserve",
] as const;

/** Dates relative to today, so nothing here rots as the calendar moves. */
function isoOffsetDays(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

interface Lot {
  lotId: number;
  locationId: number;
}

interface Scene {
  orgId: string;
  userId: string;
  variantId: number;
  warehouseId: number;
  soonest: Lot;
  later: Lot;
  expired: Lot;
  recalled: Lot;
  undated: Lot;
}

describe("[seeded-e2e] FEFO allocation and expiry blocks", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  /** The allocator, under a given strategy and expiry policy. */
  const allocate = (strategy: string, expiryPolicy: string, qty = "1.0000") =>
    asTenant(() =>
      app.app
        .get(SoLifecycleService)
        .findAvailableLotForLine(scene.orgId, scene.variantId, scene.warehouseId, qty, strategy, expiryPolicy),
    );

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("keeper", { permissionKeys: PERMISSIONS })
      .build();
    teardown = () => seeded.teardown();

    const tag = randomUUID().slice(0, 6);
    const db = app.app.get<Db>(DRIZZLE);
    const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
      (await db.execute<T>(q))[0]!;

    scene = await runInNewTenantTransaction(db, seeded.orgId, async () => {
      const userId = seeded.members.keeper!.userId;
      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, tracking_method, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Perishable', ${`FEFO-${tag}`}, 'LOT', ${userId}) RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`FEFO-${tag}-V1`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Cold store', ${`CS${tag}`}, ${userId}) RETURNING id`);

      /** Each lot gets its own bin, so a lot is choosable independently. */
      async function lot(
        alias: string,
        expiry: string | null,
        status: string,
      ): Promise<Lot> {
        const location = await one<{ id: number }>(sql`
          INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
          VALUES (${seeded.orgId}, ${warehouse.id}, ${alias}, ${`${alias}${tag}`.slice(0, 20)}, 'BIN') RETURNING id`);
        const row = await one<{ id: number }>(sql`
          INSERT INTO inv_lots (org_id, product_variant_id, lot_number, expiry_date, status)
          VALUES (${seeded.orgId}, ${variant.id}, ${`${alias}-${tag}`}, ${expiry}, ${sql.raw(`'${status}'`)})
          RETURNING id`);
        return { lotId: row.id, locationId: location.id };
      }

      const soonest = await lot("soon", isoOffsetDays(30), "ACTIVE");
      const later = await lot("later", isoOffsetDays(365), "ACTIVE");
      const expired = await lot("expired", isoOffsetDays(-1), "ACTIVE");
      const recalled = await lot("recalled", isoOffsetDays(90), "RECALLED");
      const undated = await lot("undated", null, "ACTIVE");

      return {
        orgId: seeded.orgId,
        userId,
        variantId: variant.id,
        warehouseId: warehouse.id,
        soonest,
        later,
        expired,
        recalled,
        undated,
      };
    });

    // Stock into every lot, through the engine, so the projection is real.
    await runInNewTenantTransaction(db, scene.orgId, async () => {
      const engine = app.app.get(StockEngineService);
      const lots = [scene.soonest, scene.later, scene.expired, scene.recalled, scene.undated];
      await engine.execute(scene.orgId, scene.userId, {
        idempotencyKey: `fefo-seed-${tag}`,
        sourceType: "fefo-fixture",
        sourceId: tag,
        postingDate: isoOffsetDays(0),
        movements: lots.map((l) => ({
          transactionType: "PURCHASE" as const,
          productVariantId: scene.variantId,
          locationId: l.locationId,
          lotId: l.lotId,
          quantityDelta: "10.0000",
          unitCost: "1.0000",
        })),
      });
    });
  }, 180_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  describe("what may be given to a customer at all", () => {
    it("refuses an expired lot under the default strategy, not only under FEFO", async () => {
      // The defect: this check used to run only inside the FEFO branch, so the
      // default AUTO_ON_CONFIRM never reached it and returned the first row it
      // happened to find.
      //
      // Asserted across every strategy rather than once, because "the first row
      // it happened to find" is not deterministic — a single call could avoid
      // the expired lot by luck and prove nothing.
      for (const strategy of ["AUTO_ON_CONFIRM", "MANUAL", "FIFO", "FEFO"]) {
        const chosen = await allocate(strategy, "BLOCK");
        expect(chosen).not.toBeNull();
        expect(chosen!.lotId).not.toBe(scene.expired.lotId);
      }
    });

    it("the expired lot is a real candidate, so refusing it means something", async () => {
      // Without this, every refusal above would also pass against a fixture
      // where the expired lot simply had no stock.
      const rows = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ available: string }>(sql`
          SELECT (on_hand - committed - COALESCE(blocked_qty, 0) - COALESCE(quality_hold_qty, 0))::text AS available
          FROM inv_stock_levels
          WHERE org_id = ${scene.orgId} AND lot_id = ${scene.expired.lotId}`),
      );
      expect(Number(rows[0]!.available)).toBeGreaterThan(0);
    });

    it("refuses a recalled lot whatever the expiry policy says", async () => {
      // A recall is not a warning. ALLOW relaxes expiry, never status.
      for (const policy of ["BLOCK", "WARN", "ALLOW"]) {
        for (const strategy of ["AUTO_ON_CONFIRM", "FEFO", "FIFO", "MANUAL"]) {
          const chosen = await allocate(strategy, policy);
          expect(chosen).not.toBeNull();
          expect(chosen!.lotId).not.toBe(scene.recalled.lotId);
        }
      }
    });

    it("allows an expired lot when the tenant has chosen to", async () => {
      // The block is policy, not a hard-coded refusal. Proven by asking for a
      // quantity only the expired lot can satisfy: under ALLOW it is chosen,
      // under BLOCK there is nothing to choose. Without this the refusals above
      // would pass equally against an allocator that never picks anything
      // expired under any policy — which is a different, wrong behaviour.
      await runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, async () => {
        await app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
          idempotencyKey: `fefo-topup-${randomUUID().slice(0, 8)}`,
          sourceType: "fefo-fixture",
          sourceId: "topup",
          postingDate: isoOffsetDays(0),
          movements: [
            {
              transactionType: "PURCHASE",
              productVariantId: scene.variantId,
              locationId: scene.expired.locationId,
              lotId: scene.expired.lotId,
              quantityDelta: "500.0000",
              unitCost: "1.0000",
            },
          ],
        });
      });

      const allowed = await allocate("MANUAL", "ALLOW", "200.0000");
      expect(allowed).not.toBeNull();
      expect(allowed!.lotId).toBe(scene.expired.lotId);

      const blocked = await allocate("MANUAL", "BLOCK", "200.0000");
      expect(blocked).toBeNull();
    });
  });

  describe("among what may, which goes first", () => {
    it("FEFO takes the lot that expires soonest", async () => {
      const chosen = await allocate("FEFO", "BLOCK");
      expect(chosen!.lotId).toBe(scene.soonest.lotId);
    });

    it("FEFO puts a lot with no expiry date last, not first", async () => {
      // A lot that cannot expire cannot expire first. Sorting nulls to the front
      // would hand out undated stock while dated stock spoiled on the shelf.
      const chosen = await allocate("FEFO", "BLOCK");
      expect(chosen!.lotId).not.toBe(scene.undated.lotId);
    });

    it("FEFO skips the soonest lot once it has no stock left", async () => {
      await runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, async () => {
        await app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
          idempotencyKey: `fefo-drain-${randomUUID().slice(0, 8)}`,
          sourceType: "fefo-fixture",
          sourceId: "drain",
          postingDate: isoOffsetDays(0),
          movements: [
            {
              transactionType: "SALE",
              productVariantId: scene.variantId,
              locationId: scene.soonest.locationId,
              lotId: scene.soonest.lotId,
              quantityDelta: "-10.0000",
            },
          ],
        });
      });

      const chosen = await allocate("FEFO", "BLOCK");
      // The next-soonest, not the drained one and not the undated one.
      expect(chosen!.lotId).toBe(scene.later.lotId);
    });

    it("refuses when no eligible lot holds enough", async () => {
      const chosen = await allocate("FEFO", "BLOCK", "9999.0000");
      expect(chosen).toBeNull();
    });
  });
});
