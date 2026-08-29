import { addDec, cmpDec, mulDec, subDec } from "../../stock-engine/decimal";
import {
  apportion,
  fromScaled,
  splitByRemaining,
  toScaled,
  type ApportionTarget,
} from "./apportion";

export type LandedCostBasis = "VALUE" | "QUANTITY";

/** A cost layer as it stands the moment a voucher is applied. */
export interface LayerSnapshot {
  readonly id: number;
  readonly productVariantId: number;
  /** The method recorded on the layer, which is the method at receipt time. */
  readonly costingMethod: string;
  readonly quantity: string;
  readonly unitCost: string;
  readonly totalValue: string;
  readonly remainingQuantity: string;
  readonly remainingValue: string;
}

/** What one layer absorbs, and what it could not. */
export interface LayerRevaluation {
  readonly layerId: number;
  readonly productVariantId: number;
  readonly costingMethod: string;
  readonly weight: string;
  readonly allocated: string;
  readonly capitalised: string;
  readonly expensed: string;
  readonly layerQuantity: string;
  readonly remainingQuantity: string;
  readonly unitCostBefore: string;
  readonly unitCostAfter: string;
  readonly remainingValueAfter: string;
  readonly totalValueAfter: string;
  /** False when nothing reached the layer, so the row is left untouched. */
  readonly writesLayer: boolean;
}

export interface RevaluationPlan {
  readonly rows: readonly LayerRevaluation[];
  readonly capitalisedTotal: string;
  readonly expensedTotal: string;
}

const ZERO = "0.0000";
const SCALE = 10000n;

/**
 * G5 — what applying a landed-cost voucher does to a receipt's cost layers.
 *
 * Pure: it takes the layers as they stand and returns the writes to make, so the
 * arithmetic can be exercised against hand-worked figures without a database and
 * the service that performs the writes has no arithmetic of its own to get
 * wrong.
 *
 * Three decisions are encoded here, and each is a decision rather than a
 * consequence.
 *
 * **The share belonging to units that have already left is expensed, not
 * capitalised.** Cost put into a layer is recovered only when that layer is
 * issued. Freight attributable to units issued last week can never be recovered
 * — the sale is already on the books at the old cost, and the ledger is
 * append-only, so its COGS cannot be restated. Adding that share to the
 * remaining units would overstate the stock still on the shelf and misattribute
 * the cost to whoever buys it next. It is a period cost of the month the
 * carrier's invoice landed in, which is where every ERP that cannot rewrite
 * history puts it.
 *
 * **A STANDARD-cost layer capitalises nothing.** Its cost *is* the standard;
 * that is what standard costing means. Every penny of freight on it is a
 * purchase price variance by definition, and pushing it into the layer would
 * make the standard not the standard.
 *
 * **The rate is floored, and what floor rounding drops is expensed.**
 * `unit_cost` carries four decimals and the issue path draws at that rate, so a
 * layer of 100 units cannot hold 33.3333 of freight — 0.333333 per unit is not a
 * number the column can express, and 0.3333 is. Rounding the rate *up* instead
 * would put value into inventory the voucher never charged; carrying the
 * difference in `remaining_value` while the rate stayed lower would leave a
 * permanent gap between what the valuation report says stock is worth and what
 * issuing it will actually cost, and nothing would ever clear it. So the rate is
 * floored and the sub-rate remainder joins the expensed side, which keeps one
 * identity true without exception:
 *
 *     voucher charge total = Σ capitalised into layers + Σ expensed
 */
export function planRevaluation(
  chargeTotal: string,
  basis: LandedCostBasis,
  layers: readonly LayerSnapshot[],
): RevaluationPlan {
  const targets: ApportionTarget[] = layers.map((layer) => ({
    id: layer.id,
    weight: basis === "VALUE" ? layer.totalValue : layer.quantity,
  }));

  const shares = new Map(apportion(chargeTotal, targets).map((s) => [s.id, s.amount]));

  const rows: LayerRevaluation[] = [];
  let capitalisedTotal = ZERO;
  let expensedTotal = ZERO;

  for (const layer of layers) {
    const allocated = shares.get(layer.id) ?? ZERO;
    const weight = basis === "VALUE" ? layer.totalValue : layer.quantity;
    const row = revalueLayer(layer, weight, allocated);
    rows.push(row);
    capitalisedTotal = addDec(capitalisedTotal, row.capitalised);
    expensedTotal = addDec(expensedTotal, row.expensed);
  }

  return { rows, capitalisedTotal, expensedTotal };
}

function revalueLayer(
  layer: LayerSnapshot,
  weight: string,
  allocated: string,
): LayerRevaluation {
  const untouched = (): LayerRevaluation => ({
    layerId: layer.id,
    productVariantId: layer.productVariantId,
    costingMethod: layer.costingMethod,
    weight,
    allocated,
    capitalised: ZERO,
    expensed: allocated,
    layerQuantity: layer.quantity,
    remainingQuantity: layer.remainingQuantity,
    unitCostBefore: layer.unitCost,
    unitCostAfter: layer.unitCost,
    remainingValueAfter: layer.remainingValue,
    totalValueAfter: layer.totalValue,
    writesLayer: false,
  });

  if (layer.costingMethod === "STANDARD") return untouched();

  const { capitalisable } = splitByRemaining(
    allocated,
    layer.remainingQuantity,
    layer.quantity,
  );
  if (cmpDec(capitalisable, ZERO) <= 0) return untouched();

  const remainingQuantityScaled = toScaled(layer.remainingQuantity);
  if (remainingQuantityScaled <= 0n) return untouched();

  // Floored, not rounded: see the note above. `mulDec` below then rounds
  // half-up, and because the floored rate satisfies rate × quantity ≤ target,
  // that rounding can never carry the result past the target either.
  const targetValue = toScaled(addDec(layer.remainingValue, capitalisable));
  const unitCostAfterScaled = (targetValue * SCALE) / remainingQuantityScaled;

  // A rate that did not move — the allocation was smaller than one ten-thousandth
  // per unit — leaves the layer alone rather than writing an identical row.
  if (unitCostAfterScaled <= toScaled(layer.unitCost)) return untouched();

  const unitCostAfter = fromScaled(unitCostAfterScaled);
  const remainingValueAfter = mulDec(layer.remainingQuantity, unitCostAfter);
  const capitalised = subDec(remainingValueAfter, layer.remainingValue);

  return {
    layerId: layer.id,
    productVariantId: layer.productVariantId,
    costingMethod: layer.costingMethod,
    weight,
    allocated,
    capitalised,
    // By subtraction, so `allocated = capitalised + expensed` holds by
    // construction rather than by two computations agreeing.
    expensed: subDec(allocated, capitalised),
    layerQuantity: layer.quantity,
    remainingQuantity: layer.remainingQuantity,
    unitCostBefore: layer.unitCost,
    unitCostAfter,
    remainingValueAfter,
    // The layer's total is what it has cost us in all, so it moves by what
    // actually reached it — not by what the voucher tried to send.
    totalValueAfter: addDec(layer.totalValue, capitalised),
    writesLayer: true,
  };
}
