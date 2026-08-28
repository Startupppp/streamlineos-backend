import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { DemandBaselineService } from "./demand-baseline.service";
import { SafetyStockPolicyService } from "./safety-stock-policy.service";
import { availableQtySumSql } from "../../stock-engine/available-sql";

export interface ReorderEvidenceLine {
  /** What this figure is. */
  label: string;
  value: string;
  /** Where it came from, so a planner can go and check it. */
  source: string;
}

export interface ReorderProposal {
  productVariantId: number;
  /** Null when the inputs cannot support a quantity. */
  suggestedQuantity: number | null;
  position: {
    onHand: number;
    committed: number;
    onOrder: number;
    available: number;
  };
  reorderPoint: number | null;
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
 */
@Injectable()
export class ReorderProposalService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly baselines: DemandBaselineService,
    private readonly safetyStock: SafetyStockPolicyService,
  ) {}

  private async position(orgId: string, productVariantId: number) {
    // A1. `available` was `onHand - committed` here — a two-term copy that
    // ignored blocked, quality-held and picked-not-shipped stock, so a
    // reorder proposal reasoned about a position the warehouse could not
    // actually sell.
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
      WHERE sl.org_id = ${orgId} AND sl.product_variant_id = ${productVariantId}
    `);
    return {
      onHand: Number(row?.on_hand ?? 0),
      committed: Number(row?.committed ?? 0),
      onOrder: Number(row?.on_order ?? 0),
      available: Number(row?.available ?? 0),
    };
  }

  async propose(
    orgId: string,
    productVariantId: number,
    options: { serviceLevel?: number; weeks?: number } = {},
  ): Promise<ReorderProposal> {
    const serviceLevel = options.serviceLevel ?? 0.95;
    const [position, baseline, policy] = await Promise.all([
      this.position(orgId, productVariantId),
      this.baselines.baseline(orgId, productVariantId, options),
      this.safetyStock.policyFor(orgId, productVariantId, { serviceLevel, ...options }),
    ]);

    const evidence: ReorderEvidenceLine[] = [
      {
        label: "On hand",
        value: position.onHand.toFixed(4),
        source: "inv_stock_levels, summed across locations",
      },
      {
        label: "Committed",
        value: position.committed.toFixed(4),
        source: "inv_stock_levels.committed — already promised to orders",
      },
      {
        label: "On order",
        value: position.onOrder.toFixed(4),
        source: "inv_stock_levels.on_order — already on its way",
      },
      {
        label: "Demand shape",
        value: policy.demandCategory,
        source: `Syntetos-Boylan classification over ${policy.demand.periods} weekly periods`,
      },
      {
        label: "Mean weekly demand",
        value: policy.demand.mean.toFixed(4),
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
        suggestedQuantity: null,
        position,
        reorderPoint: null,
        evidence,
        caveats,
        recommendation: policy.demandCategory === "no_demand" ? "hold" : "review",
      };
    }

    const reorderPoint = policy.policy.reorderPoint;
    evidence.push(
      {
        label: "Safety stock",
        value: policy.policy.safetyStock.toFixed(4),
        source: `${serviceLevel * 100}% service level, z=${policy.policy.z}, ${policy.policy.dominantVariance} variance dominates`,
      },
      {
        label: "Reorder point",
        value: reorderPoint.toFixed(4),
        source: "Lead-time demand plus safety stock",
      },
    );

    // On-order counts. Proposing against a position that ignores goods already
    // in transit is how a warehouse orders the same shortfall three weeks
    // running.
    const inventoryPosition = position.available + position.onOrder;
    const shortfall = reorderPoint - inventoryPosition;

    evidence.push({
      label: "Inventory position",
      value: inventoryPosition.toFixed(4),
      source: "Available plus on order — what will be here without acting",
    });

    if (shortfall <= 0) {
      return {
        productVariantId,
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
      suggestedQuantity: Number(shortfall.toFixed(4)),
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
