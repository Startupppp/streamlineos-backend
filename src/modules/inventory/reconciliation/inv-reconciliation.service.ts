import { Inject, Injectable } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import type { ReconciliationQueryInput, RepairInput } from "./dto/reconciliation.schemas";
import {
  EXPECTED_COMMITTED,
  EXPECTED_OUTGOING,
} from "../stock-engine/projection-definitions";

/**
 * Ledger-to-projection reconciliation — INV-104, extended by A2.
 *
 * `inv_stock_levels` is a projection: every figure in it should be derivable
 * from facts recorded elsewhere. Nothing checked that, so a lost update, a
 * partially applied repair or a direct write would leave the projection quietly
 * disagreeing with the facts and every dashboard reading the projection.
 *
 * All six quantity buckets are now checked, and all six are rebuildable. Each
 * has its own source of truth:
 *
 *   on_hand, blocked_qty, quality_hold_qty  sums of ledger movements, by the
 *                                           bucket each movement names
 *   committed                               sum of ACTIVE reservations at the
 *                                           row's grain
 *   on_order                                outstanding quantity on purchase
 *                                           orders that are SENT or PARTIAL
 *   outgoing_qty                            picked and not yet shipped, less
 *                                           the part ACTIVE reservations cover
 *
 * The last two were previously declared un-checkable, on the grounds that
 * nothing wrote them. A1 gave them a writer — `StockProjectionService` — so
 * that is no longer true, and a report that names a fault it cannot fix (which
 * `committed` was, being checked but never repaired) is half a tool.
 *
 * Three things about the derivations are worth knowing before reading them:
 *
 *  1. **Every expected value is a function of the row's *key* alone**
 *     (org, variant, location, lot, serial) and of other tables — never of the
 *     bucket columns being rewritten. That is what makes the rebuild idempotent
 *     and makes repairing six buckets in one statement order-independent.
 *     In particular `outgoing_qty` subtracts the *reservation-derived*
 *     `committed`, not the projected one, so a corrupt `committed` cannot
 *     propagate into the outgoing figure.
 *
 *  2. **`on_order` lives on one row per (variant, warehouse).** A purchase
 *     order names a warehouse, not a bin, so `addOnOrder` parks the whole
 *     figure on the warehouse's first active receivable location, with a null
 *     lot and serial. The expected value aggregates the same way: every other
 *     row in the warehouse expects zero. A warehouse with no receivable
 *     location has nowhere to hold the figure, and both the check and the
 *     repair are silent about it — neither invents a projection row.
 *
 *  3. **`outgoing_qty` is derived from *every* pick line, not only the ones the
 *     sales-order writer drives.** `PickWaveService` records picks and never
 *     touches the bucket, so wave-picked stock shows up here as
 *     `outgoing_vs_picks` drift. That is a real gap in the writer rather than a
 *     false positive: the units are picked, they are not shipped, and
 *     availability should not be offering them. Deriving instead from
 *     "whatever `SoFulfillmentService` happens to write" would be circular and
 *     would have hidden the gap. A substituted wave line is counted at its own
 *     variant's `quantity_picked` only; the substitute itself is not modelled
 *     by the bucket at all.
 *
 * What remains unreconcilable is listed on the report, and stays honest:
 * reporting a figure as reconciled when nothing reconciles it would be worse
 * than not reporting it.
 */

export type ReconciliationCheck =
  | "projection_vs_ledger"
  | "committed_vs_reservations"
  | "on_order_vs_purchase_orders"
  | "outgoing_vs_picks"
  | "ledger_arithmetic"
  | "orphan_projection";

export interface DriftRow {
  check: ReconciliationCheck;
  stockLevelId: number | null;
  productVariantId: number;
  locationId: number | null;
  lotId: number | null;
  serialId: number | null;
  field: string;
  projected: string;
  expected: string;
  difference: string;
}

export interface ReconciliationReport {
  generatedAt: string;
  scope: { warehouseKey: string; warehouseId: number | null; productVariantId: number | null };
  checked: ReconciliationCheck[];
  unreconcilable: string[];
  drift: DriftRow[];
  driftCount: number;
  truncated: boolean;
}

interface DriftQueryRow extends Record<string, unknown> {
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

/**
 * The tenant/warehouse/product predicate the checks share. `sl` is the
 * projection alias every one of them uses.
 */
/** The same tenant/warehouse/product narrowing, against the ledger alias `t`. */
export function ledgerFilters(
  scopeSql: SQL,
  orgId: string,
  warehouseId: number | null,
  productVariantId: number | null,
): SQL {
  const parts: SQL[] = [scopeSql];
  if (warehouseId != null)
    parts.push(sql`t.location_id IN (SELECT id FROM inv_locations WHERE org_id = ${orgId} AND warehouse_id = ${warehouseId})`);
  if (productVariantId != null) parts.push(sql`t.product_variant_id = ${productVariantId}`);
  return sql.join(parts, sql` AND `);
}

export function reconciliationFilters(
  orgId: string,
  scopeSql: SQL,
  warehouseId: number | null,
  productVariantId: number | null,
): SQL {
  const parts: SQL[] = [sql`sl.org_id = ${orgId}`, scopeSql];
  if (warehouseId != null)
    parts.push(sql`sl.location_id IN (SELECT id FROM inv_locations WHERE org_id = ${orgId} AND warehouse_id = ${warehouseId})`);
  if (productVariantId != null) parts.push(sql`sl.product_variant_id = ${productVariantId}`);
  return sql.join(parts, sql` AND `);
}

/**
 * What this report still does not claim to check.
 *
 * One entry, and it is a genuine one rather than a bucket nobody got round to:
 * every quantity bucket is now derived from documents or from the ledger.
 */
const UNRECONCILABLE = [
  // Reported by `ledger_arithmetic` and not repairable by `rebuild`, which
  // writes only `inv_stock_levels`. A caller computing "repairable = checked
  // minus unreconcilable" otherwise applies a repair that returns rowsChanged
  // 0 and leaves the same row drifting forever.
  "ledger_arithmetic (a fact row whose own arithmetic is wrong cannot be repaired by rebuilding the projection)",
  "average_cost — a running weighted average, not a quantity bucket: it depends on the order movements arrived in, so only a sequential replay could rebuild it, and this repair is set-based",
];

@Injectable()
export class InvReconciliationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly audit: InventoryAuditService,
  ) {}

  async report(
    orgId: string,
    userId: string,
    query: ReconciliationQueryInput,
  ): Promise<ReconciliationReport> {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const scopeSql = scope.location(sql.raw("sl.location_id"));
    const where = reconciliationFilters(orgId, scopeSql, query.warehouseId ?? null, query.productVariantId ?? null);
    // The ledger check runs against `inv_stock_transactions`, so it needs the
    // caller's filters restated against `t`. It previously took only the
    // location scope, so asking about one warehouse and one variant returned
    // ledger anomalies for every other warehouse and variant — and they
    // consumed the shared row cap, hiding the rows that were asked for.
    const ledgerWhere = ledgerFilters(
      scope.location(sql.raw("t.location_id")),
      orgId,
      query.warehouseId ?? null,
      query.productVariantId ?? null,
    );
    // One extra row distinguishes "exactly at the cap" from "there is more".
    const cap = query.limit + 1;

    const [buckets, committed, onOrder, outgoing, arithmetic, orphans] = await Promise.all([
      reconciliationQueries.bucketDrift(this.db, orgId, where, cap),
      reconciliationQueries.committedDrift(this.db, orgId, where, cap),
      reconciliationQueries.onOrderDrift(this.db, orgId, where, cap),
      reconciliationQueries.outgoingDrift(this.db, orgId, where, cap),
      reconciliationQueries.arithmeticAnomalies(this.db, orgId, ledgerWhere, cap),
      reconciliationQueries.orphanProjections(this.db, orgId, where, cap),
    ]);

    const drift: DriftRow[] = [
      ...buckets.map((r) => this.toDrift("projection_vs_ledger", r)),
      ...committed.map((r) => this.toDrift("committed_vs_reservations", r)),
      ...onOrder.map((r) => this.toDrift("on_order_vs_purchase_orders", r)),
      ...outgoing.map((r) => this.toDrift("outgoing_vs_picks", r)),
      ...arithmetic.map((r) => this.toDrift("ledger_arithmetic", r)),
      ...orphans.map((r) => this.toDrift("orphan_projection", r)),
    ];

    return {
      generatedAt: new Date().toISOString(),
      scope: {
        warehouseKey: scope.key,
        warehouseId: query.warehouseId ?? null,
        productVariantId: query.productVariantId ?? null,
      },
      checked: [
        "projection_vs_ledger",
        "committed_vs_reservations",
        "on_order_vs_purchase_orders",
        "outgoing_vs_picks",
        "ledger_arithmetic",
        "orphan_projection",
      ],
      unreconcilable: [...UNRECONCILABLE],
      drift: drift.slice(0, query.limit),
      driftCount: drift.length,
      truncated: drift.length > query.limit,
    };
  }

  private toDrift(check: ReconciliationCheck, row: DriftQueryRow): DriftRow {
    return {
      check,
      stockLevelId: row.stock_level_id,
      productVariantId: row.product_variant_id,
      locationId: row.location_id,
      lotId: row.lot_id,
      serialId: row.serial_id,
      field: row.field,
      projected: row.projected,
      expected: row.expected,
      difference: row.difference,
    };
  }

  /**
   * Rebuilds every quantity bucket from the facts that define it.
   *
   * This rewrites a projection, not history: the movements, reservations,
   * purchase orders and pick lines it reads are never touched. `average_cost`
   * is left exactly as it was rather than zeroed on the way past.
   *
   * Dry run by default, and re-running after a successful repair reports zero
   * rows because there is no longer any difference to write.
   */
  async repair(orgId: string, userId: string, input: RepairInput) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const where = reconciliationFilters(
      orgId,
      scope.location(sql.raw("sl.location_id")),
      input.warehouseId ?? null,
      input.productVariantId ?? null,
    );

    if (!input.apply) {
      const preview = await this.report(orgId, userId, {
        warehouseId: input.warehouseId,
        productVariantId: input.productVariantId,
        limit: 100,
      });
      return { applied: false, rowsChanged: 0, preview };
    }

    const result = await this.db.transaction(async (tx) => {
      const changed = await reconciliationQueries.rebuild(tx, orgId, where);

      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "stock.projection.repaired",
        resourceType: "stock_level",
        resourceId: `${orgId}:projection-repair`,
        after: {
          reason: input.reason,
          rowsChanged: changed.length,
          warehouseId: input.warehouseId ?? null,
          productVariantId: input.productVariantId ?? null,
        },
      });

      return changed.length;
    });

    return { applied: true, rowsChanged: result, preview: null };
  }
}
