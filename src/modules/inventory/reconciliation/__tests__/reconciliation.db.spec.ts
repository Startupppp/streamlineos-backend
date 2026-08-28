/**
 * INV-104 / A2 — the reconciliation checks and the rebuild, against Postgres.
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
  warehouseId: number;
  locationId: number;
  levelId: number;
}

/** Unrestricted scope: these prove the checks, not what the scope filters out. */
const NO_SCOPE_FILTER = sql`TRUE`;

type Database = ReturnType<typeof drizzle>;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Every bucket the projection holds, so a test can assert the ones it did not aim at. */
interface Buckets extends Record<string, unknown> {
  on_hand: string;
  blocked_qty: string | null;
  quality_hold_qty: string | null;
  committed: string;
  on_order: string | null;
  outgoing_qty: string | null;
  average_cost: string | null;
}

/**
 * No declared return type on purpose: drizzle hands back `Assume<T, Row>`,
 * which only collapses to `T` once `T` is concrete, so annotating it `Promise<T>`
 * does not compile.
 */
async function one<T extends Record<string, unknown>>(tx: Tx, query: ReturnType<typeof sql>) {
  const rows = await tx.execute<T>(query);
  const row = rows[0];
  if (!row) throw new Error("fixture insert returned no row");
  return row;
}

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
        const uom = await one<{ id: number }>(tx, sql`
          INSERT INTO inv_uom (org_id, name, abbreviation)
          VALUES (${orgId}, ${`R-${marker}`}, ${`R${marker.slice(0, 3)}`}) RETURNING id`);
        const product = await one<{ id: number }>(tx, sql`
          INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
          VALUES (${orgId}, ${uom.id}, ${`Recon ${marker}`}, ${`RECON-${marker}`}, ${userId}) RETURNING id`);
        const variant = await one<{ id: number }>(tx, sql`
          INSERT INTO inv_product_variants (org_id, product_id, name, sku)
          VALUES (${orgId}, ${product.id}, 'V1', ${`RECON-${marker}-V1`}) RETURNING id`);
        const warehouse = await one<{ id: number }>(tx, sql`
          INSERT INTO inv_warehouses (org_id, name, code, created_by)
          VALUES (${orgId}, ${`WH ${marker}`}, ${`WH${marker.slice(0, 4)}`}, ${userId}) RETURNING id`);
        // The only location in a brand-new warehouse, active and receivable, so
        // it is also the row `addOnOrder` parks `on_order` on.
        const location = await one<{ id: number }>(tx, sql`
          INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
          VALUES (${orgId}, ${warehouse.id}, 'Bin', ${`B-${marker}`}, 'BIN') RETURNING id`);
        const level = await one<{ id: number }>(tx, sql`
          INSERT INTO inv_stock_levels
            (org_id, product_variant_id, location_id, on_hand, committed, on_order, blocked_qty, quality_hold_qty, outgoing_qty)
          VALUES (${orgId}, ${variant.id}, ${location.id}, '0', '0', '0', '0', '0', '0') RETURNING id`);

        await body(tx, {
          orgId,
          userId,
          variantId: variant.id,
          warehouseId: warehouse.id,
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

  async function reservation(tx: Tx, f: Fixture, qty: string, status: string): Promise<void> {
    await tx.execute(sql`
      INSERT INTO inv_stock_reservations
        (org_id, source_type, source_id, product_variant_id, location_id, reserved_qty, status)
      VALUES (${f.orgId}, 'test', ${randomUUID()}, ${f.variantId}, ${f.locationId}, ${qty},
              ${sql.raw(`'${status}'`)})`);
  }

  /** A purchase order for this variant, into this warehouse, in the given state. */
  async function purchaseOrder(
    tx: Tx,
    f: Fixture,
    status: string,
    quantity: string,
    quantityReceived = "0",
  ): Promise<void> {
    const tag = randomUUID().slice(0, 8);
    const vendor = await one<{ id: number }>(tx, sql`
      INSERT INTO inv_vendors (org_id, name, code, created_by)
      VALUES (${f.orgId}, ${`Vendor ${tag}`}, ${`V-${tag}`}, ${f.userId}) RETURNING id`);
    const po = await one<{ id: number }>(tx, sql`
      INSERT INTO inv_purchase_orders
        (org_id, vendor_id, po_number, status, order_date, warehouse_id, created_by)
      VALUES (${f.orgId}, ${vendor.id}, ${`PO-${tag}`}, ${sql.raw(`'${status}'`)}, '2026-06-01',
              ${f.warehouseId}, ${f.userId}) RETURNING id`);
    await tx.execute(sql`
      INSERT INTO inv_po_lines
        (org_id, po_id, product_variant_id, quantity, quantity_received, unit_cost, amount)
      VALUES (${f.orgId}, ${po.id}, ${f.variantId}, ${quantity}, ${quantityReceived}, '10.0000', '0')`);
  }

  /** A sales order picked at this location, left in the given state. */
  async function pickedSalesOrder(
    tx: Tx,
    f: Fixture,
    status: string,
    quantityPicked: string,
  ): Promise<void> {
    const tag = randomUUID().slice(0, 8);
    const so = await one<{ id: number }>(tx, sql`
      INSERT INTO inv_sales_orders
        (org_id, so_number, status, order_date, warehouse_id, created_by)
      VALUES (${f.orgId}, ${`SO-${tag}`}, ${sql.raw(`'${status}'`)}, '2026-06-01',
              ${f.warehouseId}, ${f.userId}) RETURNING id`);
    const soLine = await one<{ id: number }>(tx, sql`
      INSERT INTO inv_so_lines (org_id, so_id, product_variant_id, quantity, unit_price, amount)
      VALUES (${f.orgId}, ${so.id}, ${f.variantId}, ${quantityPicked}, '25.0000', '0') RETURNING id`);
    const pickList = await one<{ id: number }>(tx, sql`
      INSERT INTO inv_pick_lists (org_id, pick_number, so_id, warehouse_id, status, created_by)
      VALUES (${f.orgId}, ${`PICK-${tag}`}, ${so.id}, ${f.warehouseId}, 'COMPLETED', ${f.userId})
      RETURNING id`);
    await tx.execute(sql`
      INSERT INTO inv_pick_list_lines
        (org_id, pick_list_id, so_line_id, product_variant_id, location_id, quantity_to_pick, quantity_picked)
      VALUES (${f.orgId}, ${pickList.id}, ${soLine.id}, ${f.variantId}, ${f.locationId},
              ${quantityPicked}, ${quantityPicked})`);
  }

  async function buckets(tx: Tx, f: Fixture): Promise<Buckets> {
    return one<Buckets>(tx, sql`
      SELECT on_hand, blocked_qty, quality_hold_qty, committed, on_order, outgoing_qty, average_cost
      FROM inv_stock_levels WHERE id = ${f.levelId}`);
  }

  /**
   * Every bucket except the named ones is numerically unchanged.
   *
   * A repair that fixes the bucket it aimed at and quietly zeroes another is the
   * failure this whole file exists to prevent, and asserting only the target
   * would not see it.
   */
  function expectOnlyTheseMoved(before: Buckets, after: Buckets, moved: string[]) {
    for (const field of [
      "on_hand",
      "blocked_qty",
      "quality_hold_qty",
      "committed",
      "on_order",
      "outgoing_qty",
    ] as const) {
      if (moved.includes(field)) continue;
      expect({ [field]: Number(after[field] ?? 0) }).toEqual({ [field]: Number(before[field] ?? 0) });
    }
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
        await reservation(tx, f, "4", "ACTIVE");
        await reservation(tx, f, "9", "RELEASED");
        await tx.execute(sql`UPDATE inv_stock_levels SET committed = '4' WHERE id = ${f.levelId}`);
        expect(await reconciliationQueries.committedDrift(tx, f.orgId, scopedToFixture(f), 50)).toEqual([]);
      });
    });

    /**
     * A2. The check could name this fault and the rebuild could not fix it,
     * which is half a tool.
     */
    it("rebuilds committed back to the reservations, and moves nothing else", async () => {
      await inRolledBackFixture(async (tx, f) => {
        await movement(tx, f, "ON_HAND", "0", "30", "30");
        await reservation(tx, f, "12", "ACTIVE");
        await reservation(tx, f, "5", "RELEASED");
        await tx.execute(sql`
          UPDATE inv_stock_levels SET on_hand = '30', committed = '25' WHERE id = ${f.levelId}`);

        const reported = await reconciliationQueries.committedDrift(tx, f.orgId, scopedToFixture(f), 50);
        expect(reported).toHaveLength(1);
        expect(Number(reported[0]!.projected)).toBe(25);
        expect(Number(reported[0]!.expected)).toBe(12);

        const before = await buckets(tx, f);
        expect(await reconciliationQueries.rebuild(tx, f.orgId, scopedToFixture(f))).toHaveLength(1);
        const after = await buckets(tx, f);

        expect(Number(after.committed)).toBe(12);
        expectOnlyTheseMoved(before, after, ["committed"]);
        expect(await reconciliationQueries.committedDrift(tx, f.orgId, scopedToFixture(f), 50)).toEqual([]);
      });
    });
  });

  describe("on_order against purchase orders", () => {
    it("reports nothing when no purchase order is outstanding", async () => {
      await inRolledBackFixture(async (tx, f) => {
        await purchaseOrder(tx, f, "DRAFT", "40");
        await purchaseOrder(tx, f, "RECEIVED", "40", "40");
        await purchaseOrder(tx, f, "CANCELLED", "40");
        expect(await reconciliationQueries.onOrderDrift(tx, f.orgId, scopedToFixture(f), 50)).toEqual([]);
      });
    });

    it("counts what a sent order still owes, not what it ordered", async () => {
      await inRolledBackFixture(async (tx, f) => {
        // Sent for 40, 15 already through the door: 25 is still on its way, and
        // booking the full 40 would have replenishment ignore the delivery.
        await purchaseOrder(tx, f, "PARTIAL", "40", "15");
        const drift = await reconciliationQueries.onOrderDrift(tx, f.orgId, scopedToFixture(f), 50);
        expect(drift).toHaveLength(1);
        expect(drift[0]!.field).toBe("on_order");
        expect(Number(drift[0]!.projected)).toBe(0);
        expect(Number(drift[0]!.expected)).toBe(25);
        expect(Number(drift[0]!.difference)).toBe(-25);
      });
    });

    it("rebuilds on_order from the open orders, and moves nothing else", async () => {
      await inRolledBackFixture(async (tx, f) => {
        await movement(tx, f, "ON_HAND", "0", "8", "8");
        await purchaseOrder(tx, f, "SENT", "30");
        await purchaseOrder(tx, f, "PARTIAL", "20", "5");
        await purchaseOrder(tx, f, "CLOSED", "100");
        await tx.execute(sql`
          UPDATE inv_stock_levels SET on_hand = '8', on_order = '7' WHERE id = ${f.levelId}`);

        const before = await buckets(tx, f);
        expect(await reconciliationQueries.rebuild(tx, f.orgId, scopedToFixture(f))).toHaveLength(1);
        const after = await buckets(tx, f);

        expect(Number(after.on_order)).toBe(45);
        expectOnlyTheseMoved(before, after, ["on_order"]);
        expect(await reconciliationQueries.onOrderDrift(tx, f.orgId, scopedToFixture(f), 50)).toEqual([]);
        // A second pass has nothing left to write.
        expect(await reconciliationQueries.rebuild(tx, f.orgId, scopedToFixture(f))).toEqual([]);
      });
    });

    /**
     * `addOnOrder` holds the figure at the warehouse's first receivable
     * location rather than spreading it over bins, so every other row in the
     * warehouse expects zero. Aggregate any other way and the second bin reads
     * as drift for a purchase order it has nothing to do with.
     */
    it("expects nothing on a second bin in the same warehouse", async () => {
      await inRolledBackFixture(async (tx, f) => {
        await purchaseOrder(tx, f, "SENT", "30");
        const other = await one<{ id: number }>(tx, sql`
          INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
          VALUES (${f.orgId}, ${f.warehouseId}, 'Bin 2', ${`B2-${randomUUID().slice(0, 6)}`}, 'BIN')
          RETURNING id`);
        const second = await one<{ id: number }>(tx, sql`
          INSERT INTO inv_stock_levels (org_id, product_variant_id, location_id, on_order)
          VALUES (${f.orgId}, ${f.variantId}, ${other.id}, '0') RETURNING id`);

        const scopeBoth = reconciliationFilters(f.orgId, NO_SCOPE_FILTER, null, f.variantId);
        const drift = await reconciliationQueries.onOrderDrift(tx, f.orgId, scopeBoth, 50);
        // Only the anchor row is short of its 30; the second bin is content.
        expect(drift.map((r) => r.stock_level_id)).toEqual([f.levelId]);
        expect(Number(drift[0]!.expected)).toBe(30);

        await reconciliationQueries.rebuild(tx, f.orgId, scopeBoth);
        const [secondAfter] = await tx.execute<{ on_order: string }>(
          sql`SELECT on_order FROM inv_stock_levels WHERE id = ${second.id}`,
        );
        expect(Number(secondAfter!.on_order)).toBe(0);
      });
    });
  });

  describe("outgoing_qty against picks", () => {
    it("reports nothing when nothing has been picked", async () => {
      await inRolledBackFixture(async (tx, f) => {
        expect(await reconciliationQueries.outgoingDrift(tx, f.orgId, scopedToFixture(f), 50)).toEqual([]);
      });
    });

    it("reports stock picked and not yet shipped", async () => {
      await inRolledBackFixture(async (tx, f) => {
        await pickedSalesOrder(tx, f, "PICKED", "9");
        const drift = await reconciliationQueries.outgoingDrift(tx, f.orgId, scopedToFixture(f), 50);
        expect(drift).toHaveLength(1);
        expect(drift[0]!.field).toBe("outgoing_qty");
        expect(Number(drift[0]!.projected)).toBe(0);
        expect(Number(drift[0]!.expected)).toBe(9);
      });
    });

    it("ignores a pick whose order has already shipped", async () => {
      await inRolledBackFixture(async (tx, f) => {
        await pickedSalesOrder(tx, f, "SHIPPED", "9");
        expect(await reconciliationQueries.outgoingDrift(tx, f.orgId, scopedToFixture(f), 50)).toEqual([]);
      });
    });

    /**
     * The load-bearing half of `recordPicked`: `committed` and `outgoing_qty`
     * are disjoint, so only the part no ACTIVE reservation covers is outgoing.
     * Counting the reserved units in both is how availability subtracts the
     * same goods twice.
     */
    it("counts only the picked units no active reservation covers", async () => {
      await inRolledBackFixture(async (tx, f) => {
        await pickedSalesOrder(tx, f, "PACKED", "10");
        await reservation(tx, f, "6", "ACTIVE");
        await tx.execute(sql`UPDATE inv_stock_levels SET committed = '6' WHERE id = ${f.levelId}`);

        const drift = await reconciliationQueries.outgoingDrift(tx, f.orgId, scopedToFixture(f), 50);
        expect(drift).toHaveLength(1);
        expect(Number(drift[0]!.expected)).toBe(4);
      });
    });

    it("expects nothing outgoing when the reservation covers the whole pick", async () => {
      await inRolledBackFixture(async (tx, f) => {
        await pickedSalesOrder(tx, f, "PICKED", "10");
        await reservation(tx, f, "10", "ACTIVE");
        await tx.execute(sql`UPDATE inv_stock_levels SET committed = '10' WHERE id = ${f.levelId}`);
        expect(await reconciliationQueries.outgoingDrift(tx, f.orgId, scopedToFixture(f), 50)).toEqual([]);
      });
    });

    it("rebuilds outgoing_qty from the picks, and moves nothing else", async () => {
      await inRolledBackFixture(async (tx, f) => {
        await movement(tx, f, "ON_HAND", "0", "20", "20");
        await pickedSalesOrder(tx, f, "PICKED", "7");
        await pickedSalesOrder(tx, f, "SHIPPED", "5");
        await tx.execute(sql`
          UPDATE inv_stock_levels SET on_hand = '20', outgoing_qty = '13' WHERE id = ${f.levelId}`);

        const before = await buckets(tx, f);
        expect(await reconciliationQueries.rebuild(tx, f.orgId, scopedToFixture(f))).toHaveLength(1);
        const after = await buckets(tx, f);

        // The shipped order's five have left the building; the seven on the
        // bench have not.
        expect(Number(after.outgoing_qty)).toBe(7);
        expectOnlyTheseMoved(before, after, ["outgoing_qty"]);
        expect(await reconciliationQueries.outgoingDrift(tx, f.orgId, scopedToFixture(f), 50)).toEqual([]);
        expect(await reconciliationQueries.rebuild(tx, f.orgId, scopedToFixture(f))).toEqual([]);
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

    it("rebuilds from the ledger, leaves average_cost alone, and repeats as a no-op", async () => {
      await inRolledBackFixture(async (tx, f) => {
        await movement(tx, f, "ON_HAND", "0", "10", "10");
        await movement(tx, f, "ON_HAND", "10", "-4", "6");
        await movement(tx, f, "QUALITY_HOLD", "0", "2", "2");
        await tx.execute(sql`
          UPDATE inv_stock_levels
             SET on_hand = '99', quality_hold_qty = '0', on_order = '12', average_cost = '3.5000'
          WHERE id = ${f.levelId}`);

        expect(await reconciliationQueries.rebuild(tx, f.orgId, scopedToFixture(f))).toHaveLength(1);

        const after = await buckets(tx, f);
        expect(Number(after.on_hand)).toBe(6);
        expect(Number(after.quality_hold_qty)).toBe(2);
        // No purchase order explains that 12, so it was never inbound stock —
        // the figure the projection was holding is exactly the drift this check
        // now names, and the rebuild clears it.
        expect(Number(after.on_order)).toBe(0);
        // average_cost is a running average, not a bucket; a set-based rebuild
        // cannot derive it and must leave it be rather than zero it on the way
        // past.
        expect(Number(after.average_cost)).toBe(3.5);

        expect(await reconciliationQueries.rebuild(tx, f.orgId, scopedToFixture(f))).toEqual([]);
        expect(await reconciliationQueries.bucketDrift(tx, f.orgId, scopedToFixture(f), 50)).toEqual([]);
      });
    });
  });
});
