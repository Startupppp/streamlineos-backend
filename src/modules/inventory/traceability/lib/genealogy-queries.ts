import { NotFoundException } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import type { GenealogyQueryInput } from "../dto/genealogy.schemas";
import type { GenealogyDirection } from "../genealogy.types";

/**
 * The warehouse-scope predicates, already resolved and applied to each column
 * this walk reaches. They are built in the service rather than here so the
 * service that acquires a scope is visibly the one that applies it — the
 * arrangement `inventory-scope-cache-keys.spec.ts` exists to hold in place.
 */
export interface GenealogyScopeFilters {
  /** Over `t.location_id` on `inv_stock_transactions`. */
  ledgerLocation: SQL;
  /** Over `s.current_location_id` on `inv_serial_numbers`. */
  serialLocation: SQL;
  /** Whether the anchor lot holds stock anywhere the caller may look. */
  lotVisible: SQL;
  /** Over `s.current_location_id` for the anchor serial. */
  serialVisible: SQL;
}

export interface ItemRef {
  kind: "lot" | "serial";
  id: number;
}

export interface DocumentRef {
  referenceType: string;
  referenceId: string;
}

export type LedgerRow = {
  source_key: string;
  id: number;
  lot_id: number | null;
  serial_id: number | null;
  reference_type: string;
  reference_id: string;
  transaction_type: string;
  quantity_change: string;
  location_id: number | null;
  created_at: Date | string | null;
  reversed: boolean;
};

export interface AnchorItem {
  kind: "lot" | "serial";
  id: number;
  label: string;
  productVariantId: number;
  productName: string | null;
  sku: string | null;
}

export const itemKey = (kind: "lot" | "serial", id: number): string => `${kind}:${String(id)}`;
export const documentKey = (ref: DocumentRef): string => `${ref.referenceType}:${ref.referenceId}`;

/**
 * The outer cap on one expansion. Every frontier node may contribute at most
 * `maxFanout + 1` rows and the whole level may not exceed the answer's node
 * budget, so the largest statement this walk can issue is fixed before it runs.
 */
export function rowCap(frontierSize: number, query: GenealogyQueryInput): number {
  return Math.min(frontierSize * (query.maxFanout + 1), query.maxNodes * query.maxFanout) + 1;
}

/**
 * `forward` follows goods out of an item and into the document that consumed
 * them, then out of that document into what it produced; `backward` is the
 * mirror. `both` follows every movement, which is the shape that fans out and
 * the reason the caps exist.
 */
function signPredicate(direction: GenealogyDirection, from: "item" | "document"): SQL {
  if (direction === "both") return sql`TRUE`;
  const outbound = from === "item" ? direction === "forward" : direction === "backward";
  return outbound ? sql`t.quantity_change < 0` : sql`t.quantity_change > 0`;
}

/**
 * A2. A movement that has been compensated, and the compensating movement
 * itself, describe goods that never really moved. Left in, a reversed shipment
 * reads as goods that shipped.
 */
function correctionPredicate(includeReversed: boolean): SQL {
  if (includeReversed) return sql`TRUE`;
  return sql`(t.correction_of_transaction_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM inv_stock_transactions c
    WHERE c.org_id = t.org_id AND c.correction_of_transaction_id = t.id))`;
}

const REVERSED_PROJECTION = sql`(t.correction_of_transaction_id IS NOT NULL OR EXISTS (
  SELECT 1 FROM inv_stock_transactions c
  WHERE c.org_id = t.org_id AND c.correction_of_transaction_id = t.id))`;

const LEDGER_COLUMNS = sql`t.id, t.lot_id, t.serial_id, t.reference_type, t.reference_id,
  t.transaction_type, t.quantity_change, t.location_id, t.created_at`;

const PROJECTED_COLUMNS = sql`x.id, x.lot_id, x.serial_id, x.reference_type, x.reference_id,
  x.transaction_type, x.quantity_change, x.location_id, x.created_at, x.reversed`;

/**
 * Every document one frontier item took part in, capped per item by the
 * `LATERAL … LIMIT` and per level by the outer `LIMIT`. Asking for one row more
 * than the cap is how the caller learns the answer was cut.
 */
export function expandItemsOfKind(
  db: Db,
  orgId: string,
  kind: "lot" | "serial",
  frontier: readonly ItemRef[],
  query: GenealogyQueryInput,
  scope: GenealogyScopeFilters,
): Promise<LedgerRow[]> {
  if (frontier.length === 0) return Promise.resolve([]);
  const column = kind === "lot" ? sql.raw("t.lot_id") : sql.raw("t.serial_id");
  const values = sql.join(frontier.map((f) => sql`(${f.id}::int)`), sql`, `);
  return db.execute<LedgerRow>(sql`
    SELECT ${kind}::text || ':' || a.item_id::text AS source_key, ${PROJECTED_COLUMNS}
    FROM (VALUES ${values}) AS a(item_id)
    CROSS JOIN LATERAL (
      SELECT ${LEDGER_COLUMNS}, ${REVERSED_PROJECTION} AS reversed
      FROM inv_stock_transactions t
      WHERE t.org_id = ${orgId}
        AND ${column} = a.item_id
        AND t.reference_type IS NOT NULL
        AND t.reference_id IS NOT NULL
        AND ${signPredicate(query.direction, "item")}
        AND ${scope.ledgerLocation}
        AND ${correctionPredicate(query.includeReversed)}
      ORDER BY t.id DESC
      LIMIT ${query.maxFanout + 1}
    ) x
    LIMIT ${rowCap(frontier.length, query)}`);
}

/** Every lot and serial that moved on one of the frontier's documents. */
export function expandDocuments(
  db: Db,
  orgId: string,
  frontier: readonly DocumentRef[],
  query: GenealogyQueryInput,
  scope: GenealogyScopeFilters,
): Promise<LedgerRow[]> {
  if (frontier.length === 0) return Promise.resolve([]);
  const values = sql.join(
    frontier.map((d) => sql`(${d.referenceType}::text, ${d.referenceId}::text)`),
    sql`, `,
  );
  return db.execute<LedgerRow>(sql`
    SELECT d.ref_type || ':' || d.ref_id AS source_key, ${PROJECTED_COLUMNS}
    FROM (VALUES ${values}) AS d(ref_type, ref_id)
    CROSS JOIN LATERAL (
      SELECT ${LEDGER_COLUMNS}, ${REVERSED_PROJECTION} AS reversed
      FROM inv_stock_transactions t
      WHERE t.org_id = ${orgId}
        AND t.reference_type = d.ref_type
        AND t.reference_id = d.ref_id
        AND (t.lot_id IS NOT NULL OR t.serial_id IS NOT NULL)
        AND ${signPredicate(query.direction, "document")}
        AND ${scope.ledgerLocation}
        AND ${correctionPredicate(query.includeReversed)}
      ORDER BY t.id DESC
      LIMIT ${query.maxFanout + 1}
    ) x
    LIMIT ${rowCap(frontier.length, query)}`);
}

/**
 * The one genuine parent/child FK in this schema: a serial belongs to a lot. A
 * lot holding ten thousand serials is why this carries the same per-node cap as
 * every other expansion.
 */
export async function expandContainment(
  db: Db,
  orgId: string,
  frontier: readonly ItemRef[],
  query: GenealogyQueryInput,
  scope: GenealogyScopeFilters,
): Promise<{ links: Array<ItemRef & { sourceKey: string }>; overflowed: string[] }> {
  const links: Array<ItemRef & { sourceKey: string }> = [];
  const overflowed: string[] = [];

  const lots = frontier.filter((f) => f.kind === "lot");
  if (lots.length > 0 && query.direction !== "backward") {
    const values = sql.join(lots.map((f) => sql`(${f.id}::int)`), sql`, `);
    const rows = await db.execute<{ lot_id: number; id: number }>(sql`
      SELECT a.lot_id, x.id
      FROM (VALUES ${values}) AS a(lot_id)
      CROSS JOIN LATERAL (
        SELECT s.id FROM inv_serial_numbers s
        WHERE s.org_id = ${orgId}
          AND s.lot_id = a.lot_id
          AND ${scope.serialLocation}
        ORDER BY s.id DESC
        LIMIT ${query.maxFanout + 1}
      ) x
      LIMIT ${rowCap(lots.length, query)}`);
    const perLot = new Map<number, number>();
    for (const row of rows) {
      perLot.set(row.lot_id, (perLot.get(row.lot_id) ?? 0) + 1);
      links.push({ kind: "serial", id: row.id, sourceKey: itemKey("lot", row.lot_id) });
    }
    for (const [lotId, count] of perLot) {
      if (count > query.maxFanout) overflowed.push(itemKey("lot", lotId));
    }
  }

  const serials = frontier.filter((f) => f.kind === "serial");
  if (serials.length > 0 && query.direction !== "forward") {
    const ids = sql.join(serials.map((f) => sql`${f.id}`), sql`, `);
    const rows = await db.execute<{ id: number; lot_id: number }>(sql`
      SELECT id, lot_id FROM inv_serial_numbers
      WHERE org_id = ${orgId} AND lot_id IS NOT NULL AND id IN (${ids})
      LIMIT ${serials.length}`);
    for (const row of rows) {
      links.push({ kind: "lot", id: row.lot_id, sourceKey: itemKey("serial", row.id) });
    }
  }

  return { links, overflowed };
}

/**
 * The anchor is the object-level authorization check. A lot in another tenant,
 * or one attributable only to a warehouse this caller is not assigned to, is
 * 404 — a 403 on someone else's lot id is an existence oracle.
 *
 * Attribution follows the rule `listLots` already uses: a lot is the caller's
 * to see when it holds stock in a location they are assigned to.
 */
export async function loadAnchor(
  db: Db,
  orgId: string,
  query: GenealogyQueryInput,
  scope: GenealogyScopeFilters,
): Promise<AnchorItem> {
  type AnchorRow = {
    id: number;
    label: string;
    product_variant_id: number;
    product_name: string | null;
    sku: string | null;
  };

  if (query.lotId != null) {
    const rows = await db.execute<AnchorRow>(sql`
      SELECT l.id, l.lot_number AS label, l.product_variant_id,
             p.name AS product_name, v.sku
      FROM inv_lots l
      INNER JOIN inv_product_variants v ON v.id = l.product_variant_id
      INNER JOIN inv_products p ON p.id = v.product_id
      WHERE l.org_id = ${orgId} AND l.id = ${query.lotId} AND ${scope.lotVisible}
      LIMIT 1`);
    const row = rows[0];
    if (!row) throw new NotFoundException("Lot not found");
    return {
      kind: "lot",
      id: row.id,
      label: row.label,
      productVariantId: row.product_variant_id,
      productName: row.product_name,
      sku: row.sku,
    };
  }

  const rows = await db.execute<AnchorRow>(sql`
    SELECT s.id, s.serial_number AS label, s.product_variant_id,
           p.name AS product_name, v.sku
    FROM inv_serial_numbers s
    INNER JOIN inv_product_variants v ON v.id = s.product_variant_id
    INNER JOIN inv_products p ON p.id = v.product_id
    WHERE s.org_id = ${orgId} AND s.id = ${query.serialId ?? 0}
      AND ${scope.serialVisible}
    LIMIT 1`);
  const row = rows[0];
  if (!row) throw new NotFoundException("Serial number not found");
  return {
    kind: "serial",
    id: row.id,
    label: row.label,
    productVariantId: row.product_variant_id,
    productName: row.product_name,
    sku: row.sku,
  };
}
