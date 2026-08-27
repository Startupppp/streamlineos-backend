import {
  ATTRIBUTION_MODEL_VERSION,
  ATTRIBUTION_WEIGHTINGS,
  type AttributionModelId,
} from "./attribution-models";
import { touchesBefore, type AttributionTouch, type Conversion } from "./attribution-touch";

/**
 * Attribution as a projection over stored touches, computed on read.
 *
 * Phase 6, ticket 18. The fifth criterion — changing the model does not rewrite
 * history, it re-presents it — decides the entire shape of this file, and it
 * decides it by ruling something out. If a credit were a stored number, then
 * switching a tenant from last-touch to time-decay leaves exactly two options,
 * and both are wrong: recompute and overwrite, which rewrites what last quarter
 * said and destroys the record somebody signed off; or write a second set and
 * keep both, at which point the same deal has two revenue figures and no rule
 * says which is true.
 *
 * So nothing is stored. There is no credits table, no `credit_minor` column,
 * and no migration in this module. The stored facts are the touches — which
 * already exist, on the timeline — and the deal value. A model is a function
 * applied to them at read time, and changing it changes the reading. History is
 * `activities`, and `activities` is not touched by anything here.
 *
 * `attribution-is-a-projection.spec.ts` holds that: it fails if this directory
 * ever gains a write.
 *
 * Two arithmetic rules, both the platform's:
 *
 * **Round once, at the end.** A model returns unrounded relative weights. The
 * money is apportioned from those weights in a single pass, by largest
 * remainder, so the credits sum EXACTLY to the deal value. Rounding each credit
 * independently loses a minor unit per touch, and a decomposition whose parts do
 * not sum to the whole is not a decomposition — it is the thing a finance team
 * opens a ticket about.
 *
 * **Every presented figure is one rounding of the weights, never a rounding of
 * a rounding.** `creditBps` is apportioned from the same weights rather than
 * derived from `creditMinor`, because deriving it would round an already-rounded
 * number and produce shares that do not total 100%.
 */

/** Basis points in the whole, as everywhere in the platform. */
export const BPS = 10_000;

/** A description that cannot be attributed. Never a database error. */
export class AttributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttributionError";
  }
}

/** One touch's share of one conversion. Carries the timeline row it came from. */
export interface TouchCredit {
  readonly activityId: string;
  readonly occurredAt: Date;
  readonly channel: string;
  readonly kind: string;
  /** Share of this conversion, in basis points. The credits total exactly `BPS`. */
  readonly creditBps: number;
  /** Share of this conversion, in minor units. The credits total exactly the value. */
  readonly creditMinor: number;
}

/**
 * One deal's revenue, decomposed.
 *
 * `model` and `modelVersion` are required fields rather than optional context,
 * which is the second criterion — "which one is in use is stated on every
 * figure" — made unwriteable-around: there is no way to construct this type
 * without saying which model produced it.
 */
export interface AttributedConversion {
  readonly model: AttributionModelId;
  readonly modelVersion: number;
  readonly dealId: string;
  readonly currency: string;
  readonly valueMinor: number;
  readonly convertedAt: Date;
  readonly credits: readonly TouchCredit[];
  /**
   * Revenue with no touch to give it to, which is a real answer and not zero.
   *
   * A deal that closed with an empty timeline gets no credits at all. The
   * alternative — inventing a "direct" touch to hang it on — is precisely what
   * the fourth criterion forbids, and it is how attribution reports come to show
   * a large unexplained channel that nobody can trace to anything.
   */
  readonly unattributedMinor: number;
  /**
   * The timeline was longer than `MAX_TOUCHES_PER_CONVERSION` and was cut.
   *
   * Stated on the figure rather than swallowed. Attribution over a truncated
   * timeline is not attribution of that deal, and a reader who cannot see that
   * the cut happened has no way to know why first-touch and last-touch disagree
   * about a deal they should agree about.
   */
  readonly truncated: boolean;
}

/**
 * Integers that sum exactly to `total`, split by `weights`, by largest remainder.
 *
 * Every apportionment method has to decide where the leftover units go, and the
 * choice is not neutral: giving them to the earliest index systematically
 * favours the first touch, which under first-touch attribution is invisible and
 * under linear is a bias nobody asked for. Largest remainder gives each unit to
 * whoever was closest to earning it, and ties break on index so the answer is
 * stable across reads — an attribution figure that changes between two refreshes
 * of the same page is worse than one that is slightly arbitrary.
 */
export function apportion(total: number, weights: readonly number[]): number[] {
  if (!Number.isInteger(total))
    throw new AttributionError(`cannot apportion a non-integer total: ${total}`);
  if (weights.length === 0) return [];

  const sum = weights.reduce((running, weight) => running + weight, 0);
  // Every weight zero is a real answer from a model, not a bug: it means no
  // touch earned anything. Splitting evenly would be this file inventing a
  // judgement the model declined to make.
  if (sum <= 0) return weights.map(() => 0);

  const exact = weights.map((weight) => (total * weight) / sum);
  const floors = exact.map((value) => Math.floor(value));
  const assigned = floors.reduce((running, value) => running + value, 0);
  let remaining = total - assigned;

  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  const result = [...floors];
  for (const { index } of byRemainder) {
    if (remaining <= 0) break;
    result[index] += 1;
    remaining -= 1;
  }
  return result;
}

/**
 * The most touches one deal's attribution will read.
 *
 * A bound is needed — a timeline is unbounded and a mail import writes thousands
 * — but any bound makes some deal's answer wrong, so the answer says so. See
 * `truncated`.
 */
export const MAX_TOUCHES_PER_CONVERSION = 1_000;

/**
 * One deal, attributed under one model.
 *
 * The checks below are not defensive coding; each one is a way the fourth
 * criterion could be violated silently, turned into a loud failure.
 */
export function attributeConversion(
  conversion: Conversion,
  touches: readonly AttributionTouch[],
  model: AttributionModelId,
): AttributedConversion {
  if (!Number.isInteger(conversion.valueMinor) || conversion.valueMinor < 0)
    throw new AttributionError(
      `deal ${conversion.dealId} has a value that is not a non-negative integer minor amount`,
    );

  const eligible = touchesBefore(touches, conversion.convertedAt);
  const truncated = eligible.length > MAX_TOUCHES_PER_CONVERSION;
  const considered = truncated ? eligible.slice(0, MAX_TOUCHES_PER_CONVERSION) : eligible;

  // A touch with no timeline row behind it cannot be credited, because a credit
  // that names nothing is indistinguishable from an invented one.
  for (const touch of considered)
    if (!touch.activityId)
      throw new AttributionError(
        `deal ${conversion.dealId} has a touch with no activity id, which cannot be credited`,
      );

  /*
    Two credits naming the same activity is not a decomposition either: the
    reader following a figure back to its touches arrives at one row twice and
    the parts appear to exceed the source. This has a real cause — a deal
    anchored to a party whose timeline also carries deal-anchored rows — and the
    service unions those two reads, so this is the check that the union
    deduplicated.
  */
  const seen = new Set<string>();
  for (const touch of considered) {
    if (seen.has(touch.activityId))
      throw new AttributionError(
        `deal ${conversion.dealId} lists activity ${touch.activityId} as a touch twice`,
      );
    seen.add(touch.activityId);
  }

  const weights = ATTRIBUTION_WEIGHTINGS[model](considered, conversion);

  /*
    The model returned a different number of weights than there were touches.

    This is the only way a model could fabricate or lose a touch, and it is a bug
    in the model rather than bad input — so it fails rather than being padded or
    truncated into agreement. Padding would silently give the missing touches a
    zero share; truncating would silently drop real ones.
  */
  if (weights.length !== considered.length)
    throw new AttributionError(
      `model ${model} returned ${weights.length} weights for ${considered.length} touches`,
    );

  for (const weight of weights)
    if (!Number.isFinite(weight) || weight < 0)
      throw new AttributionError(`model ${model} returned a weight that is not usable: ${weight}`);

  const minor = apportion(conversion.valueMinor, weights);
  const bps = apportion(BPS, weights);

  const credits: TouchCredit[] = considered.map((touch, index) => ({
    activityId: touch.activityId,
    occurredAt: touch.occurredAt,
    channel: touch.channel,
    kind: touch.kind,
    creditBps: bps[index],
    creditMinor: minor[index],
  }));

  const attributed = credits.reduce((running, credit) => running + credit.creditMinor, 0);

  return {
    model,
    modelVersion: ATTRIBUTION_MODEL_VERSION,
    dealId: conversion.dealId,
    currency: conversion.currency,
    valueMinor: conversion.valueMinor,
    convertedAt: conversion.convertedAt,
    credits,
    unattributedMinor: conversion.valueMinor - attributed,
    truncated,
  };
}

/** A channel's share of a whole report. */
export interface AttributionShare {
  readonly channel: string;
  readonly creditMinor: number;
  /** Share of the report's attributed total. The shares total exactly `BPS`. */
  readonly creditBps: number;
  readonly touches: number;
  readonly deals: number;
}

/**
 * Many deals, attributed under one model, rolled up by channel.
 *
 * One model for the whole report rather than one per deal: a total summed from
 * deals attributed under different models is a number with no meaning, and the
 * second criterion's "stated on every figure" would then be a statement that
 * could not be made.
 */
export interface AttributionReport {
  readonly model: AttributionModelId;
  readonly modelVersion: number;
  readonly currency: string;
  readonly totalMinor: number;
  readonly attributedMinor: number;
  readonly unattributedMinor: number;
  readonly conversions: readonly AttributedConversion[];
  readonly byChannel: readonly AttributionShare[];
}

export function summariseByChannel(
  model: AttributionModelId,
  currency: string,
  conversions: readonly AttributedConversion[],
): AttributionReport {
  const disagreeing = conversions.find((conversion) => conversion.model !== model);
  if (disagreeing)
    throw new AttributionError(
      `deal ${disagreeing.dealId} was attributed under ${disagreeing.model}, not ${model}`,
    );

  const totals = new Map<string, { minor: number; touches: number; deals: Set<string> }>();
  for (const conversion of conversions)
    for (const credit of conversion.credits) {
      const entry = totals.get(credit.channel) ?? { minor: 0, touches: 0, deals: new Set() };
      entry.minor += credit.creditMinor;
      entry.touches += 1;
      entry.deals.add(conversion.dealId);
      totals.set(credit.channel, entry);
    }

  const channels = [...totals.entries()].sort(
    (a, b) => b[1].minor - a[1].minor || a[0].localeCompare(b[0]),
  );

  /*
    The channel percentages are apportioned from the channel MONEY, not from the
    per-touch basis points summed up.

    Summing `creditBps` across a report would be adding shares of different
    deals — 100% of a small deal and 100% of a large one are not 200% of
    anything — and the total would drift further from 10000 with every deal
    added. This is the same "round once, over the whole set" rule the commission
    ledger states: the roll-up is derived from the values, never from the
    already-derived percentages.
  */
  const shareBps = apportion(
    BPS,
    channels.map(([, entry]) => entry.minor),
  );

  const byChannel: AttributionShare[] = channels.map(([channel, entry], index) => ({
    channel,
    creditMinor: entry.minor,
    creditBps: shareBps[index],
    touches: entry.touches,
    deals: entry.deals.size,
  }));

  const totalMinor = conversions.reduce((running, item) => running + item.valueMinor, 0);
  const unattributedMinor = conversions.reduce(
    (running, item) => running + item.unattributedMinor,
    0,
  );

  return {
    model,
    modelVersion: ATTRIBUTION_MODEL_VERSION,
    currency,
    totalMinor,
    attributedMinor: totalMinor - unattributedMinor,
    unattributedMinor,
    conversions,
    byChannel,
  };
}
