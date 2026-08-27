import type { CommissionEvaluation, CommissionSlice } from "./commission-rules";

/**
 * Decomposition: turning one settled figure into the parts that produced it,
 * such that the parts sum to the figure **exactly**.
 *
 * The premise of continuous accrual is that a month-end number is a number
 * people have already been watching. That only holds if the running figure can
 * be interrogated at any moment — which deal, which plan version, which band of
 * which rule — and if the answers add up. A decomposition whose parts sum to
 * something other than the total is worse than no decomposition at all: it
 * invites somebody to reconcile two numbers that were never going to agree, and
 * the reconciliation is where trust in the whole ledger goes.
 *
 * `commission-rules.ts` cannot supply this on its own, and deliberately does not
 * try. Its `CommissionSlice.amountMinor` is a display rounding of each band's
 * share, and it is wrong to add up for two independent reasons:
 *
 *  1. **Rounding residue.** Each slice is rounded on its own while the total is
 *     rounded once from the exact sum. Sum-of-rounded is not rounded-of-sum.
 *  2. **The cap.** `rules.capMinor` reduces the settled total and leaves every
 *     slice untouched, so a capped earning's slices can overshoot the money
 *     actually owed by orders of magnitude.
 *
 * Measured against the evaluator as it stands, roughly a quarter of randomly
 * generated evaluations disagree by at least one minor unit, and the capped ones
 * disagree by much more than that. So the residue is not a rare edge case to
 * document and move past; it is the normal case, and it is what this file fixes.
 *
 * The fix is apportionment rather than re-derivation. The evaluator's total is
 * the authority on what is owed — it is what the earning row stores and what
 * somebody was paid — and the parts are fitted to it, rather than the total
 * being recomputed as a sum of parts. Doing it the other way round would let a
 * decomposition change a payout, which is precisely the restatement this whole
 * module exists to make impossible.
 *
 * A pleasant consequence: because the settled (post-cap) total is what gets
 * apportioned, a cap is *attributed* rather than left dangling. The money a cap
 * removed is taken proportionally out of the bands that earned it, so "why is my
 * top band worth less than the rate says" has an answer on the row instead of
 * requiring somebody to know the cap exists.
 *
 * Pure, integer, and free of Nest, Drizzle and the clock, for the same reason
 * `commission-rules.ts` is: reproducing a historical accrual has to be a
 * function call over stored data.
 */

/**
 * One band of one earning, carrying its exact share of the settled total.
 *
 * Distinct from `CommissionSlice`: a slice is what the evaluator walked, a part
 * is what somebody is owed for it. They agree on the geometry and can disagree
 * on the money, and conflating them is how the residue above gets shipped.
 */
export interface AccrualPart {
  /** Position within its earning. Dense from 0, and the ledger's sort key. */
  partIndex: number;
  /** Index into the plan version's `rules.tiers`. */
  tierIndex: number;
  /** The band's declared `from` — attainment bps with a quota, minor without. */
  tierFrom: number;
  rateBps: number;
  /** 10000 when no accelerator applied to this band. */
  multiplierBps: number;
  /** Cumulative position of the start of the band's slice, in minor units. */
  fromMinor: number;
  /** Cumulative position of the end (exclusive), in minor units. */
  toMinor: number;
  /** How much basis fell in the band. */
  basisMinor: number;
  /**
   * This part's exact share of the earning.
   *
   * Sums with its siblings to the earning's `amountMinor` with no residue. That
   * is the invariant `assertPartsSumTo` states and the property test enforces.
   */
  amountMinor: number;
}

/**
 * The unrounded contribution a slice makes, used only as an apportionment
 * weight.
 *
 * `BigInt` because a basis of 10^12 minor units against a 10000 bp rate and a
 * 20000 bp accelerator is 2·10^20 — twenty-odd times past
 * `Number.MAX_SAFE_INTEGER`. In `number` arithmetic that is silently wrong and
 * the resulting split still looks plausible.
 *
 * The magnitude of the basis, not its signed value. A weight expresses *how
 * much of the total this band is responsible for*, which is a share and cannot
 * be negative; the sign belongs to the total and is reapplied once, in
 * `apportion`. Taking the signed basis here would make a reversal's weights
 * negative and the split meaningless.
 */
export function sliceWeight(slice: CommissionSlice): bigint {
  return (
    BigInt(Math.abs(slice.basisMinor)) *
    BigInt(slice.rateBps) *
    BigInt(slice.multiplierBps)
  );
}

/**
 * Split `totalMinor` across `weights` so the shares sum to it exactly.
 *
 * Largest-remainder (Hamilton) apportionment. Every share starts at its floor,
 * which leaves a shortfall strictly smaller than the number of parts, and those
 * leftover units go one each to the parts with the largest truncated remainder.
 * Ties break by index.
 *
 * Deterministic tie-breaking is not tidiness. The same earning decomposed twice
 * has to produce the same rows, or a rebuild silently moves a minor unit between
 * two deals and the ledger disagrees with a payslip somebody has already read.
 * Sorting by remainder alone leaves ties at the mercy of the sort's stability,
 * which is a guarantee about the runtime rather than about this ledger.
 *
 * Negative totals are supported and mirror exactly: `apportion(-t, w)` is the
 * negation of `apportion(t, w)`, component by component. A clawback has to be
 * the precise reverse of the earning it reverses, or the two fail to cancel and
 * a ledger that will not return to zero is a day of somebody's life.
 */
export function apportion(totalMinor: number, weights: bigint[]): number[] {
  if (!Number.isInteger(totalMinor))
    throw new Error(
      `commission accrual: a total to apportion must be integer minor units, got ${totalMinor}`,
    );
  for (const weight of weights)
    if (weight < 0n)
      throw new Error("commission accrual: an apportionment weight cannot be negative");

  if (weights.length === 0) {
    // Refused rather than returning []. A non-zero total with nowhere to put it
    // means the caller lost money between the evaluator and the ledger, and
    // silently dropping it is the one outcome nobody would notice.
    if (totalMinor !== 0)
      throw new Error(
        `commission accrual: cannot apportion ${totalMinor} across no parts`,
      );
    return [];
  }

  const negative = totalMinor < 0;
  const magnitude = BigInt(negative ? -totalMinor : totalMinor);
  const shares = apportionMagnitude(magnitude, weights);
  return shares.map((share) => Number(negative ? -share : share));
}

function apportionMagnitude(total: bigint, weights: bigint[]): bigint[] {
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0n);

  /*
    Every band weighed nothing — a zero basis throughout, or a plan whose every
    applicable rate is zero — and yet there is a total to place. That total can
    only have come from somewhere outside the bands, and there is no principled
    split, so it all goes to the first part rather than being spread by a rule
    nobody could explain to the person it shorted. Concentrated and visible beats
    smeared and untraceable.
  */
  if (totalWeight === 0n) return weights.map((_, i) => (i === 0 ? total : 0n));

  const shares = weights.map((weight) => (total * weight) / totalWeight);
  const remainders = weights.map((weight) => (total * weight) % totalWeight);

  let leftover = total - shares.reduce((sum, share) => sum + share, 0n);

  const order = remainders
    .map((remainder, index) => ({ remainder, index }))
    .sort((a, b) =>
      a.remainder === b.remainder
        ? a.index - b.index
        : a.remainder > b.remainder
          ? -1
          : 1,
    );

  // `leftover` is strictly less than `weights.length`, so one pass always
  // exhausts it; a loop that wrapped would mean the floors above were wrong.
  for (let i = 0; i < order.length && leftover > 0n; i += 1) {
    shares[order[i]!.index] = shares[order[i]!.index]! + 1n;
    leftover -= 1n;
  }

  return shares;
}

/**
 * The parts of one evaluated earning.
 *
 * The total apportioned is `evaluation.amountMinor` — the settled figure after
 * the cap, not the pre-cap sum of the bands. See the file docblock.
 */
export function decomposeEvaluation(evaluation: CommissionEvaluation): AccrualPart[] {
  const weights = evaluation.slices.map(sliceWeight);
  const shares = apportion(evaluation.amountMinor, weights);

  return evaluation.slices.map((slice, index) => ({
    partIndex: index,
    tierIndex: slice.tierIndex,
    tierFrom: slice.tierFrom,
    rateBps: slice.rateBps,
    multiplierBps: slice.multiplierBps,
    fromMinor: slice.fromMinor,
    toMinor: slice.toMinor,
    basisMinor: slice.basisMinor,
    amountMinor: shares[index]!,
  }));
}

/**
 * Restate the invariant at a boundary, and throw where it is cheap to notice.
 *
 * Called on the write path rather than trusted, because the parts and the total
 * reach the database as separate columns of separate tables: anything that
 * builds parts by a route other than `decomposeEvaluation` — a backfill, a
 * later source type, a well-meant refactor — would otherwise persist a
 * decomposition that does not add up, and the row would look entirely normal
 * until somebody totalled it.
 */
export function assertPartsSumTo(
  totalMinor: number,
  parts: readonly { amountMinor: number }[],
): void {
  const sum = parts.reduce((running, part) => running + part.amountMinor, 0);
  if (sum !== totalMinor)
    throw new Error(
      `commission accrual: decomposition does not reconstruct its total — ${parts.length} parts sum to ${sum}, expected ${totalMinor}`,
    );
}

/** One rule's total contribution, across however many parts cited it. */
export interface RuleContribution {
  tierIndex: number;
  tierFrom: number;
  rateBps: number;
  multiplierBps: number;
  basisMinor: number;
  amountMinor: number;
  partCount: number;
}

/**
 * Roll parts up to the rule that produced them.
 *
 * Grouped on the full (tier, rate, multiplier) triple rather than on
 * `tierIndex` alone: one band can be walked at two different multipliers within
 * a single earning when an accelerator threshold falls inside it, and those are
 * two different rules paying two different amounts. Collapsing them would report
 * a blended multiplier that appears in no plan document.
 *
 * Exact by construction — no rounding happens here, only integer addition — so
 * the roll-up sums to the same total the parts do.
 */
export function summariseByRule(parts: readonly AccrualPart[]): RuleContribution[] {
  const byRule = new Map<string, RuleContribution>();

  for (const part of parts) {
    const key = `${part.tierIndex}:${part.rateBps}:${part.multiplierBps}`;
    const existing = byRule.get(key);
    if (existing) {
      existing.basisMinor += part.basisMinor;
      existing.amountMinor += part.amountMinor;
      existing.partCount += 1;
      continue;
    }
    byRule.set(key, {
      tierIndex: part.tierIndex,
      tierFrom: part.tierFrom,
      rateBps: part.rateBps,
      multiplierBps: part.multiplierBps,
      basisMinor: part.basisMinor,
      amountMinor: part.amountMinor,
      partCount: 1,
    });
  }

  return [...byRule.values()].sort(
    (a, b) => a.tierIndex - b.tierIndex || a.multiplierBps - b.multiplierBps,
  );
}

/** What a part row needs beyond the arithmetic, to be a ledger row. */
export interface AccrualPartContext {
  orgId: string;
  earningId: string;
  userId: string;
  planId: string;
  planVersionId: string;
  earnedOn: string;
  periodStart: string;
  periodEnd: string;
  sourceType: string;
  sourceId: string;
  currency: string;
}

/**
 * Ledger rows for one earning's decomposition.
 *
 * Every part carries the deal, the plan version and the period, denormalised.
 * That is redundancy on purpose: the decomposition read is "everything that
 * built this month's figure for this person", and joining four tables to answer
 * it would put the accrual read on the slow path of the one screen this ticket
 * exists to make people watch daily. The denormalised columns are copied from
 * the earning at insert and the earning's own are immutable, so they cannot
 * drift.
 */
export function accrualPartRows(context: AccrualPartContext, parts: readonly AccrualPart[]) {
  return parts.map((part) => ({
    orgId: context.orgId,
    earningId: context.earningId,
    userId: context.userId,
    planId: context.planId,
    planVersionId: context.planVersionId,
    earnedOn: context.earnedOn,
    periodStart: context.periodStart,
    periodEnd: context.periodEnd,
    sourceType: context.sourceType,
    sourceId: context.sourceId,
    currency: context.currency,
    partIndex: part.partIndex,
    tierIndex: part.tierIndex,
    tierFrom: part.tierFrom,
    rateBps: part.rateBps,
    multiplierBps: part.multiplierBps,
    sliceFromMinor: part.fromMinor,
    sliceToMinor: part.toMinor,
    basisMinor: part.basisMinor,
    amountMinor: part.amountMinor,
  }));
}
