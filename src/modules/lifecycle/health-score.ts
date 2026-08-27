import type {
  HealthFactorKey,
  HealthMissingReason,
} from "../../db/schema/crm/lifecycle";
import { HEALTH_FACTOR_KEYS } from "../../db/schema/crm/lifecycle";

/**
 * A customer health score that comes apart into the things it was made of.
 *
 * Pure, and with no database in sight, for the same reason the commission
 * evaluator is: this is a judgement, not a fact, and a judgement that can only
 * be exercised by writing four tables' worth of fixtures is one nobody will
 * revise when it turns out to be wrong. Every rule below can be argued with in
 * a spec by handing it four numbers.
 *
 * Three properties carry the design, and each of them exists because the health
 * score this codebase already has does the opposite:
 *
 * 1. A MISSING input is missing, not zero and not fifty. `cs-health.service.ts`
 *    substitutes `NEUTRAL_BASELINE = 50` for every input it could not measure,
 *    so a customer nobody has ever surveyed is indistinguishable from one whose
 *    survey came back exactly neutral. Those are different facts. Here a missing
 *    input is dropped from the weighting, named in the output, and the share of
 *    the model that actually spoke is reported beside the score.
 *
 * 2. The decomposition RECONSTRUCTS the score exactly. The effective weights are
 *    apportioned to sum to exactly 10000 basis points and each contribution is
 *    stored as an integer, so `round(sum(contributions) / 10000)` is the score —
 *    not approximately, always. A breakdown whose parts do not sum to the whole
 *    teaches the reader that the number is fuzzy when it is not, and they stop
 *    checking.
 *
 * 3. Too few inputs produces NO SCORE rather than a confident one. A composite
 *    resting on one of its four inputs is a number with false precision, and
 *    false precision is what gets a customer left alone until they cancel.
 *
 * Weights are basis points throughout — 2500 bp is a quarter — because a weight
 * table of floats summing to 0.9999999 is a rounding argument nobody wins, and
 * because these are stored in integer columns.
 */

export const BPS_SCALE = 10_000;

/**
 * What each input is worth when all four are present.
 *
 * The ordering is the substance and it is arguable, which is the point of
 * stating it in one table rather than spreading it through a service. Usage
 * leads because a customer who has stopped using the product has already left
 * and has not told anybody yet; engagement follows because silence is the last
 * thing that happens before a cancellation. Support and sentiment are what
 * people say, and people say things for many reasons.
 *
 * Sums to exactly `BPS_SCALE`, and `health-score.spec.ts` fails the build if a
 * later edit breaks that — a weight table that sums to 9800 silently deflates
 * every score by 2% and nothing else would notice.
 */
export const DEFAULT_HEALTH_WEIGHTS_BPS: Readonly<Record<HealthFactorKey, number>> = {
  usage: 3500,
  engagement: 2500,
  support: 2500,
  sentiment: 1500,
};

/**
 * Bumped whenever the weights or the thresholds below change.
 *
 * Stored on every assessment. Without it a re-tune restates every score already
 * written and nothing records that it happened, which is precisely what
 * `health_score_config`'s unversioned jsonb does today.
 */
export const HEALTH_WEIGHTS_VERSION = 1;

/**
 * The least share of the model that has to speak before a score is offered.
 *
 * Half. Under it the answer is "not enough inputs" — which is a useful answer:
 * it says the customer is unwatched, and being unwatched is the condition this
 * whole feature exists to make visible. Rounding it to a number instead would
 * hide exactly the customers most likely to be lost.
 */
export const MIN_HEALTH_COVERAGE_BPS = 5_000;

/**
 * The bands, in `crm_health`'s vocabulary because that is the enum
 * `business_parties.health_status` already holds. A second spelling of the same
 * three states is a second thing that can disagree with the first.
 */
export const HEALTHY_THRESHOLD = 70;
export const AT_RISK_THRESHOLD = 40;

export type HealthBand = "healthy" | "at_risk" | "critical";

export function healthBandOf(score: number): HealthBand {
  if (score >= HEALTHY_THRESHOLD) return "healthy";
  if (score >= AT_RISK_THRESHOLD) return "at_risk";
  return "critical";
}

/** The window an input was measured over. Per input; they do not share one. */
export interface HealthWindow {
  readonly days: number;
  readonly from: Date;
  readonly to: Date;
}

export interface MeasuredHealthFactor {
  readonly key: HealthFactorKey;
  readonly weightBps: number;
  readonly window: HealthWindow;
  readonly status: "measured";
  /** 0..100, where 100 is the healthiest this input can look. */
  readonly value: number;
  /** How many underlying observations produced the value. */
  readonly observations: number;
  /** The raw counts, so the value itself can be taken apart one more level. */
  readonly detail: Record<string, number | null>;
}

export interface MissingHealthFactor {
  readonly key: HealthFactorKey;
  readonly weightBps: number;
  readonly window: HealthWindow;
  readonly status: "missing";
  readonly reason: HealthMissingReason;
  readonly detail: Record<string, number | null>;
}

export type HealthFactor = MeasuredHealthFactor | MissingHealthFactor;

/** A factor as it comes out of the composite: what it was worth, and what it added. */
export type DecomposedHealthFactor = HealthFactor & {
  /** The weight after the missing inputs' share was redistributed. 0 if missing. */
  readonly effectiveWeightBps: number;
  /** `value * effectiveWeightBps`. 0 if missing. Sums to `score * BPS_SCALE`. */
  readonly contributionBps: number;
};

export interface HealthComposite {
  /** 0..100, or null when too little of the model spoke. Never a stand-in value. */
  readonly score: number | null;
  readonly band: HealthBand | null;
  /** Sum of the weights that were measured. `BPS_SCALE` when all four were. */
  readonly coverageBps: number;
  readonly weightsVersion: number;
  /** Every input, measured or not, in the vocabulary's own order. */
  readonly factors: readonly DecomposedHealthFactor[];
  /** Present exactly when `score` is null. Says which inputs were unavailable. */
  readonly unscored: {
    readonly reason: "insufficient-coverage";
    readonly missing: readonly {
      readonly key: HealthFactorKey;
      readonly weightBps: number;
      readonly reason: HealthMissingReason;
    }[];
  } | null;
}

/**
 * Largest-remainder apportionment of `BPS_SCALE` across the given weights.
 *
 * Plain rounding is the obvious implementation and it is wrong here: three
 * weights of 3333 each round to 3333 and the effective weights sum to 9999, so
 * the decomposition comes up a point short of the score it is supposed to
 * explain. Apportionment hands the leftover basis points to the largest
 * remainders and the total is exact by construction.
 *
 * Ties break on position so the same inputs always produce the same output — a
 * score that changes when the rows come back in a different order is a score
 * two people will read differently on the same day.
 */
export function apportionBps(weights: readonly number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return weights.map(() => 0);

  const exact = weights.map((weight) => (weight * BPS_SCALE) / total);
  const shares = exact.map((value) => Math.floor(value));
  let remainder = BPS_SCALE - shares.reduce((sum, share) => sum + share, 0);

  const byRemainder = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (let i = 0; remainder > 0 && i < byRemainder.length; i += 1, remainder -= 1) {
    shares[byRemainder[i]!.index] += 1;
  }

  return shares;
}

/**
 * The composite.
 *
 * Every input is returned whether it was measured or not — the missing ones with
 * a reason and a zero effective weight. A caller that only wanted the number can
 * ignore them; a caller that has to explain the number to a customer success
 * manager cannot, and this is the only place that information exists.
 */
export function compositeHealth(
  factors: readonly HealthFactor[],
  weightsVersion: number = HEALTH_WEIGHTS_VERSION,
): HealthComposite {
  /**
   * Canonical order, not the caller's. The factor rows are written in this order
   * and every surface reads them in it; letting the argument order decide would
   * make two assessments of the same customer render their inputs differently
   * depending on which query returned first.
   */
  const ordered = HEALTH_FACTOR_KEYS.map((key) =>
    factors.find((factor) => factor.key === key),
  ).filter((factor): factor is HealthFactor => factor !== undefined);

  const measured = ordered.filter(
    (factor): factor is MeasuredHealthFactor => factor.status === "measured",
  );

  const coverageBps = measured.reduce((sum, factor) => sum + factor.weightBps, 0);
  const effective = apportionBps(measured.map((factor) => factor.weightBps));

  const effectiveByKey = new Map<HealthFactorKey, number>();
  measured.forEach((factor, index) => {
    effectiveByKey.set(factor.key, effective[index] ?? 0);
  });

  const decomposed: DecomposedHealthFactor[] = ordered.map((factor) => {
    if (factor.status === "missing") {
      return { ...factor, effectiveWeightBps: 0, contributionBps: 0 };
    }
    const effectiveWeightBps = effectiveByKey.get(factor.key) ?? 0;
    /**
     * Clamped here rather than trusted from the caller. A value outside 0..100
     * would violate the column's CHECK and, worse, would put a score outside the
     * band vocabulary — which renders as nothing at all on every surface that
     * colours by one.
     */
    const value = Math.min(100, Math.max(0, Math.round(factor.value)));
    return {
      ...factor,
      value,
      effectiveWeightBps,
      contributionBps: value * effectiveWeightBps,
    };
  });

  if (coverageBps < MIN_HEALTH_COVERAGE_BPS) {
    return {
      score: null,
      band: null,
      coverageBps,
      weightsVersion,
      factors: decomposed,
      unscored: {
        reason: "insufficient-coverage",
        missing: ordered
          .filter((factor): factor is MissingHealthFactor => factor.status === "missing")
          .map((factor) => ({
            key: factor.key,
            weightBps: factor.weightBps,
            reason: factor.reason,
          })),
      },
    };
  }

  const contribution = decomposed.reduce(
    (sum, factor) => sum + factor.contributionBps,
    0,
  );
  const score = Math.min(100, Math.max(0, Math.round(contribution / BPS_SCALE)));

  return {
    score,
    band: healthBandOf(score),
    coverageBps,
    weightsVersion,
    factors: decomposed,
    unscored: null,
  };
}
