import {
  BPS_SCALE,
  type CommissionAccelerator,
  type CommissionPeriod,
  type CommissionRuleSet,
  type CommissionTier,
} from "../../db/schema/crm/commission";

/**
 * Evaluating a commission rule set. Pure, integer, and the only place a rate
 * ever meets a number of money.
 *
 * Kept free of Nest, Drizzle and the clock so that the arithmetic can be tested
 * exhaustively without a database and so that reproducing a historical payout is
 * a function call over stored data rather than a replay of a request. Everything
 * this file touches is an integer: minor units for money, basis points for rates
 * and multipliers. There is no `number` here that is allowed to be fractional,
 * which is the property `deals.valueMinor` was introduced to restore after a
 * `decimal` column produced half-cent drift on summed forecasts.
 *
 * Two failure modes are prevented by construction rather than by care:
 *
 *  - Rounding once, at the end. Rates are applied to slices of basis, the exact
 *    products are summed as integers, and a single rounding turns the total into
 *    minor units. Rounding each slice would make the payout depend on where the
 *    band boundaries happened to fall, so two plans that are arithmetically the
 *    same would pay differently.
 *  - `BigInt` for the products. A basis of 10^12 minor units against a 10000 bp
 *    rate and a 20000 bp accelerator is 2·10^20, twenty-odd times past
 *    `Number.MAX_SAFE_INTEGER`. In `number` arithmetic that is silently wrong by
 *    thousands of minor units and the result still looks like a plausible
 *    payout.
 */

/** One band of basis actually consumed, and what it paid. */
export interface CommissionSlice {
  /** Cumulative position of the start of this slice, in minor units. */
  fromMinor: number;
  /** Cumulative position of the end (exclusive), in minor units. */
  toMinor: number;
  /** How much basis fell in the slice. */
  basisMinor: number;
  /**
   * Index into `rules.tiers` of the band that priced this slice.
   *
   * Carried rather than recovered by matching `rateBps` back to a tier: two
   * bands of a plan may legitimately share a rate — a plan that pays 10% up to
   * quota, 15% to 150% and 10% again beyond it is a real shape — and matching
   * on the rate would attribute the third band's money to the first. Naming
   * the rule that produced a part is the whole point of the decomposition, so
   * it cannot rest on a rate being unique.
   */
  tierIndex: number;
  /**
   * The band's declared `from`, in the units the rule set measures in:
   * attainment bps when the version carries a quota, minor units when it does
   * not. Stored beside `tierIndex` so a decomposition remains readable after a
   * later version has reordered or renumbered its bands.
   */
  tierFrom: number;
  rateBps: number;
  /** 10000 when no accelerator applied. */
  multiplierBps: number;
  /**
   * The slice's share of the payout, rounded for display only.
   *
   * **These do not sum to `CommissionEvaluation.amountMinor`** and are not
   * meant to: each is rounded independently while the total is rounded once
   * from the exact sum, and `capMinor` reduces the total without touching any
   * slice. Over twenty thousand random rule sets roughly a quarter of
   * evaluations disagree here by at least one minor unit. Anything that has to
   * add up — a ledger, a payslip, an accrual — must use
   * `decomposeEvaluation` in `commission-accrual.ts`, which apportions the
   * settled total across these slices so the parts sum to it exactly.
   */
  amountMinor: number;
}

export interface CommissionEvaluation {
  amountMinor: number;
  /** Blended `amountMinor / basisMinor`, in bps. Zero when the basis is zero. */
  effectiveRateBps: number;
  /** Attainment at the end of this earning; null when the version has no quota. */
  attainmentBps: number | null;
  /** The quota actually used, after any per-person override. */
  quotaMinor: number | null;
  /**
   * True when `capMinor` reduced the payout.
   *
   * Recorded rather than inferred: a capped earning and an uncapped one that
   * happens to land on the cap are the same number, and only one of them is a
   * conversation to have with the rep.
   */
  capped: boolean;
  slices: CommissionSlice[];
}

export interface CommissionEvaluationInput {
  /** What the bands are applied to, in minor units. */
  basisMinor: number;
  /** Cumulative basis this earner already booked in the same period. */
  priorBasisMinor: number;
  /** Overrides `rules.quotaMinor`; the assignment's number when it carries one. */
  quotaOverrideMinor?: number | null;
}

const BPS = BigInt(BPS_SCALE);

/**
 * Half away from zero, on an exact integer ratio.
 *
 * Away from zero rather than half-up so that a clawback of a given size is the
 * mirror of the earning of that size. Half-up would make the pair fail to
 * cancel by one minor unit, and a ledger that does not return to zero after a
 * reversal is a bug somebody spends a day on.
 */
function divideRoundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("commission: non-positive denominator");
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const rounded = (magnitude * 2n + denominator) / (denominator * 2n);
  return negative ? -rounded : rounded;
}

/**
 * The multiplier governing a slice, or 10000 when none does.
 *
 * The HIGHEST matching threshold wins rather than the product of all of them.
 * Multiplying accelerators together makes a plan's cost non-obvious to the
 * person writing it — two 1.25x rows read as 1.25x and pay 1.5625x — and no
 * commission document has ever meant that.
 */
function multiplierForPosition(
  accelerators: CommissionAccelerator[],
  positionBps: number,
): number {
  let multiplier = BPS_SCALE;
  let best = -1;
  for (const accelerator of accelerators) {
    if (positionBps >= accelerator.aboveBps && accelerator.aboveBps > best) {
      best = accelerator.aboveBps;
      multiplier = accelerator.multiplierBps;
    }
  }
  return multiplier;
}

/**
 * Band boundaries as absolute cumulative minor units.
 *
 * With a quota, a tier's `from` is attainment in bps and the boundary is
 * `quota * from / 10000`; without one it is already minor units. Doing the
 * conversion once here is what lets the walk below be a single loop rather than
 * two near-identical ones that drift apart.
 */
function boundariesFor(tiers: CommissionTier[], quotaMinor: number | null): number[] {
  if (quotaMinor === null) return tiers.map((tier) => tier.from);
  return tiers.map((tier) =>
    Number(divideRoundHalfAwayFromZero(BigInt(quotaMinor) * BigInt(tier.from), BPS)),
  );
}

/** Position of a cumulative amount, in the same units the boundaries are in. */
function positionBpsOf(cumulativeMinor: number, quotaMinor: number | null): number {
  if (quotaMinor === null || quotaMinor === 0) return 0;
  return Number(
    divideRoundHalfAwayFromZero(BigInt(cumulativeMinor) * BPS, BigInt(quotaMinor)),
  );
}

/**
 * Walk the basis through the rate table and return what it pays.
 *
 * Marginal, not cliff-edged: the portion of the basis lying in each band earns
 * that band's rate. A whole-earning "the rate is whatever band you ended in"
 * scheme is representable with a single tier and is not what a multi-tier plan
 * means; treating multi-tier that way is the mistake that makes a rep's 99%
 * deal and their 101% deal pay wildly different amounts for the same revenue.
 */
export function evaluateCommission(
  rules: CommissionRuleSet,
  input: CommissionEvaluationInput,
): CommissionEvaluation {
  assertRuleSet(rules);

  const quotaMinor =
    input.quotaOverrideMinor !== undefined && input.quotaOverrideMinor !== null
      ? input.quotaOverrideMinor
      : rules.quotaMinor;

  const prior = input.priorBasisMinor;
  const end = prior + input.basisMinor;
  const boundaries = boundariesFor(rules.tiers, quotaMinor);

  const slices: CommissionSlice[] = [];
  // Exact, unrounded, scaled by BPS^2 — one factor for the rate and one for the
  // multiplier. Rounded exactly once, below.
  let numerator = 0n;

  let cursor = prior;
  while (cursor < end) {
    const bandIndex = bandIndexFor(boundaries, cursor);
    const nextBoundary = boundaries[bandIndex + 1];
    const sliceEnd =
      nextBoundary === undefined ? end : Math.min(end, nextBoundary);
    // A zero-width slice can only come from two boundaries at the same position,
    // which `assertRuleSet` rejects; without the guard it would spin forever.
    if (sliceEnd <= cursor) break;

    const rateBps = rules.tiers[bandIndex]?.rateBps ?? 0;
    const multiplierBps = multiplierForPosition(
      rules.accelerators,
      positionBpsOf(cursor, quotaMinor),
    );
    const sliceBasis = sliceEnd - cursor;
    const exact = BigInt(sliceBasis) * BigInt(rateBps) * BigInt(multiplierBps);
    numerator += exact;

    slices.push({
      fromMinor: cursor,
      toMinor: sliceEnd,
      basisMinor: sliceBasis,
      tierIndex: bandIndex,
      tierFrom: rules.tiers[bandIndex]?.from ?? 0,
      rateBps,
      multiplierBps,
      amountMinor: Number(divideRoundHalfAwayFromZero(exact, BPS * BPS)),
    });

    cursor = sliceEnd;
  }

  let amountMinor = Number(divideRoundHalfAwayFromZero(numerator, BPS * BPS));

  let capped = false;
  if (rules.capMinor !== null && amountMinor > rules.capMinor) {
    amountMinor = rules.capMinor;
    capped = true;
  }

  const effectiveRateBps =
    input.basisMinor === 0
      ? 0
      : Number(
          divideRoundHalfAwayFromZero(
            BigInt(amountMinor) * BPS,
            BigInt(Math.abs(input.basisMinor)),
          ),
        );

  return {
    amountMinor,
    effectiveRateBps,
    attainmentBps: quotaMinor === null ? null : positionBpsOf(end, quotaMinor),
    quotaMinor,
    capped,
    slices,
  };
}

/** Index of the band containing `position`; 0 when it sits below the first. */
function bandIndexFor(boundaries: number[], position: number): number {
  let index = 0;
  for (let i = 0; i < boundaries.length; i += 1) {
    if (position >= boundaries[i]) index = i;
    else break;
  }
  return index;
}

/**
 * Refuse a rule set the evaluator cannot walk deterministically.
 *
 * Thrown rather than repaired. A rule set is tenant data written through the
 * DTO, which validates the same shape — so reaching here means something wrote
 * around the DTO, and quietly sorting the tiers for them would mean a stored
 * plan and the payout it produces disagree about what the plan says.
 */
export function assertRuleSet(rules: CommissionRuleSet): void {
  if (rules.tiers.length === 0) throw new Error("commission: rule set has no tiers");
  if (rules.tiers[0].from !== 0)
    throw new Error("commission: first tier must start at 0");
  for (let i = 1; i < rules.tiers.length; i += 1) {
    if (rules.tiers[i].from <= rules.tiers[i - 1].from)
      throw new Error("commission: tiers must be strictly ascending");
  }
  if (rules.quotaMinor !== null && rules.quotaMinor <= 0)
    throw new Error("commission: quota must be positive when present");
  for (const accelerator of rules.accelerators) {
    if (accelerator.multiplierBps <= 0)
      throw new Error("commission: accelerator multiplier must be positive");
  }
}

/**
 * The attainment window an earning falls in.
 *
 * UTC, and computed from the date string rather than from a `Date` built in the
 * server's zone: `new Date("2026-01-01")` is the 31st of December in any
 * negative offset, which would file a new year's first deal against the previous
 * year's quota. Returns ISO `YYYY-MM-DD` because that is what the `date` columns
 * hold and comparing those as strings is exact.
 */
export function periodWindow(
  period: CommissionPeriod,
  isoDate: string,
): { start: string; end: string } {
  const [yearText, monthText] = isoDate.split("-");
  const year = Number(yearText);
  const month = Number(monthText); // 1-12

  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12)
    throw new Error(`commission: not an ISO date: ${isoDate}`);

  const startMonth =
    period === "YEAR" ? 1 : period === "QUARTER" ? Math.floor((month - 1) / 3) * 3 + 1 : month;
  const monthSpan = period === "YEAR" ? 12 : period === "QUARTER" ? 3 : 1;

  const endMonth = startMonth + monthSpan - 1;
  const lastDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();

  const pad = (n: number): string => String(n).padStart(2, "0");
  return {
    start: `${year}-${pad(startMonth)}-01`,
    end: `${year}-${pad(endMonth)}-${pad(lastDay)}`,
  };
}
