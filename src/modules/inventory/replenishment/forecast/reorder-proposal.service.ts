import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { DemandBaselineService, type DemandScope } from "./demand-baseline.service";
import { SafetyStockPolicyService } from "./safety-stock-policy.service";
import { availableQtySumSql } from "../../stock-engine/available-sql";
import { addDec, cmpDec, subDec } from "../../stock-engine/decimal";
import { toExact } from "./exact";

export interface ReorderEvidenceLine {
  /** What this figure is. */
  label: string;
  value: string;
  /** Where it came from, so a planner can go and check it. */
  source: string;
}

/**
 * C1. Every figure here is an exact `numeric(18,4)` decimal string, not a
 * float. These are the numbers a buyer acts on and a purchase order is written
 * from; the estimates they were derived from stay behind in
 * `SafetyStockPolicyResult`, where they are honestly labelled as statistics.
 */
export interface ReorderPosition {
  onHand: string;
  committed: string;
  onOrder: string;
  available: string;
}

export interface ReorderProposal {
  productVariantId: number;
  /** Null when the proposal covers the whole organisation. */
  warehouseId: number | null;
  /** Null when the inputs cannot support a quantity. */
  suggestedQuantity: string | null;
  position: ReorderPosition;
  reorderPoint: string | null;
  evidence: ReorderEvidenceLine[];
  /** Everything that makes this proposal less trustworthy, stated. */
  caveats: string[];
  /**
   * `propose` when the arithmetic holds, `review` when a human has to decide,
   * `hold` when there is nothing to act on.
   */
  recommendation: "propose" | "review" | "hold";
}

/**
 * INV-305 — a reorder proposal that shows its working.
 *
 * The requirement is explainability, and the test of it is not whether a
 * rationale string exists but whether a planner who disagrees can find the
 * figure they disagree with. So every number carries where it came from, and
 * the quantity is derived from those numbers rather than presented beside them.
 *
 * The other half is knowing when not to propose. A replenishment engine that
 * always produces a number will produce one for a SKU with six weeks of history
 * and an unmeasured supplier, and that number will look exactly like the good
 * ones. `review` and `hold` exist so the confident cases stay confident.
 *
 * C1 gave it a warehouse and exact arithmetic. Both were the same bug seen from
 * two sides: an org-wide position summed across sites answers for none of them,
 * and a shortfall computed in floats decides "order" or "hold" on a comparison
 * that can be wrong in the fourth decimal place — which is precisely where a
 * position sits when it is exactly at its reorder point.
 */
@Injectable()
export class ReorderProposalService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly baselines: DemandBaselineService,
    private readonly safetyStock: SafetyStockPolicyService,
  ) {}

  private async position(
    orgId: string,
    productVariantId: number,
    warehouseId: number | null,
  ): Promise<ReorderPosition> {
    // A1. `available` was `onHand - committed` here — a two-term copy that
    // ignored blocked, quality-held and picked-not-shipped stock, so a
    // reorder proposal reasoned about a position the warehouse could not
    // actually sell.
    //
    // C1. The warehouse gate is an EXISTS on the row's own location rather than
    // a join, matching `available-sql.ts`: a join is an argument every caller
    // has to remember to pass, and forgetting it is silent.
    const warehouseFilter =
      warehouseId === null
        ? sql`TRUE`
        : sql`EXISTS (
            SELECT 1 FROM inv_locations pos_loc
            WHERE pos_loc.id = sl.location_id
              AND pos_loc.org_id = sl.org_id
              AND pos_loc.warehouse_id = ${warehouseId}
          )`;

    const [row] = await this.db.execute<{
      on_hand: string;
      committed: string;
      on_order: string;
      available: string;
    }>(sql`
      SELECT COALESCE(SUM(sl.on_hand), 0)::text AS on_hand,
             COALESCE(SUM(sl.committed), 0)::text AS committed,
             COALESCE(SUM(sl.on_order), 0)::text AS on_order,
             ${availableQtySumSql("sl")}::text AS available
      FROM inv_stock_levels sl
      WHERE sl.org_id = ${orgId}
        AND sl.product_variant_id = ${productVariantId}
        AND ${warehouseFilter}
    `);
    return {
      onHand: row?.on_hand ?? "0.0000",
      committed: row?.committed ?? "0.0000",
      onOrder: row?.on_order ?? "0.0000",
      available: row?.available ?? "0.0000",
    };
  }

  async propose(
    orgId: string,
    productVariantId: number,
    options: { serviceLevel?: number; weeks?: number } & DemandScope = {},
  ): Promise<ReorderProposal> {
    const serviceLevel = options.serviceLevel ?? 0.95;
    const warehouseId = options.warehouseId ?? null;
    const [position, baseline, policy] = await Promise.all([
      this.position(orgId, productVariantId, warehouseId),
      this.baselines.baseline(orgId, productVariantId, options),
      this.safetyStock.policyFor(orgId, productVariantId, { serviceLevel, ...options }),
    ]);

    const scopeSource = warehouseId === null ? "summed across every location" : "summed across this warehouse";

    const evidence: ReorderEvidenceLine[] = [
      {
        label: "On hand",
        value: position.onHand,
        source: `inv_stock_levels, ${scopeSource}`,
      },
      {
        label: "Committed",
        value: position.committed,
        source: "inv_stock_levels.committed — already promised to orders",
      },
      {
        label: "On order",
        value: position.onOrder,
        source: "inv_stock_levels.on_order — already on its way",
      },
      {
        label: "Demand shape",
        value: policy.demandCategory,
        source: `Syntetos-Boylan classification over ${policy.demand.periods} weekly periods`,
      },
      {
        label: "Mean weekly demand",
        value: toExact(policy.demand.mean),
        source: "SALE and RESERVATION_CONSUME movements, dense weekly series",
      },
      {
        label: "Lead time",
        value: `${policy.leadTime.periods.toFixed(2)} weeks`,
        source:
          policy.leadTime.observations > 0
            ? `Measured from ${policy.leadTime.observations} receipt(s)`
            : "Configured default — no receipts on record",
      },
    ];

    if (baseline.champion) {
      evidence.push({
        label: "Forecast baseline",
        value: `${baseline.champion.method} (MAE ${baseline.champion.metrics.mae})`,
        source: "Rolling-origin backtest over the demand history",
      });
    }

    const caveats = [...policy.notes];
    if (baseline.insufficientReason) caveats.push(baseline.insufficientReason);
    if (baseline.shapeNote) caveats.push(baseline.shapeNote);

    // No policy means the model does not describe this demand. That is a
    // decision for a human rather than a reason to fall back to a cruder
    // formula and present the result identically.
    if (!policy.applicable || policy.policy === null) {
      return {
        productVariantId,
        warehouseId,
        suggestedQuantity: null,
        position,
        reorderPoint: null,
        evidence,
        caveats,
        recommendation: policy.demandCategory === "no_demand" ? "hold" : "review",
      };
    }

    // The one crossing back from statistics to a quantity: the reorder point
    // stops being an estimate here and becomes a number somebody buys against.
    const reorderPoint = toExact(policy.policy.reorderPoint);
    evidence.push(
      {
        label: "Safety stock",
        value: toExact(policy.policy.safetyStock),
        source: `${serviceLevel * 100}% service level, z=${policy.policy.z}, ${policy.policy.dominantVariance} variance dominates`,
      },
      {
        label: "Reorder point",
        value: reorderPoint,
        source: "Lead-time demand plus safety stock",
      },
    );

    // On-order counts. Proposing against a position that ignores goods already
    // in transit is how a warehouse orders the same shortfall three weeks
    // running. Exact arithmetic, because this subtraction is the decision.
    const inventoryPosition = addDec(position.available, position.onOrder);
    const shortfall = subDec(reorderPoint, inventoryPosition);

    evidence.push({
      label: "Inventory position",
      value: inventoryPosition,
      source: "Available plus on order — what will be here without acting",
    });

    if (cmpDec(shortfall, "0") <= 0) {
      return {
        productVariantId,
        warehouseId,
        suggestedQuantity: null,
        position,
        reorderPoint,
        evidence,
        caveats,
        recommendation: "hold",
      };
    }

    return {
      productVariantId,
      warehouseId,
      suggestedQuantity: shortfall,
      position,
      reorderPoint,
      evidence,
      caveats,
      // A caveat does not veto a proposal, but it does mean somebody should
      // look at it rather than approving a batch unread.
      recommendation: caveats.length > 0 ? "review" : "propose",
    };
  }
}
