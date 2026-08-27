import { Inject, Injectable } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import type { ReconciliationQueryInput, RepairInput } from "./dto/reconciliation.schemas";

/**
 * Ledger-to-projection reconciliation — INV-104.
 *
 * `inv_stock_levels` is a projection: every figure in it should be derivable
 * from facts recorded elsewhere. Nothing checked that, so a lost update, a
 * partially applied repair or a direct write would leave the projection quietly
 * disagreeing with the ledger and every dashboard reading the projection.
 *
 * What is rebuildable, and what is not, is the important distinction here:
 *
 *   on_hand, blocked_qty, quality_hold_qty  — sums of ledger movements, by the
 *                                             bucket each movement names
 *   committed                               — sum of ACTIVE reservations; the
 *                                             reservation service moves it
 *                                             directly and writes no ledger row
 *   on_order, outgoing_qty                  — derived from open documents, not
 *                                             ledgerised at all, so this report
 *                                             does not claim to check them
 *
 * Reporting a figure as reconciled when nothing reconciles it would be worse
 * than not reporting it.
 */

export type ReconciliationCheck =
  | "projection_vs_ledger"
  | "committed_vs_reservations"
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
 * The four checks, as standalone queries.
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
        SELECT product_variant_id, location_id, lot_id, serial_id, quantity_bucket,
               SUM(quantity_change::numeric) AS total
        FROM inv_stock_transactions
        WHERE org_id = ${orgId}
        GROUP BY product_variant_id, location_id, lot_id, serial_id, quantity_bucket
      )
      SELECT sl.id AS stock_level_id, sl.product_variant_id, sl.location_id, sl.lot_id, sl.serial_id,
             b.field, b.projected::text, b.expected::text, (b.projected - b.expected)::text AS difference
      FROM inv_stock_levels sl
      CROSS JOIN LATERAL (
        VALUES
          ('on_hand', sl.on_hand::numeric, COALESCE((SELECT total FROM ledger l WHERE l.product_variant_id = sl.product_variant_id AND l.location_id IS NOT DISTINCT FROM sl.location_id AND l.lot_id IS NOT DISTINCT FROM sl.lot_id AND l.serial_id IS NOT DISTINCT FROM sl.serial_id AND l.quantity_bucket = 'ON_HAND'), 0)),
          ('blocked_qty', COALESCE(sl.blocked_qty, 0)::numeric, COALESCE((SELECT total FROM ledger l WHERE l.product_variant_id = sl.product_variant_id AND l.location_id IS NOT DISTINCT FROM sl.location_id AND l.lot_id IS NOT DISTINCT FROM sl.lot_id AND l.serial_id IS NOT DISTINCT FROM sl.serial_id AND l.quantity_bucket = 'BLOCKED'), 0)),
          ('quality_hold_qty', COALESCE(sl.quality_hold_qty, 0)::numeric, COALESCE((SELECT total FROM ledger l WHERE l.product_variant_id = sl.product_variant_id AND l.location_id IS NOT DISTINCT FROM sl.location_id AND l.lot_id IS NOT DISTINCT FROM sl.lot_id AND l.serial_id IS NOT DISTINCT FROM sl.serial_id AND l.quantity_bucket = 'QUALITY_HOLD'), 0))
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
             COALESCE(r.total, 0)::text AS expected,
             (sl.committed::numeric - COALESCE(r.total, 0))::text AS difference
      FROM inv_stock_levels sl
      LEFT JOIN LATERAL (
        SELECT SUM(res.reserved_qty::numeric) AS total
        FROM inv_stock_reservations res
        WHERE res.org_id = sl.org_id
          AND res.product_variant_id = sl.product_variant_id
          AND res.location_id IS NOT DISTINCT FROM sl.location_id
          AND res.lot_id IS NOT DISTINCT FROM sl.lot_id
          AND res.serial_id IS NOT DISTINCT FROM sl.serial_id
          AND res.status = 'ACTIVE'
      ) r ON TRUE
      WHERE ${where} AND sl.committed::numeric <> COALESCE(r.total, 0)
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
   * Rebuilds the ledger-derived buckets. Buckets the ledger does not describe
   * (on_order, outgoing_qty) are left exactly as they were rather than zeroed on
   * the way past.
   */
  rebuild(tx: Executor, orgId: string, where: SQL) {
    return tx.execute<{ id: number }>(sql`
      WITH ledger AS (
        SELECT product_variant_id, location_id, lot_id, serial_id, quantity_bucket,
               SUM(quantity_change::numeric) AS total
        FROM inv_stock_transactions
        WHERE org_id = ${orgId}
        GROUP BY product_variant_id, location_id, lot_id, serial_id, quantity_bucket
      ),
      target AS (
        SELECT sl.id,
               COALESCE((SELECT total FROM ledger l WHERE l.product_variant_id = sl.product_variant_id AND l.location_id IS NOT DISTINCT FROM sl.location_id AND l.lot_id IS NOT DISTINCT FROM sl.lot_id AND l.serial_id IS NOT DISTINCT FROM sl.serial_id AND l.quantity_bucket = 'ON_HAND'), 0) AS on_hand,
               COALESCE((SELECT total FROM ledger l WHERE l.product_variant_id = sl.product_variant_id AND l.location_id IS NOT DISTINCT FROM sl.location_id AND l.lot_id IS NOT DISTINCT FROM sl.lot_id AND l.serial_id IS NOT DISTINCT FROM sl.serial_id AND l.quantity_bucket = 'BLOCKED'), 0) AS blocked_qty,
               COALESCE((SELECT total FROM ledger l WHERE l.product_variant_id = sl.product_variant_id AND l.location_id IS NOT DISTINCT FROM sl.location_id AND l.lot_id IS NOT DISTINCT FROM sl.lot_id AND l.serial_id IS NOT DISTINCT FROM sl.serial_id AND l.quantity_bucket = 'QUALITY_HOLD'), 0) AS quality_hold_qty
        FROM inv_stock_levels sl
        WHERE ${where}
        ORDER BY sl.id
        FOR UPDATE OF sl
      )
      UPDATE inv_stock_levels dest
      SET on_hand = target.on_hand,
          blocked_qty = target.blocked_qty,
          quality_hold_qty = target.quality_hold_qty
      FROM target
      WHERE dest.id = target.id
        AND (dest.on_hand::numeric <> target.on_hand
          OR COALESCE(dest.blocked_qty, 0)::numeric <> target.blocked_qty
          OR COALESCE(dest.quality_hold_qty, 0)::numeric <> target.quality_hold_qty)
      RETURNING dest.id
    `);
  },
};

/**
 * The tenant/warehouse/product predicate the checks share. `sl` is the
 * projection alias every one of them uses.
 */
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
    // One extra row distinguishes "exactly at the cap" from "there is more".
    const cap = query.limit + 1;

    const [buckets, committed, arithmetic, orphans] = await Promise.all([
      reconciliationQueries.bucketDrift(this.db, orgId, where, cap),
      reconciliationQueries.committedDrift(this.db, orgId, where, cap),
      reconciliationQueries.arithmeticAnomalies(this.db, orgId, scope.location(sql.raw("t.location_id")), cap),
      reconciliationQueries.orphanProjections(this.db, orgId, where, cap),
    ]);

    const drift: DriftRow[] = [
      ...buckets.map((r) => this.toDrift("projection_vs_ledger", r)),
      ...committed.map((r) => this.toDrift("committed_vs_reservations", r)),
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
      checked: ["projection_vs_ledger", "committed_vs_reservations", "ledger_arithmetic", "orphan_projection"],
      unreconcilable: [
        "on_order — derived from open purchase orders, never written to the ledger",
        "outgoing_qty — derived from open picks and shipments, never written to the ledger",
      ],
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
   * Rebuilds the ledger-derived buckets from the ledger.
   *
   * This rewrites a projection, not history: the movements themselves are never
   * touched, and a bucket the ledger does not describe (on_order, outgoing_qty)
   * is left exactly as it was rather than being zeroed on the way past.
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
