import type { AttributionTouch, Conversion } from "./attribution-touch";

/**
 * The models, and the one thing a model is permitted to say.
 *
 * Phase 6, ticket 18. A model returns RELATIVE WEIGHTS, one per touch, in the
 * order it was handed them. That is its entire vocabulary, and the restriction
 * is the ticket's fourth criterion made structural rather than reviewed:
 *
 *   - a model cannot name a touch, because nothing in its return type is an
 *     identifier — so it cannot credit one that is not on the timeline;
 *   - a model cannot drop or add a touch, because the projection pairs weight
 *     `i` with touch `i` and rejects a length that disagrees;
 *   - a model cannot round, because it never sees the money.
 *
 * This is the same move `query-compiler.ts` makes with tenancy: a report cannot
 * opt out of its organisation because there is nowhere in `QueryDescription` to
 * say so. Here, a model cannot invent a touch because there is nowhere in
 * `AttributionWeighting` to name one.
 *
 * Weights are unnormalised on purpose. Normalising here would mean each model
 * dividing, and a division per model is a rounding per model; the projection
 * normalises once, over integers, at the end.
 */
export const ATTRIBUTION_MODELS = [
  "first-touch",
  "last-touch",
  "linear",
  "time-decay",
  "position-based",
] as const;

export type AttributionModelId = (typeof ATTRIBUTION_MODELS)[number];

/**
 * Bumped when a model's arithmetic changes, never when a tenant picks a
 * different model.
 *
 * A figure states both its model and this, because "40% to the first touch" is
 * not a reproducible statement without knowing what position-based meant on the
 * day it was rendered. Nothing is stored, so this is not a schema version — it
 * is what lets two screenshots taken a release apart be compared honestly.
 */
export const ATTRIBUTION_MODEL_VERSION = 1;

/**
 * A model. Weights must be finite, non-negative, and exactly one per touch.
 *
 * `conversion` is passed because time-decay needs the moment the revenue landed
 * to measure decay against. It is read-only to a model in the only sense that
 * matters: the return type still cannot mention it.
 */
export type AttributionWeighting = (
  touches: readonly AttributionTouch[],
  conversion: Conversion,
) => readonly number[];

const DAY_MS = 86_400_000;

/**
 * How quickly a touch stops counting under time-decay.
 *
 * Seven days, so a touch a week before the close is worth half one on the day.
 * A constant rather than a tenant setting deliberately: the model's meaning has
 * to be the same everywhere for the model's NAME on a figure to mean anything,
 * and a per-tenant half-life turns "time-decay" into a word two customers
 * cannot compare. A tenant who wants a different shape picks a different model.
 */
export const TIME_DECAY_HALF_LIFE_DAYS = 7;

/**
 * How position-based splits: 40% first, 40% last, 20% shared by the middle.
 *
 * The two ends are where the shape of the deal is decided — the touch that
 * created the opportunity and the one that closed it — and the middle is the
 * work that kept it alive. Integers so the degenerate cases below stay exact.
 */
export const POSITION_BASED_FIRST = 40;
export const POSITION_BASED_LAST = 40;
export const POSITION_BASED_MIDDLE = 20;

const firstTouch: AttributionWeighting = (touches) =>
  touches.map((_, index) => (index === 0 ? 1 : 0));

const lastTouch: AttributionWeighting = (touches) =>
  touches.map((_, index) => (index === touches.length - 1 ? 1 : 0));

const linear: AttributionWeighting = (touches) => touches.map(() => 1);

/**
 * Half-life decay measured back from the conversion, not from the last touch.
 *
 * Measuring from the last touch would make a deal that closed six months after
 * anybody spoke to the customer look freshly worked, because the most recent
 * touch is always at age zero by construction. The distance that matters is to
 * the money.
 */
const timeDecay: AttributionWeighting = (touches, conversion) =>
  touches.map((touch) => {
    const ageDays =
      (conversion.convertedAt.getTime() - touch.occurredAt.getTime()) / DAY_MS;
    return Math.pow(2, -Math.max(ageDays, 0) / TIME_DECAY_HALF_LIFE_DAYS);
  });

/**
 * The two ends and the middle, with both degenerate cases stated rather than
 * emergent.
 *
 * One touch takes everything: it is both ends, and splitting 40/40 of a single
 * touch against a middle that does not exist would leave a fifth of the revenue
 * belonging to nobody. Two touches split evenly: they are the two ends and
 * again there is no middle, so 40 and 40 normalise to a half each. Only from
 * three does the middle share exist, and it is shared equally because the model
 * makes no claim about which of the middle touches mattered more — a model that
 * did would be time-decay.
 */
const positionBased: AttributionWeighting = (touches) => {
  if (touches.length === 0) return [];
  if (touches.length === 1) return [1];
  if (touches.length === 2) return [POSITION_BASED_FIRST, POSITION_BASED_LAST];

  const middleCount = touches.length - 2;
  return touches.map((_, index) => {
    if (index === 0) return POSITION_BASED_FIRST;
    if (index === touches.length - 1) return POSITION_BASED_LAST;
    return POSITION_BASED_MIDDLE / middleCount;
  });
};

/** Every model, by id. Exhaustive by type: a new id will not compile without one. */
export const ATTRIBUTION_WEIGHTINGS: Readonly<
  Record<AttributionModelId, AttributionWeighting>
> = {
  "first-touch": firstTouch,
  "last-touch": lastTouch,
  linear,
  "time-decay": timeDecay,
  "position-based": positionBased,
};

export function isAttributionModel(value: string): value is AttributionModelId {
  return (ATTRIBUTION_MODELS as readonly string[]).includes(value);
}

/** What a figure's caption says when it names its model. */
export function attributionModelSummary(model: AttributionModelId): string {
  switch (model) {
    case "first-touch":
      return "All of the revenue to the touch that started the conversation.";
    case "last-touch":
      return "All of the revenue to the touch immediately before the close.";
    case "linear":
      return "Shared equally across every touch on the timeline.";
    case "time-decay":
      return `Weighted towards the close, halving every ${TIME_DECAY_HALF_LIFE_DAYS} days.`;
    case "position-based":
      return `${POSITION_BASED_FIRST}% to the first touch, ${POSITION_BASED_LAST}% to the last, ${POSITION_BASED_MIDDLE}% shared by the rest.`;
  }
}
