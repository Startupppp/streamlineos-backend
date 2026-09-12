import type { AttributionTouch } from "./attribution-touch";

/**
 * The weighting models. Five ways to answer one question, over one touch set.
 *
 * The arrangement is the point. A model here produces WEIGHTS — never money —
 * and the same touch set is fed to whichever one the caller picked. So changing
 * the model changes how credit is divided and cannot change what happened:
 * there is no path where switching to last-touch also drops a touch, or where
 * time-decay quietly reads a different window. The old
 * `CrmAttributionReportService` had one query per model, each with its own joins
 * and its own definition of "converted", which is how two reports over the same
 * quarter came to disagree about how many leads there were.
 *
 * ## Every weight is an integer
 *
 * Not a fraction, not a percentage — a non-negative integer numerator over the
 * set's own sum. That is what lets `allocateExact` divide a deal to the cent
 * with no float in the arithmetic at all. A model expressed as `0.4` would put a
 * binary fraction into the one place this module cannot tolerate one: 0.1 + 0.2
 * is not 0.3, and a "40/20/40" split written in floats does not sum to 1.
 *
 * The single exception is the decay CURVE, which is transcendental and is
 * evaluated in floating point before being quantised to an integer. That is
 * safe, and the reason is worth stating precisely: the exactness guarantee does
 * not come from the weights being exact, it comes from the ALLOCATION being
 * exact given whatever integers it is handed. A decay weight one part per
 * million off is a slightly different opinion about how fast attention fades. A
 * cent that goes missing is a wrong number.
 */

export const ATTRIBUTION_MODELS = [
  "first_touch",
  "last_touch",
  "linear",
  "time_decay",
  "position_based",
] as const;

export type AttributionModel = (typeof ATTRIBUTION_MODELS)[number];

export function isAttributionModel(value: string): value is AttributionModel {
  return (ATTRIBUTION_MODELS as readonly string[]).includes(value);
}

/** What each model claims, in the words a report should show beside it. */
export const ATTRIBUTION_MODEL_DESCRIPTIONS: Record<AttributionModel, string> = {
  first_touch: "All value to the touch that created the opportunity.",
  last_touch: "All value to the touch immediately before the close.",
  linear: "Value divided evenly across every touch.",
  time_decay:
    "Value weighted towards the touches nearest the close, halving every half-life.",
  position_based:
    "40% to the first touch, 40% to the last, the remaining 20% split across the middle.",
};

/**
 * The resolution of a decay weight: one part in a million.
 *
 * High enough that two touches an hour apart get visibly different weights at
 * any sane half-life, and low enough that the sum of a thousand weights stays
 * far inside a safe integer. It is a quantisation of an opinion, not of money.
 */
export const TIME_DECAY_SCALE = 1_000_000;

export const DEFAULT_HALF_LIFE_DAYS = 7;
/**
 * Ten years. Not a guess at a sensible sales cycle — an upper bound that keeps
 * `2 ** (-age / halfLife)` inside the range where it is worth computing. Beyond
 * this the curve is flat and the model is linear with extra steps, so a caller
 * asking for it has misunderstood and should be told so rather than served.
 */
export const MAX_HALF_LIFE_DAYS = 3650;

/** 40 / 20 / 40, held as integers so the split cannot drift. See `weightsFor`. */
export const POSITION_END_PERCENT = 40;
export const POSITION_MIDDLE_PERCENT = 20;

const MILLIS_PER_DAY = 86_400_000;

export interface WeightingContext {
  /**
   * The moment credit is being assigned as of — the deal's close, normally.
   *
   * Only `time_decay` reads it, and it must be the close rather than "now", or
   * the same deal decays further every time the report is opened and last
   * quarter's answer is not reproducible.
   */
  readonly asOf: Date;
  readonly halfLifeDays: number;
}

/**
 * Integer weights for one ordered touch set, one per touch, in the same order.
 *
 * Preconditions, both the caller's job: `touches` is non-empty and is ordered by
 * `orderTouches`. Neither is re-checked here — an empty set is refused by
 * `attributeDeal`, which is the only caller, and re-sorting inside a pure
 * weighting function would hide an unordered set from the one place it is
 * visible.
 *
 * Postcondition, guaranteed for every model: every weight is a non-negative safe
 * integer, and at least one is positive. `allocateExact` depends on both.
 */
export function weightsFor(
  model: AttributionModel,
  touches: readonly AttributionTouch[],
  context: WeightingContext,
): number[] {
  const n = touches.length;

  switch (model) {
    case "first_touch":
      return touches.map((_, index) => (index === 0 ? 1 : 0));

    case "last_touch":
      return touches.map((_, index) => (index === n - 1 ? 1 : 0));

    case "linear":
      return touches.map(() => 1);

    case "time_decay":
      return touches.map((touch) => decayWeight(touch, context));

    case "position_based":
      return positionWeights(n);
  }
}

/**
 * `2 ** (-age / halfLife)`, quantised, and never zero.
 *
 * The floor at 1 is a decision, not a rounding artefact. A touch two years
 * before a close rounds to zero at any half-life a tenant would set, and a zero
 * weight means the touch is reported as having contributed nothing — which
 * contradicts the module's own premise that it is on the timeline because it
 * contributed. Worse, a set where EVERY weight rounded to zero has no total to
 * divide by, so the model would have to fail on the deals with the longest
 * histories. One millionth of the value is a small number; nothing is a claim.
 *
 * Age is clamped at zero because a touch may be recorded fractionally after the
 * close instant (an activity written by the same request that marked the deal
 * won). Left unclamped it would score above full weight, which is a rounding
 * accident presenting as an opinion.
 */
function decayWeight(touch: AttributionTouch, context: WeightingContext): number {
  const ageDays = Math.max(
    0,
    (context.asOf.getTime() - touch.occurredAt.getTime()) / MILLIS_PER_DAY,
  );
  const decayed = Math.pow(2, -ageDays / context.halfLifeDays);
  const quantised = Math.round(TIME_DECAY_SCALE * decayed);
  return Number.isFinite(quantised) ? Math.max(1, quantised) : 1;
}

/**
 * 40 / 20 / 40, as integers, renormalised when there is no middle.
 *
 * With three or more touches the ends take `40 × (n - 2)` each and each middle
 * touch takes 20, so the middles together take `20 × (n - 2)` — the standard
 * split, expressed over a common denominator of `100 × (n - 2)` so that no
 * division happens here at all.
 *
 * One and two touches are the cases every implementation of this model gets
 * wrong. With two touches there is no middle, so the 20% has nowhere to go: the
 * honest answer is that the first and last touch are the entire set and split it
 * evenly, not that 20% of the deal is unattributed. With one touch the same
 * touch is both ends and takes everything.
 */
function positionWeights(n: number): number[] {
  if (n === 1) return [1];
  if (n === 2) return [1, 1];

  const middles = n - 2;
  return Array.from({ length: n }, (_, index) =>
    index === 0 || index === n - 1
      ? POSITION_END_PERCENT * middles
      : POSITION_MIDDLE_PERCENT,
  );
}
