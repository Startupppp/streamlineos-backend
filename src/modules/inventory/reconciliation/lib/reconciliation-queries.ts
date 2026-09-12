import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import {
  EXPECTED_COMMITTED,
  EXPECTED_OUTGOING,
} from "../../stock-engine/projection-definitions";

export interface DriftQueryRow extends Record<string, unknown> {
  stock_level_id: number | null;
  product_variant_id: number;
  location_id: number | null;
  lot_id: number | null;
  serial_id: number | null;
  field: string;
  projected: string;
  expected: string;
  difference: string;
}

type Executor = Pick<Db, "execute">;

/**
 * The reconciliation SQL catalog, lifted out of `inv-reconciliation.service.ts`
 * unchanged. It was 273 of that file's 580 lines and none of it was ever part of
 * the class — the service is 127 lines of `report`/`repair` sitting under a
 * module-level query catalog that dwarfed it.
 *
 * `reconciliationQueries` is re-exported from the service, so the 31 places that
 * import it from there are untouched.
 */
/**
 * The document-derived expected value of `on_order` for the row aliased `sl`.
 *
 * Outstanding, not ordered: `quantity - quantity_received` per line, clamped at
 * zero so an over-receipt on one line cannot eat another line's inbound. Only
 * SENT and PARTIAL orders count — a draft has not been placed, and a received,
 * closed or cancelled one is no longer on its way.
 *
 * The `me.id = (SELECT … LIMIT 1)` test is the load-bearing half: it reproduces
 * `addOnOrder`'s choice of row, so exactly one row per (variant, warehouse)
 * expects the figure and every other row expects zero. Aggregate any other way
 * and every row in the warehouse reads as drift.
 */
const EXPECTED_ON_ORDER: SQL = sql`
  COALESCE((
    SELECT SUM(GREATEST(0, pol.quantity::numeric - pol.quantity_received::numeric))
      FROM inv_locations me
      JOIN inv_po_lines pol
        ON pol.org_id = sl.org_id
       AND pol.product_variant_id = sl.product_variant_id
      JOIN inv_purchase_orders po
        ON po.org_id = pol.org_id
       AND po.id = pol.po_id
       AND po.warehouse_id = me.warehouse_id
     WHERE me.org_id = sl.org_id
       AND me.id = sl.location_id
       AND sl.lot_id IS NULL
       AND sl.serial_id IS NULL
       AND po.status IN ('SENT', 'PARTIAL')
       AND me.id = (
             SELECT anchor.id
               FROM inv_locations anchor
              WHERE anchor.org_id = me.org_id
                AND anchor.warehouse_id = me.warehouse_id
                AND anchor.is_active = true
                AND anchor.is_receivable = true
              ORDER BY anchor.id
              LIMIT 1)
  ), 0)`;

/**
 * The document-derived expected value of `outgoing_qty` for the row aliased
 * `sl`.
 *
 * Two halves, both from `recordPicked`'s doc comment, which is the authority on
 * what this bucket means:
 *
 *   picked and not yet shipped — pick lines at this (variant, location),
 *     belonging to a sales order that has not reached a shipped, invoiced,
 *     closed or cancelled state. The in-flight statuses are enumerated
 *     positively so that a status added later defaults to "no longer on the
 *     bench" rather than silently inflating the bucket.
 *
 *   less the part ACTIVE reservations cover — `committed` and `outgoing_qty`
 *     are disjoint by construction: reserved units are already out of
 *     availability through `committed`, and counting them again would subtract
 *     the same goods twice.
 *
 * Matched on (variant, location) with no lot or serial term, because that is
 * exactly what `recordPicked` updates on. Narrowing it to the full natural key
 * would report drift on every lot-tracked row the writer fans out to.
 */
/**
 * The six checks, as standalone queries.
 *
 * Exported because the real-database spec has to run *these*, not a
 * transcription of them: the first version of the committed check referenced
 * `res.qty` where the column is `reserved_qty`, the hand-copied spec passed, and
 * only booting the service found it.
 */
export const reconciliationQueries = {
  /**
   * on_hand, blocked_qty and quality_hold_qty against the ledger.
   *
   * Grouped by quantity_bucket: a movement says which quantity it moved, so a
   * quarantine movement contributes to quality_hold_qty and not to on_hand.
   * Compared as numeric, never as text — '5.0000' and '5.00' are the same
   * quantity and different strings.
   */
  bucketDrift(tx: Executor, orgId: string, where: SQL, cap: number) {
    return tx.execute<DriftQueryRow>(sql`
      WITH ledger AS (
        -- NEO-4 and NEO-11 widened the projection's natural key with the
        -- handling unit and the ownership, so the ledger has to be grouped the
        -- same way. Without it a pallet's hundred units and the loose row at the
        -- same bin are compared against one shared ledger total, and the check
        -- reports drift on stock that is perfectly reconciled -- the checker
        -- disagreeing with the writer, which is the failure this whole module
        -- was written to remove.
        SELECT product_variant_id, location_id, lot_id, serial_id, handling_unit_id,
               ownership, quantity_bucket,
               SUM(quantity_change::numeric) AS total
        FROM inv_stock_transactions
        WHERE org_id = ${orgId}
        GROUP BY product_variant_id, location_id, lot_id, serial_id, handling_unit_id,
                 ownership, quantity_bucket
      )
      SELECT sl.id AS stock_level_id, sl.product_variant_id, sl.location_id, sl.lot_id, sl.serial_id,
             b.field, b.projected::text, b.expected::text, (b.projected - b.expected)::text AS difference
      FROM inv_stock_levels sl
      CROSS JOIN LATERAL (
        VALUES
          ('on_hand', sl.on_hand::numeric, COALESCE((SELECT total FROM ledger l WHERE l.product_variant_id = sl.product_variant_id AND l.location_id IS NOT DISTINCT FROM sl.location_id AND l.lot_id IS NOT DISTINCT FROM sl.lot_id AND l.serial_id IS NOT DISTINCT FROM sl.serial_id AND l.handling_unit_id IS NOT DISTINCT FROM sl.handling_unit_id AND l.ownership = sl.ownership AND l.quantity_bucket = 'ON_HAND'), 0)),
          ('blocked_qty', COALESCE(sl.blocked_qty, 0)::numeric, COALESCE((SELECT total FROM ledger l WHERE l.product_variant_id = sl.product_variant_id AND l.location_id IS NOT DISTINCT FROM sl.location_id AND l.lot_id IS NOT DISTINCT FROM sl.lot_id AND l.serial_id IS NOT DISTINCT FROM sl.serial_id AND l.handling_unit_id IS NOT DISTINCT FROM sl.handling_unit_id AND l.ownership = sl.ownership AND l.quantity_bucket = 'BLOCKED'), 0)),
          ('quality_hold_qty', COALESCE(sl.quality_hold_qty, 0)::numeric, COALESCE((SELECT total FROM ledger l WHERE l.product_variant_id = sl.product_variant_id AND l.location_id IS NOT DISTINCT FROM sl.location_id AND l.lot_id IS NOT DISTINCT FROM sl.lot_id AND l.serial_id IS NOT DISTINCT FROM sl.serial_id AND l.handling_unit_id IS NOT DISTINCT FROM sl.handling_unit_id AND l.ownership = sl.ownership AND l.quantity_bucket = 'QUALITY_HOLD'), 0))
      ) AS b(field, projected, expected)
      WHERE ${where} AND b.projected <> b.expected
      ORDER BY sl.id, b.field
      LIMIT ${cap}
    `);
  },

  /** committed against the reservations that are supposed to have produced it. */
  committedDrift(tx: Executor, orgId: string, where: SQL, cap: number) {
    return tx.execute<DriftQueryRow>(sql`
      SELECT sl.id AS stock_level_id, sl.product_variant_id, sl.location_id, sl.lot_id, sl.serial_id,
             'committed' AS field,
             sl.committed::text AS projected,
             e.expected::text AS expected,
             (sl.committed::numeric - e.expected)::text AS difference
      FROM inv_stock_levels sl
      CROSS JOIN LATERAL (SELECT ${EXPECTED_COMMITTED} AS expected) e
      WHERE ${where} AND sl.committed::numeric <> e.expected
      ORDER BY sl.id
      LIMIT ${cap}
    `);
  },

  /** on_order against the purchase orders that are supposed to have produced it. */
  onOrderDrift(tx: Executor, orgId: string, where: SQL, cap: number) {
    return tx.execute<DriftQueryRow>(sql`
      SELECT sl.id AS stock_level_id, sl.product_variant_id, sl.location_id, sl.lot_id, sl.serial_id,
             'on_order' AS field,
             COALESCE(sl.on_order, 0)::text AS projected,
             e.expected::text AS expected,
             (COALESCE(sl.on_order, 0)::numeric - e.expected)::text AS difference
      FROM inv_stock_levels sl
      CROSS JOIN LATERAL (SELECT ${EXPECTED_ON_ORDER} AS expected) e
      WHERE ${where} AND COALESCE(sl.on_order, 0)::numeric <> e.expected
      ORDER BY sl.id
      LIMIT ${cap}
    `);
  },

  /** outgoing_qty against the picks that are supposed to have produced it. */
  outgoingDrift(tx: Executor, orgId: string, where: SQL, cap: number) {
    return tx.execute<DriftQueryRow>(sql`
      SELECT sl.id AS stock_level_id, sl.product_variant_id, sl.location_id, sl.lot_id, sl.serial_id,
             'outgoing_qty' AS field,
             COALESCE(sl.outgoing_qty, 0)::text AS projected,
             e.expected::text AS expected,
             (COALESCE(sl.outgoing_qty, 0)::numeric - e.expected)::text AS difference
      FROM inv_stock_levels sl
      CROSS JOIN LATERAL (SELECT ${EXPECTED_OUTGOING} AS expected) e
      WHERE ${where} AND COALESCE(sl.outgoing_qty, 0)::numeric <> e.expected
      ORDER BY sl.id
      LIMIT ${cap}
    `);
  },

  /**
   * Ledger rows whose own arithmetic does not hold.
   *
   * A CHECK constraint now makes this unrepresentable, so a hit here means a row
   * written before the constraint existed, or a constraint that has been dropped
   * — both worth surfacing rather than assuming away.
   */
  arithmeticAnomalies(tx: Executor, orgId: string, scopeSql: SQL, cap: number) {
    return tx.execute<DriftQueryRow>(sql`
      SELECT NULL::int AS stock_level_id, t.product_variant_id, t.location_id, t.lot_id, t.serial_id,
             'quantity_after' AS field,
             t.quantity_after::text AS projected,
             (t.quantity_before::numeric + t.quantity_change::numeric)::text AS expected,
             (t.quantity_after::numeric - t.quantity_before::numeric - t.quantity_change::numeric)::text AS difference
      FROM inv_stock_transactions t
      WHERE t.org_id = ${orgId} AND ${scopeSql}
        AND t.quantity_after::numeric <> t.quantity_before::numeric + t.quantity_change::numeric
      ORDER BY t.id
      LIMIT ${cap}
    `);
  },

  /** A projection row holding stock that no movement ever put there. */
  orphanProjections(tx: Executor, orgId: string, where: SQL, cap: number) {
    return tx.execute<DriftQueryRow>(sql`
      SELECT sl.id AS stock_level_id, sl.product_variant_id, sl.location_id, sl.lot_id, sl.serial_id,
             'on_hand' AS field, sl.on_hand::text AS projected, '0' AS expected, sl.on_hand::text AS difference
      FROM inv_stock_levels sl
      WHERE ${where}
        AND sl.on_hand::numeric <> 0
        AND NOT EXISTS (
          SELECT 1 FROM inv_stock_transactions t
          WHERE t.org_id = sl.org_id
            AND t.product_variant_id = sl.product_variant_id
            AND t.location_id IS NOT DISTINCT FROM sl.location_id
            AND t.lot_id IS NOT DISTINCT FROM sl.lot_id
            AND t.serial_id IS NOT DISTINCT FROM sl.serial_id
        )
      ORDER BY sl.id
      LIMIT ${cap}
    `);
  },

  /**
   * Rebuilds all six quantity buckets from their sources.
   *
   * `average_cost` is not one of them and is deliberately left alone: it is a
   * running weighted average, so only a sequential replay of the ledger could
   * rebuild it, and this is a set-based statement.
   *
   * Two properties this statement must keep. It takes `FOR UPDATE OF sl`, so a
   * concurrent writer to the same grain blocks rather than racing; and it
   * updates only rows that actually differ, so a repeat is a genuine no-op
   * rather than a no-op that still writes and still bumps `updated_at`. Every
   * expected value is computed from the row's key and other tables — never from
   * the bucket columns being rewritten — so the six can be repaired in one
   * statement without the order of assignment mattering.
   */
  rebuild(tx: Executor, orgId: string, where: SQL) {
    return tx.execute<{ id: number }>(sql`
      WITH ledger AS (
        -- Grouped on the same key as bucketDrift above, and for the same reason:
        -- NEO-4 and NEO-11 widened the projection with the handling unit and the
        -- ownership. This CTE was left at the five-column grain while the three
        -- subqueries below were widened, so every column it selected was one the
        -- rebuild then failed to find: 42703 column l.handling_unit_id does not
        -- exist, on every call, for every organisation. Nothing caught it
        -- because the only spec that executes this statement was skipped in
        -- every run the repository could perform.
        SELECT product_variant_id, location_id, lot_id, serial_id, handling_unit_id,
               ownership, quantity_bucket,
               SUM(quantity_change::numeric) AS total
        FROM inv_stock_transactions
        WHERE org_id = ${orgId}
        GROUP BY product_variant_id, location_id, lot_id, serial_id, handling_unit_id,
                 ownership, quantity_bucket
      ),
      target AS (
        SELECT sl.id,
               COALESCE((SELECT total FROM ledger l WHERE l.product_variant_id = sl.product_variant_id AND l.location_id IS NOT DISTINCT FROM sl.location_id AND l.lot_id IS NOT DISTINCT FROM sl.lot_id AND l.serial_id IS NOT DISTINCT FROM sl.serial_id AND l.handling_unit_id IS NOT DISTINCT FROM sl.handling_unit_id AND l.ownership = sl.ownership AND l.quantity_bucket = 'ON_HAND'), 0) AS on_hand,
               COALESCE((SELECT total FROM ledger l WHERE l.product_variant_id = sl.product_variant_id AND l.location_id IS NOT DISTINCT FROM sl.location_id AND l.lot_id IS NOT DISTINCT FROM sl.lot_id AND l.serial_id IS NOT DISTINCT FROM sl.serial_id AND l.handling_unit_id IS NOT DISTINCT FROM sl.handling_unit_id AND l.ownership = sl.ownership AND l.quantity_bucket = 'BLOCKED'), 0) AS blocked_qty,
               COALESCE((SELECT total FROM ledger l WHERE l.product_variant_id = sl.product_variant_id AND l.location_id IS NOT DISTINCT FROM sl.location_id AND l.lot_id IS NOT DISTINCT FROM sl.lot_id AND l.serial_id IS NOT DISTINCT FROM sl.serial_id AND l.handling_unit_id IS NOT DISTINCT FROM sl.handling_unit_id AND l.ownership = sl.ownership AND l.quantity_bucket = 'QUALITY_HOLD'), 0) AS quality_hold_qty,
               ${EXPECTED_COMMITTED} AS committed,
               ${EXPECTED_ON_ORDER} AS on_order,
               ${EXPECTED_OUTGOING} AS outgoing_qty
        FROM inv_stock_levels sl
        WHERE ${where}
        ORDER BY sl.id
        FOR UPDATE OF sl
      )
      UPDATE inv_stock_levels dest
      SET on_hand = target.on_hand,
          blocked_qty = target.blocked_qty,
          quality_hold_qty = target.quality_hold_qty,
          committed = target.committed,
          on_order = target.on_order,
          outgoing_qty = target.outgoing_qty
      FROM target
      WHERE dest.id = target.id
        -- A negative bucket sum is a genuine ledger anomaly, and writing it
        -- trips migration 0515's non-negative CHECK — which rolls back the whole
        -- statement, so one poisoned grain made the repair impossible for the
        -- entire organisation and returned a bare 500. Such a row is skipped and
        -- keeps being reported instead: the drift stays visible, and every other
        -- row is still repairable.
        AND target.blocked_qty >= 0
        AND target.quality_hold_qty >= 0
        AND target.committed >= 0
        AND target.on_order >= 0
        AND target.outgoing_qty >= 0
        AND (dest.on_hand::numeric <> target.on_hand
          OR COALESCE(dest.blocked_qty, 0)::numeric <> target.blocked_qty
          OR COALESCE(dest.quality_hold_qty, 0)::numeric <> target.quality_hold_qty
          OR dest.committed::numeric <> target.committed
          OR COALESCE(dest.on_order, 0)::numeric <> target.on_order
          OR COALESCE(dest.outgoing_qty, 0)::numeric <> target.outgoing_qty)
      RETURNING dest.id
    `);
  },
};
