/**
 * D7 against Postgres, because three of the claims this export makes are claims
 * about the database rather than about TypeScript:
 *
 *   - the warehouse predicate really removes another warehouse's movements;
 *   - editing a movement's `notes` — which migration 0529 deliberately still
 *     allows — cannot change the checksum, because the document covers exactly
 *     the columns 0529 froze;
 *   - a pin taken while a writing transaction is open is *not* settled, which
 *     is the whole reason the job waits before publishing a checksum.
 *
 *   INV_DB_TESTS=1 npx jest --runInBand --testPathPattern="audit-export.db"
 */
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import {
  AuditExportStream,
  encodeManifestLine,
  encodeRowLine,
  encodeSectionHeaderLine,
  type AuditExportManifest,
} from "../audit-export-document";
import {
  countSection,
  isEvidenceSettled,
  pinEvidence,
  readSection,
  type AuditExportWindow,
} from "../audit-export-rows";

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

type Database = ReturnType<typeof drizzle>;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

interface Fixture {
  orgId: string;
  variantId: number;
  warehouseA: number;
  warehouseB: number;
  locationA: number;
  locationB: number;
  txnA: number;
  txnB: number;
}

async function one<T extends Record<string, unknown>>(tx: Tx, query: ReturnType<typeof sql>) {
  const rows = await tx.execute<T>(query);
  const row = rows[0];
  if (!row) throw new Error("fixture insert returned no row");
  return row;
}

describeDb("inventory audit export", () => {
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

  async function inRolledBackFixture(
    body: (tx: Tx, fixture: Fixture) => Promise<void>,
  ): Promise<void> {
    const marker = randomUUID().slice(0, 8);
    try {
      await db.transaction(async (tx) => {
        const uom = await one<{ id: number }>(tx, sql`
          INSERT INTO inv_uom (org_id, name, abbreviation)
          VALUES (${orgId}, ${`A-${marker}`}, ${`A${marker.slice(0, 3)}`}) RETURNING id`);
        const product = await one<{ id: number }>(tx, sql`
          INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
          VALUES (${orgId}, ${uom.id}, ${`Audit ${marker}`}, ${`AUD-${marker}`}, ${userId}) RETURNING id`);
        const variant = await one<{ id: number }>(tx, sql`
          INSERT INTO inv_product_variants (org_id, product_id, name, sku)
          VALUES (${orgId}, ${product.id}, 'V1', ${`AUD-${marker}-V1`}) RETURNING id`);

        const warehouses: number[] = [];
        const locations: number[] = [];
        for (const suffix of ["A", "B"]) {
          const warehouse = await one<{ id: number }>(tx, sql`
            INSERT INTO inv_warehouses (org_id, name, code, created_by)
            VALUES (${orgId}, ${`WH ${suffix} ${marker}`}, ${`W${suffix}${marker.slice(0, 4)}`}, ${userId}) RETURNING id`);
          const location = await one<{ id: number }>(tx, sql`
            INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
            VALUES (${orgId}, ${warehouse.id}, 'Bin', ${`${suffix}-${marker}`}, 'BIN') RETURNING id`);
          warehouses.push(warehouse.id);
          locations.push(location.id);
        }

        const movements: number[] = [];
        for (const locationId of locations) {
          const movement = await one<{ id: number }>(tx, sql`
            INSERT INTO inv_stock_transactions
              (org_id, product_variant_id, location_id, transaction_type, quantity_bucket,
               quantity_change, quantity_before, quantity_after, unit_cost, total_cost, created_by)
            VALUES (${orgId}, ${variant.id}, ${locationId}, 'GRN', 'ON_HAND',
                    '5.0000', '0.0000', '5.0000', '12.5000', '62.5000', ${userId}) RETURNING id`);
          movements.push(movement.id);
        }

        await body(tx, {
          orgId,
          variantId: variant.id,
          warehouseA: warehouses[0]!,
          warehouseB: warehouses[1]!,
          locationA: locations[0]!,
          locationB: locations[1]!,
          txnA: movements[0]!,
          txnB: movements[1]!,
        });
        throw new Error("__ROLLBACK__");
      });
    } catch (error) {
      if ((error as Error).message !== "__ROLLBACK__") throw error;
    }
  }

  function windowFor(f: Fixture, warehouseIds: number[] | null, ceiling: number): AuditExportWindow {
    return {
      orgId: f.orgId,
      from: null,
      to: null,
      ledgerCeilingId: ceiling,
      auditCeilingId: 0,
      locationScope:
        warehouseIds === null
          ? sql`TRUE`
          : sql`t.location_id IN (SELECT id FROM inv_locations WHERE warehouse_id IN (${sql.join(
              warehouseIds.map((id) => sql`${id}`),
              sql`, `,
            )}))`,
    };
  }

  async function document(tx: Tx, window: AuditExportWindow): Promise<{ text: string; checksum: string }> {
    const parts: string[] = [];
    const stream = new AuditExportStream((chunk) => {
      parts.push(chunk.toString("utf8"));
    });
    const manifest: AuditExportManifest = {
      orgId: window.orgId,
      evidenceVersion: `L${window.ledgerCeilingId}`,
      warehouseIds: null,
      from: null,
      to: null,
      sections: ["ledger"],
      rowCounts: { ledger: await countSection(tx as never, "ledger", window), audit_events: 0 },
    };
    await stream.line(encodeManifestLine(manifest));
    await stream.line(encodeSectionHeaderLine("ledger"));
    for await (const row of readSection(tx as never, "ledger", window, 100))
      await stream.line(encodeRowLine(row));
    return { text: parts.join(""), checksum: stream.checksum() };
  }

  it("leaves another warehouse's movements out of a scoped export", async () => {
    await inRolledBackFixture(async (tx, f) => {
      const scoped = windowFor(f, [f.warehouseA], f.txnB);
      const wide = windowFor(f, null, f.txnB);

      const scopedRows: string[] = [];
      for await (const row of readSection(tx as never, "ledger", scoped, 100))
        scopedRows.push(String(row[0]));

      expect(scopedRows).toContain(String(f.txnA));
      expect(scopedRows).not.toContain(String(f.txnB));
      expect(await countSection(tx as never, "ledger", scoped)).toBe(scopedRows.length);

      const wideRows: string[] = [];
      for await (const row of readSection(tx as never, "ledger", wide, 100)) wideRows.push(String(row[0]));
      expect(wideRows).toContain(String(f.txnB));
    });
  });

  it("renders a quantity as exact text and reproduces the same bytes twice", async () => {
    await inRolledBackFixture(async (tx, f) => {
      const window = windowFor(f, [f.warehouseA], f.txnB);

      const first = await document(tx, window);
      const second = await document(tx, window);

      expect(first.text).toBe(second.text);
      expect(first.checksum).toBe(second.checksum);
      expect(first.text).toContain('"5.0000"');
      expect(first.text).toContain('"12.5000"');
    });
  });

  it("is unmoved by the annotation columns 0529 still allows to change", async () => {
    await inRolledBackFixture(async (tx, f) => {
      const window = windowFor(f, [f.warehouseA], f.txnB);
      const before = await document(tx, window);

      await tx.execute(sql`
        UPDATE inv_stock_transactions
           SET notes = 'annotated after the fact', reason = 'recount'
         WHERE id = ${f.txnA}`);

      const after = await document(tx, window);
      expect(after.checksum).toBe(before.checksum);
    });
  });

  it("cannot be moved by a fact column at all — the ledger refuses the write", async () => {
    await inRolledBackFixture(async (tx, f) => {
      const failure = await tx
        .execute(sql`
          UPDATE inv_stock_transactions
             SET quantity_change = '6.0000', quantity_after = '6.0000'
           WHERE id = ${f.txnA}`)
        .then(() => null, (error: unknown) => error);

      expect(failure).not.toBeNull();
      const cause = (failure as { cause?: { message?: string; code?: string } }).cause;
      expect(String(cause?.message)).toContain("append-only");
      expect(cause?.code).toBe("23514");
    });
  });

  it("does not call a pin settled while the transaction that wrote below it is open", async () => {
    await inRolledBackFixture(async (tx, f) => {
      const pin = await pinEvidence(tx as never, f.orgId);

      expect(pin.ledgerCeilingId).toBeGreaterThanOrEqual(f.txnB);
      expect(await isEvidenceSettled(tx as never, pin.pinnedXmax)).toBe(false);
    });
  });
});
