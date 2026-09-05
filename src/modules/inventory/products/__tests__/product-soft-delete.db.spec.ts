/**
 * INV-107 — deleting a product must not delete its history.
 *
 * inv_stock_transactions.product_variant_id carries ON DELETE CASCADE, and
 * fifteen other tables do too. The service's guard only asked whether the
 * product currently holds stock, so a product received and then fully shipped
 * nets to zero, passes the guard, and a physical DELETE takes the ledger, the
 * lots, the serials, the valuation layers and the cost history with it.
 *
 * The first test here is the proof of the original defect: it performs the
 * physical delete the service used to perform and asserts the destruction. It
 * exists so that a future change back to a hard delete fails loudly rather than
 * quietly resuming the data loss.
 *
 *   DATABASE_URL=... pnpm test:db --testPathPattern="product-soft-delete"
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { dbSpecClient, dbSpecSuite, dbSpecUrl } from "../../../../test/db-spec-gate";
import { ensureFixtureOrgs } from "../../../../test/db-spec-fixture";

const describeDb = dbSpecSuite();

function connect() {
  return dbSpecClient(dbSpecUrl("DATABASE_URL"), { max: 4 });
}

type Database = ReturnType<typeof drizzle>;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

interface Fixture {
  orgId: string;
  userId: string;
  productId: number;
  variantId: number;
  locationId: number;
  sku: string;
}

describeDb("product deletion", () => {
  let client: ReturnType<typeof connect>;
  let db: Database;
  let orgId: string;
  let userId: string;

  beforeAll(async () => {
    client = connect();
    db = drizzle(client);
    // `LIMIT 1` over whatever a shared branch happened to hold: undefined on a
    // freshly migrated database, and a different tenant on every run elsewhere.
    // The fixture pair is idempotent, so this is deterministic either way.
    const [fixture] = await ensureFixtureOrgs(client, 1);
    orgId = fixture!.orgId;
    userId = fixture!.userId;
  });

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  /**
   * A product that was received and then fully shipped: current stock is zero,
   * history is two ledger facts and a lot. Always rolled back.
   */
  async function withSoldOutProduct(body: (tx: Tx, f: Fixture) => Promise<void>): Promise<void> {
    const marker = randomUUID().slice(0, 8);
    try {
      await db.transaction(async (tx) => {
        const one = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) =>
          (await tx.execute<T>(query))[0]!;
        const sku = `DEL-${marker}`;
        const uom = await one<{ id: number }>(sql`
          INSERT INTO inv_uom (org_id, name, abbreviation)
          VALUES (${orgId}, ${`U${marker}`}, ${`U${marker.slice(0, 3)}`}) RETURNING id`);
        const product = await one<{ id: number }>(sql`
          INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
          VALUES (${orgId}, ${uom.id}, 'Delete probe', ${sku}, ${userId}) RETURNING id`);
        const variant = await one<{ id: number }>(sql`
          INSERT INTO inv_product_variants (org_id, product_id, name, sku)
          VALUES (${orgId}, ${product.id}, 'V1', ${`${sku}-V1`}) RETURNING id`);
        const warehouse = await one<{ id: number }>(sql`
          INSERT INTO inv_warehouses (org_id, name, code, created_by)
          VALUES (${orgId}, ${`W${marker}`}, ${`W${marker.slice(0, 4)}`}, ${userId}) RETURNING id`);
        const location = await one<{ id: number }>(sql`
          INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
          VALUES (${orgId}, ${warehouse.id}, 'Bin', ${`B${marker}`}, 'BIN') RETURNING id`);

        for (const [type, before, change, after] of [
          ["PURCHASE", "0", "10", "10"],
          ["SALE", "10", "-10", "0"],
        ] as const) {
          await tx.execute(sql`
            INSERT INTO inv_stock_transactions
              (org_id, product_variant_id, location_id, transaction_type, quantity_bucket,
               quantity_change, quantity_before, quantity_after, created_by)
            VALUES (${orgId}, ${variant.id}, ${location.id}, ${sql.raw(`'${type}'`)}, 'ON_HAND',
                    ${change}, ${before}, ${after}, ${userId})`);
        }
        await tx.execute(sql`
          INSERT INTO inv_stock_levels
            (org_id, product_variant_id, location_id, on_hand, committed, on_order, blocked_qty, quality_hold_qty, outgoing_qty)
          VALUES (${orgId}, ${variant.id}, ${location.id}, '0', '0', '0', '0', '0', '0')`);
        await tx.execute(sql`
          INSERT INTO inv_lots (org_id, product_variant_id, lot_number)
          VALUES (${orgId}, ${variant.id}, ${`L${marker}`})`);

        await body(tx, {
          orgId,
          userId,
          productId: product.id,
          variantId: variant.id,
          locationId: location.id,
          sku,
        });
        throw new Error("__ROLLBACK__");
      });
    } catch (error) {
      if ((error as Error).message !== "__ROLLBACK__") throw error;
    }
  }

  async function counts(tx: Tx, f: Fixture) {
    const [row] = await tx.execute<{ ledger: number; lots: number; live: number }>(sql`
      SELECT
        (SELECT count(*)::int FROM inv_stock_transactions WHERE product_variant_id = ${f.variantId}) AS ledger,
        (SELECT count(*)::int FROM inv_lots WHERE product_variant_id = ${f.variantId}) AS lots,
        (SELECT count(*)::int FROM inv_products WHERE id = ${f.productId} AND deleted_at IS NULL) AS live`);
    return row!;
  }

  it("would destroy the ledger if the delete were physical — the defect this replaces", async () => {
    await withSoldOutProduct(async (tx, f) => {
      const before = await counts(tx, f);
      expect(before.ledger).toBe(2);
      expect(before.lots).toBe(1);

      await tx.execute(sql`DELETE FROM inv_products WHERE id = ${f.productId} AND org_id = ${f.orgId}`);

      const after = await counts(tx, f);
      expect(after.ledger).toBe(0);
      expect(after.lots).toBe(0);
    });
  });

  it("keeps every ledger fact and lot when the delete is a stamp", async () => {
    await withSoldOutProduct(async (tx, f) => {
      await tx.execute(sql`
        UPDATE inv_products SET deleted_at = now() WHERE id = ${f.productId} AND org_id = ${f.orgId}`);
      await tx.execute(sql`
        UPDATE inv_product_variants SET deleted_at = now() WHERE product_id = ${f.productId} AND org_id = ${f.orgId}`);

      const after = await counts(tx, f);
      expect(after.ledger).toBe(2);
      expect(after.lots).toBe(1);
      expect(after.live).toBe(0);
    });
  });

  it("frees the SKU for reuse, because the uniqueness index is partial", async () => {
    await withSoldOutProduct(async (tx, f) => {
      await tx.execute(sql`
        UPDATE inv_products SET deleted_at = now() WHERE id = ${f.productId} AND org_id = ${f.orgId}`);
      const [reused] = await tx.execute<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
        SELECT org_id, uom_id, 'Reused', ${f.sku}, created_by FROM inv_products WHERE id = ${f.productId}
        RETURNING id`);
      expect(reused!.id).toBeGreaterThan(0);
    });
  });

  it("still refuses the SKU while the original is live", async () => {
    await withSoldOutProduct(async (tx, f) => {
      // A savepoint, because the unique violation aborts the statement and
      // everything after it in the transaction would fail on a poisoned handle.
      await tx.execute(sql`SAVEPOINT before_conflict`);
      let code = "";
      try {
        await tx.execute(sql`
          INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
          SELECT org_id, uom_id, 'Duplicate', ${f.sku}, created_by FROM inv_products WHERE id = ${f.productId}`);
      } catch (error) {
        // Drizzle wraps the driver error, so the SQLSTATE is on the cause, not
        // on the thrown object — reading only the top level reports no error at
        // all and the assertion passes for the wrong reason.
        const wrapped = error as { code?: string; cause?: { code?: string } };
        code = wrapped.code ?? wrapped.cause?.code ?? "";
      }
      await tx.execute(sql`ROLLBACK TO SAVEPOINT before_conflict`);
      expect(code).toBe("23505");
    });
  });
});
