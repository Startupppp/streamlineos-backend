import { Inject, Injectable } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import type { ReconciliationQueryInput, RepairInput } from "./dto/reconciliation.schemas";
import { reconciliationQueries } from "./lib/reconciliation-queries";
import type { DriftQueryRow } from "./lib/reconciliation-queries";

export type { DriftQueryRow };

export { reconciliationQueries };

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
