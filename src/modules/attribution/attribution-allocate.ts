import {
  DEFAULT_HALF_LIFE_DAYS,
  weightsFor,
  type AttributionModel,
} from "./attribution-models";
import type { AttributionTouch } from "./attribution-touch";

/**
 * Turning weights into money, without losing or inventing a minor unit.
 *
 * `attribution-models.ts` hands out integer weights and states where the
 * exactness guarantee actually comes from: not from the weights being exact —
 * the decay curve is transcendental and is quantised — but from the ALLOCATION
 * being exact given whatever integers it is handed. This file is that
 * allocation, and the one caller of `weightsFor` the models file names.
 *
 * It is deliberately separate from the report service for the same reason the
 * models are separate from the touch shape: dividing a deal across a timeline is
 * arithmetic, and arithmetic that can only be tested by inserting a row is
 * arithmetic nobody checks.
 */

/** Thrown when a caller breaks a precondition the models file relies on. */
export class AttributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttributionError";
  }
}

/**
 * Split `totalMinor` across `weights` so the parts sum back to the whole.
 *
 * Largest-remainder: every slot takes the floor of its exact share, and the
 * leftover units go one each to the slots that lost the most to truncation.
 * The arithmetic runs in `BigInt` because `total × weight` overflows a safe
 * integer well inside the range this is used on — a decay weight is up to
 * 1,000,000 and a deal is in minor units, so a ₹10 lakh deal is 100,000,000 and
 * the product is 10^14 before any division. Floats would put the drift back
 * exactly where the whole module exists to remove it.
 *
 * The tie-break is the slot index, so two touches that lost the same fraction
 * are separated by their position in the ordered set rather than by whatever
 * order `sort` happened to leave them in — the same deal must allocate the same
 * way on a second read.
 *
 * Negative totals are supported rather than rejected: a reversed or credited
 * deal is a real row, and the honest answer is that its credit reverses along
 * the same timeline that earned it. The leftover then moves the other way, which
 * is why the step carries the remainder's sign.
 */
export function allocateExact(
  totalMinor: number,
  weights: readonly number[],
): number[] {
  if (weights.length === 0) {
    throw new AttributionError("Cannot allocate across an empty weight set");
  }
  if (!Number.isSafeInteger(totalMinor)) {
    throw new AttributionError(
      `Revenue must be a safe integer in minor units, got ${totalMinor}`,
    );
  }
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) {
    throw new AttributionError(
      "Weights must be non-negative safe integers — see weightsFor's postcondition",
    );
  }

  const weightTotal = weights.reduce((a, b) => a + b, 0);
  if (weightTotal <= 0) {
    // `weightsFor` guarantees at least one positive weight, so reaching here
    // means a caller built weights by hand. Refuse rather than divide by zero
    // or quietly dump the deal on slot zero, which would read as a real answer.
    throw new AttributionError("Weight set sums to zero — nothing to divide by");
  }

  const total = BigInt(totalMinor);
  const divisor = BigInt(weightTotal);

  // BigInt division truncates toward zero, so each share is on the near side of
  // its exact value and the remainder carries the sign of the total.
  const shares = weights.map((w) => (total * BigInt(w)) / divisor);
  const remainders = weights.map((w) => (total * BigInt(w)) % divisor);

  let leftover = total - shares.reduce((a, b) => a + b, 0n);
  const step = leftover >= 0n ? 1n : -1n;

  const byLoss = remainders
    .map((remainder, index) => ({
      index,
      loss: remainder < 0n ? -remainder : remainder,
    }))
    .sort((a, b) =>
      a.loss === b.loss ? a.index - b.index : a.loss > b.loss ? -1 : 1,
    );

  for (const { index } of byLoss) {
    if (leftover === 0n) break;
    shares[index] += step;
    leftover -= step;
  }

  return shares.map((share) => Number(share));
}

/** One touch's share of one deal, in the deal's own minor units. */
export interface TouchAllocation {
  readonly touch: AttributionTouch;
  /** The integer numerator the model produced. Kept so a report can show it. */
  readonly weight: number;
  readonly revenueMinor: number;
}

export interface DealToAttribute {
  /** Integer minor units. `deals.value_minor`, never the generated decimal. */
  readonly revenueMinor: number;
  /**
   * When the deal closed — the decay clock and nothing else.
   *
   * `WeightingContext.asOf` must be the close rather than "now", or the same
   * deal decays further every time the report is opened and last quarter's
   * answer stops being reproducible.
   */
  readonly closedAt: Date;
}

/**
 * One deal's revenue, divided across the touches that earned it.
 *
 * Preconditions, the caller's: `touches` is ordered by `orderTouches` and
 * already filtered to the close by `touchesUpTo`. Both are done at the read,
 * where the touch set is assembled and where an unordered set is visible; doing
 * them again here would hide the caller's mistake rather than surface it.
 *
 * The empty set is refused rather than returned empty. A deal with no touches
 * is a real and reportable state — the revenue is unattributable, and a report
 * that folds it into "Direct/Unknown" has invented a channel — so the caller
 * must decide what to say about it instead of receiving an empty list that
 * looks like a successful attribution of nothing.
 */
export function attributeDeal(
  model: AttributionModel,
  deal: DealToAttribute,
  touches: readonly AttributionTouch[],
  halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS,
): TouchAllocation[] {
  if (touches.length === 0) {
    throw new AttributionError(
      "A deal with no eligible touches has no attribution — the caller must report it as unattributable",
    );
  }

  const weights = weightsFor(model, touches, {
    asOf: deal.closedAt,
    halfLifeDays,
  });
  const shares = allocateExact(deal.revenueMinor, weights);

  return touches.map((touch, index) => ({
    touch,
    weight: weights[index],
    revenueMinor: shares[index],
  }));
}
