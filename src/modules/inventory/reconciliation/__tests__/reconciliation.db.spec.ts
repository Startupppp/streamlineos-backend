/**
 * INV-104 — the reconciliation checks and the rebuild, against Postgres.
 *
 * These call `reconciliationQueries` directly, which is the point: the first
 * version of the committed check referenced `res.qty` where the column is
 * `reserved_qty`, a hand-copied spec passed anyway, and only booting the real
 * service found it. A spec that transcribes the SQL proves the transcription.
 *
 *   INV_DB_TESTS=1 npx jest --runInBand --testPathPattern="reconciliation.db"
 */
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import {
  reconciliationFilters,
  reconciliationQueries,
} from "../inv-reconciliation.service";

const ENABLED = process.env.INV_DB_TESTS === "1";
const describeDb = ENABLED ? describe : describe.skip;

function connect() {
  if (!process.env.DATABASE_URL) dotenv.config({ path: ".env" });
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL required for INV_DB_TESTS");
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  return postgres(url.toString(), { prepare: false, max: 4, ssl: "require", connect_timeout: 30 });
}

interface Fixture {
  orgId: string;
  userId: string;
  variantId: number;
  locationId: number;
  levelId: number;
}

/** Unrestricted scope: these prove the checks, not what the scope filters out. */
const NO_SCOPE_FILTER = sql`TRUE`;

type Database = ReturnType<typeof drizzle>;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

describeDb("inventory reconciliation", () => {
  let client: ReturnType<typeof connect>;
  let db: Database;
  let orgId: string;
  let userId: string;

  beforeAll(async () => {
    client = connect();
    db = drizzle(client);
    const [org] = await client<{ id: string }[]>`SELECT id FROM organizations LIMIT 1`;
    const [user] = await client<{ id: string }[]>`SELECT id FROM users LIMIT 1`;
    orgId = org!.id;
    userId = user!.id;
  });

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  /**
   * Everything runs inside one transaction that is always rolled back, so the
   * fixture never reaches the shared database this suite is pointed at.
   */
  async function inRolledBackFixture(
    body: (tx: Tx, fixture: Fixture) => Promise<void>,
  ): Promise<void> {
    const marker = randomUUID().slice(0, 8);
    try {
      await db.transaction(async (tx) => {
        const one = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) =>
          (await tx.execute<T>(query))[0]!;

        const uom = await one<{ id: number }>(sql`
          INSERT INTO inv_uom (org_id, name, abbreviation)
          VALUES (${orgId}, ${`R-${marker}`}, ${`R${marker.slice(0, 3)}`}) RETURNING id`);
        const product = await one<{ id: number }>(sql`
          INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
          VALUES (${orgId}, ${uom.id}, ${`Recon ${marker}`}, ${`RECON-${marker}`}, ${userId}) RETURNING id`);
        const variant = await one<{ id: number }>(sql`
          INSERT INTO inv_product_variants (org_id, product_id, name, sku)
          VALUES (${orgId}, ${product.id}, 'V1', ${`RECON-${marker}-V1`}) RETURNING id`);
        const warehouse = await one<{ id: number }>(sql`
          INSERT INTO inv_warehouses (org_id, name, code, created_by)
          VALUES (${orgId}, ${`WH ${marker}`}, ${`WH${marker.slice(0, 4)}`}, ${userId}) RETURNING id`);
        const location = await one<{ id: number }>(sql`
          INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
          VALUES (${orgId}, ${warehouse.id}, 'Bin', ${`B-${marker}`}, 'BIN') RETURNING id`);
        const level = await one<{ id: number }>(sql`
          INSERT INTO inv_stock_levels
            (org_id, product_variant_id, location_id, on_hand, committed, on_order, blocked_qty, quality_hold_qty, outgoing_qty)
          VALUES (${orgId}, ${variant.id}, ${location.id}, '0', '0', '0', '0', '0', '0') RETURNING id`);

        await body(tx, {
          orgId,
          userId,
          variantId: variant.id,
          locationId: location.id,
          levelId: level.id,
        });
        throw new Error("__ROLLBACK__");
      });
    } catch (error) {
      if ((error as Error).message !== "__ROLLBACK__") throw error;
    }
  }

  function scopedToFixture(f: Fixture) {
    return sql.join(
      [reconciliationFilters(f.orgId, NO_SCOPE_FILTER, null, f.variantId), sql`sl.id = ${f.levelId}`],
      sql` AND `,
    );
  }

  async function movement(
    tx: Tx,
    f: Fixture,
    bucket: string,
    before: string,
    change: string,
    after: string,
  ): Promise<void> {
    await tx.execute(sql`
      INSERT INTO inv_stock_transactions
        (org_id, product_variant_id, location_id, transaction_type, quantity_bucket,
         quantity_change, quantity_before, quantity_after, created_by)
      VALUES (${f.orgId}, ${f.variantId}, ${f.locationId}, 'ADJUSTMENT_IN', ${sql.raw(`'${bucket}'`)},
              ${change}, ${before}, ${after}, ${f.userId})`);
  }

  describe("projection against the ledger", () => {
    it("reports nothing when the projection equals the ledger", async () => {
      await inRolledBackFixture(async (tx, f) => {
        await movement(tx, f, "ON_HAND", "0", "10", "10");
        await movement(tx, f, "ON_HAND", "10", "-4", "6");
        await tx.execute(sql`UPDATE inv_stock_levels SET on_hand = '6' WHERE id = ${f.levelId}`);
        const drift = await reconciliationQueries.bucketDrift(tx, f.orgId, scopedToFixture(f), 50);
        expect(drift).toEqual([]);
      });
    });

    it("reports the exact difference when the projection has drifted", async () => {
      await inRolledBackFixture(async (tx, f) => {
        await movement(tx, f, "ON_HAND", "0", "10", "10");
        await tx.execute(sql`UPDATE inv_stock_levels SET on_hand = '7' WHERE id = ${f.levelId}`);
        const drift = await reconciliationQueries.bucketDrift(tx, f.orgId, scopedToFixture(f), 50);
        expect(drift).toHaveLength(1);
        expect(drift[0]!.field).toBe("on_hand");
        expect(Number(drift[0]!.projected)).toBe(7);
        expect(Number(drift[0]!.expected)).toBe(10);
        expect(Number(drift[0]!.difference)).toBe(-3);
      });
    });

    it("does not count a quality-hold movement towards on-hand", async () => {
      await inRolledBackFixture(async (tx, f) => {
        await movement(tx, f, "ON_HAND", "0", "10", "10");
        // The hold moves goods between buckets; on-hand is untouched, which is
        // why its before and after are the hold's own quantities.
        await movement(tx, f, "QUALITY_HOLD", "0", "3", "3");
        await tx.execute(sql`UPDATE inv_stock_levels SET on_hand = '10', quality_hold_qty = '3' WHERE id = ${f.levelId}`);
        expect(await reconciliationQueries.bucketDrift(tx, f.orgId, scopedToFixture(f), 50)).toEqual([]);
      });
    });

    it("compares quantities numerically, so 5.0000 and 5.00 are not drift", async () => {
      await inRolledBackFixture(async (tx, f) => {
        await movement(tx, f, "ON_HAND", "0", "5.0000", "5.0000");
        await tx.execute(sql`UPDATE inv_stock_levels SET on_hand = '5.00' WHERE id = ${f.levelId}`);
        expect(await reconciliationQueries.bucketDrift(tx, f.orgId, scopedToFixture(f), 50)).toEqual([]);
      });
    });
  });

  describe("committed against reservations", () => {
    it("runs against the real reservation columns", async () => {
      await inRolledBackFixture(async (tx, f) => {
        const drift = await reconciliationQueries.committedDrift(tx, f.orgId, scopedToFixture(f), 50);
        expect(drift).toEqual([]);
      });
    });

    it("reports committed that no active reservation accounts for", async () => {
      await inRolledBackFixture(async (tx, f) => {
        await tx.execute(sql`UPDATE inv_stock_levels SET committed = '4' WHERE id = ${f.levelId}`);
        const drift = await reconciliationQueries.committedDrift(tx, f.orgId, scopedToFixture(f), 50);
        expect(drift).toHaveLength(1);
        expect(Number(drift[0]!.projected)).toBe(4);
        expect(Number(drift[0]!.expected)).toBe(0);
      });
    });

    it("counts an active reservation and ignores a released one", async () => {
      await inRolledBackFixture(async (tx, f) => {
        for (const [qty, status] of [["4", "ACTIVE"], ["9", "RELEASED"]] as const) {
          await tx.execute(sql`
            INSERT INTO inv_stock_reservations
              (org_id, source_type, source_id, product_variant_id, location_id, reserved_qty, status)
            VALUES (${f.orgId}, 'test', ${randomUUID()}, ${f.variantId}, ${f.locationId}, ${qty}, ${sql.raw(`'${status}'`)})`);
        }
        await tx.execute(sql`UPDATE inv_stock_levels SET committed = '4' WHERE id = ${f.levelId}`);
        expect(await reconciliationQueries.committedDrift(tx, f.orgId, scopedToFixture(f), 50)).toEqual([]);
      });
    });
  });

  describe("orphans and rebuild", () => {
    it("finds a projection row holding stock no movement put there", async () => {
      await inRolledBackFixture(async (tx, f) => {
        await tx.execute(sql`UPDATE inv_stock_levels SET on_hand = '5' WHERE id = ${f.levelId}`);
        const orphans = await reconciliationQueries.orphanProjections(tx, f.orgId, scopedToFixture(f), 50);
        expect(orphans).toHaveLength(1);
        expect(Number(orphans[0]!.projected)).toBe(5);
      });
    });

    it("rebuilds from the ledger, leaves un-ledgered buckets alone, and repeats as a no-op", async () => {
      await inRolledBackFixture(async (tx, f) => {
        await movement(tx, f, "ON_HAND", "0", "10", "10");
        await movement(tx, f, "ON_HAND", "10", "-4", "6");
        await movement(tx, f, "QUALITY_HOLD", "0", "2", "2");
        await tx.execute(sql`
          UPDATE inv_stock_levels SET on_hand = '99', quality_hold_qty = '0', on_order = '12'
          WHERE id = ${f.levelId}`);

        expect(await reconciliationQueries.rebuild(tx, f.orgId, scopedToFixture(f))).toHaveLength(1);

        const [after] = await tx.execute<{ on_hand: string; quality_hold_qty: string; on_order: string }>(
          sql`SELECT on_hand, quality_hold_qty, on_order FROM inv_stock_levels WHERE id = ${f.levelId}`,
        );
        expect(Number(after!.on_hand)).toBe(6);
        expect(Number(after!.quality_hold_qty)).toBe(2);
        // on_order is not derived from the ledger, so the rebuild must leave it
        // be rather than zero it on the way past.
        expect(Number(after!.on_order)).toBe(12);

        expect(await reconciliationQueries.rebuild(tx, f.orgId, scopedToFixture(f))).toEqual([]);
        expect(await reconciliationQueries.bucketDrift(tx, f.orgId, scopedToFixture(f), 50)).toEqual([]);
      });
    });
  });
});
