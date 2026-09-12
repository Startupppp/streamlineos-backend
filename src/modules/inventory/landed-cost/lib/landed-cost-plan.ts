import { UnprocessableEntityException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { type Db } from "../../../../db/drizzle.module";
import { addDec, cmpDec, isPositive } from "../../stock-engine/decimal";
import {
  planRevaluation,
  type LandedCostBasis,
  type LayerSnapshot,
  type RevaluationPlan,
} from "./layer-revaluation";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface LayerRow extends Record<string, unknown> {
  id: number;
  product_variant_id: number;
  costing_method: string;
  quantity: string;
  unit_cost: string;
  total_value: string;
  remaining_quantity: string;
  remaining_value: string;
}

/**
 * The receipt's cost layers, locked in the order the issue path locks them.
 *
 * `FOR UPDATE` so an issue cannot consume a layer between the snapshot this
 * plans against and the write that revalues it — otherwise a concurrent
 * shipment would draw at the old rate while this decided that quantity was
 * still in stock, and the freight would capitalise onto units that had already
 * gone. `ORDER BY created_at, id` matches `lockConsumableLayers` exactly: two
 * transactions taking the same rows in the same order queue instead of
 * deadlocking.
 */
async function lockReceiptLayers(
  tx: Tx,
  orgId: string,
  grnId: number,
): Promise<LayerSnapshot[]> {
  const rows = await tx.execute<LayerRow>(sql`
      SELECT id, product_variant_id, costing_method, quantity, unit_cost,
             total_value, remaining_quantity, remaining_value
      FROM inv_valuation_layers
      WHERE org_id = ${orgId}
        AND source_type = 'inv_grn'
        AND source_id = ${String(grnId)}
      ORDER BY created_at ASC, id ASC
      FOR UPDATE`);

  return rows.map((row) => ({
    id: Number(row.id),
    productVariantId: Number(row.product_variant_id),
    costingMethod: String(row.costing_method),
    quantity: String(row.quantity),
    unitCost: String(row.unit_cost),
    totalValue: String(row.total_value),
    remainingQuantity: String(row.remaining_quantity),
    remainingValue: String(row.remaining_value),
  }));
}

/**
 * The one identity this feature claims: nothing the voucher charged is lost
 * between the invoice and the layers.
 *
 * Checked here rather than trusted, because every failure mode of an
 * apportionment is silent — a lost ten-thousandth does not throw, it just
 * leaves the general ledger unbalanced by an amount too small to notice per
 * voucher and exactly large enough to make a month-end reconciliation
 * unexplainable.
 */
function assertNothingLost(chargeTotal: string, plan: RevaluationPlan): void {
  const accounted = addDec(plan.capitalisedTotal, plan.expensedTotal);
  if (cmpDec(accounted, chargeTotal) !== 0) {
    throw new UnprocessableEntityException(
      `Landed-cost apportionment did not balance: ${chargeTotal} charged, ${accounted} allocated`,
    );
  }
}

/**
 * Everything between the voucher's lock and the first write: take the receipt's
 * layers, refuse the cases that have no defensible apportionment, and hand back
 * a plan that balances.
 *
 * This half decides; the caller writes. Nothing here mutates a row, so every
 * exception it raises leaves the voucher exactly as it found it — which is why
 * the refusals belong on this side of the line rather than interleaved with the
 * updates. Three of them are the ones the service's own header names as
 * deliberate refusals rather than guesses:
 *
 *   · a WEIGHTED_AVERAGE variant, because a later issue on that method costs at
 *     `inv_stock_levels.average_cost`, not at the layer, and moving the running
 *     average is a write to the stock engine's own projection;
 *   · a receipt with no cost layers, which means it was never posted;
 *   · a VALUE-basis voucher against a receipt worth nothing, where there is no
 *     defensible proportion to divide by.
 */
export async function planLandedCost(
  tx: Tx,
  orgId: string,
  grnId: number,
  basis: LandedCostBasis,
  chargeTotal: string,
): Promise<RevaluationPlan> {
  const layers = await lockReceiptLayers(tx, orgId, grnId);
  if (layers.length === 0) {
    throw new UnprocessableEntityException(
      "This goods receipt produced no cost layers, so there is nothing to land a cost onto",
    );
  }

  const averaged = layers.filter((layer) => layer.costingMethod === "WEIGHTED_AVERAGE");
  if (averaged.length > 0) {
    // Refused loudly rather than mis-costed quietly. On weighted average the
    // issue path draws at `inv_stock_levels.average_cost` and never looks at
    // the layer, so revaluing the layer here would look entirely successful,
    // change the valuation report, and leave every subsequent issue costing at
    // the old average — the worst of the three possible outcomes.
    throw new UnprocessableEntityException(
      `Landed cost is not yet supported for weighted-average variants (${averaged.length} of ${layers.length} layers on this receipt): applying it would revalue the layers without moving the running average that issues actually cost at`,
    );
  }

  const weightTotal = layers.reduce(
    (sum, layer) => addDec(sum, basis === "VALUE" ? layer.totalValue : layer.quantity),
    "0.0000",
  );
  if (!isPositive(weightTotal)) {
    throw new UnprocessableEntityException(
      basis === "VALUE"
        ? "This receipt's cost layers are worth nothing, so a value-based allocation has no proportion to divide by — raise the voucher on the QUANTITY basis"
        : "This receipt's cost layers hold no quantity, so a quantity-based allocation has no proportion to divide by",
    );
  }

  const plan = planRevaluation(chargeTotal, basis, layers);
  assertNothingLost(chargeTotal, plan);
  return plan;
}
