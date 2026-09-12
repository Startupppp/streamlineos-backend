/**
 * When a tenant is allowed to be told a learned number, and what they are told
 * instead.
 *
 * Twelve closed deals cannot support fourteen coefficients. A model fitted on
 * them would still return a probability, still return an interval, and still
 * rank its factors — it would look exactly like a forecast, and it would be
 * noise. Presenting that as a learned forecast spends the tenant's trust once,
 * and they do not give it back.
 *
 * So there is a floor, and below it the product says plainly that the number on
 * screen is the weighted pipeline the tenant already had — the same stage
 * probabilities they typed in themselves — and how many more closed deals it
 * needs before it can do better.
 *
 * The floor is 60 closed deals with at least 15 of each outcome. With fourteen
 * features that is roughly one event per variable for the smaller class, well
 * under the ten-per-variable rule of thumb, which is why the ridge penalty is
 * mandatory rather than a tuning choice and why every score ships an interval.
 * The interval is what makes the low bar honest: at 60 examples it is wide, and
 * a rep can see that it is. A higher floor would be statistically tidier and
 * would leave most tenants with nothing for a year.
 */
import type { ForecastMetrics } from "./forecast-metrics";

export const FORECAST_HISTORY_REQUIREMENT = {
  minClosedDeals: 60,
  minPerOutcome: 15,
} as const;

/** Held back from every training run and never fitted on. */
export const HOLDOUT_FRACTION = 0.25;

export const FORECAST_ACCEPTANCE = {
  /**
   * Below this the model cannot tell two deals apart well enough to be worth
   * replacing a number the tenant understands. 0.5 is a coin.
   */
  minAuc: 0.6,
  /**
   * And it must be at least as close to the outcomes as the naive weighted
   * forecast was on the same held-out deals. A model that ranks well but is
   * badly calibrated makes a worse pipeline total, which is what people plan
   * against.
   */
  maxBrierRatioVsNaive: 1,
  minHoldoutDeals: 10,
} as const;

/**
 * The furthest a stored forecast is allowed to go towards certainty.
 *
 * A logistic fit on separable data drives the logit far enough that
 * `sigmoid` rounds to exactly 1 in double precision, and a small pipeline is
 * separable more often than it sounds: every deal that was worked was won and
 * every deal nobody touched was lost is a real pattern, not a synthetic one.
 * The arithmetic is not wrong — the claim is. "100%" tells a rep the deal is
 * banked and makes `expectedValue` equal to the full contract value, and no
 * model fitted on sixty closed deals has earned either statement.
 *
 * So the band is applied where a probability becomes something the product
 * asserts — the stored score and the pipeline weight — and NOT to the holdout
 * predictions the acceptance gate reads. Clamping before the gate would flatter
 * a badly calibrated model by pulling its worst predictions towards the middle,
 * which is the one place this must not help.
 *
 * 0.02/0.98 rather than something tighter: wide enough that a genuinely
 * confident model still reads as confident, narrow enough that nothing on
 * screen ever says a deal is certain.
 */
export const FORECAST_REPORTED_BAND = { floor: 0.02, ceiling: 0.98 } as const;

/** Pulls a probability inside the band the product is willing to assert. */
export function reportableProbability(probability: number): number {
  if (!Number.isFinite(probability)) return 0.5;
  return Math.min(
    FORECAST_REPORTED_BAND.ceiling,
    Math.max(FORECAST_REPORTED_BAND.floor, probability),
  );
}

export interface ClosedHistory {
  readonly won: number;
  readonly lost: number;
}

export interface ForecastReadiness {
  readonly ready: boolean;
  readonly closedDeals: number;
  readonly wonDeals: number;
  readonly lostDeals: number;
  readonly minimumClosedDeals: number;
  readonly minimumPerOutcome: number;
  /** How many more closed deals, of any outcome, before the learned forecast begins. */
  readonly closedDealsNeeded: number;
  readonly wonDealsNeeded: number;
  readonly lostDealsNeeded: number;
}

/**
 * Whether this tenant has enough history, and exactly what is missing.
 *
 * `closedDealsNeeded` is the larger of the two shortfalls rather than their sum
 * or the headline gap alone: a tenant on 60 closed deals of which 10 were won
 * needs five more deals, but they have to be wins, and saying "none" would be a
 * lie the surface then has to explain away.
 */
export function assessForecastHistory(history: ClosedHistory): ForecastReadiness {
  const won = Math.max(0, Math.trunc(history.won));
  const lost = Math.max(0, Math.trunc(history.lost));
  const closed = won + lost;

  const wonDealsNeeded = Math.max(0, FORECAST_HISTORY_REQUIREMENT.minPerOutcome - won);
  const lostDealsNeeded = Math.max(0, FORECAST_HISTORY_REQUIREMENT.minPerOutcome - lost);
  const headlineShortfall = Math.max(0, FORECAST_HISTORY_REQUIREMENT.minClosedDeals - closed);

  return {
    ready: headlineShortfall === 0 && wonDealsNeeded === 0 && lostDealsNeeded === 0,
    closedDeals: closed,
    wonDeals: won,
    lostDeals: lost,
    minimumClosedDeals: FORECAST_HISTORY_REQUIREMENT.minClosedDeals,
    minimumPerOutcome: FORECAST_HISTORY_REQUIREMENT.minPerOutcome,
    closedDealsNeeded: Math.max(headlineShortfall, wonDealsNeeded + lostDealsNeeded),
    wonDealsNeeded,
    lostDealsNeeded,
  };
}

export type ModelRejection =
  | "no-holdout"
  | "cannot-discriminate"
  | "no-better-than-naive"
  | "did-not-converge";

export type ModelVerdict =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: ModelRejection };

/**
 * Whether a freshly fitted model has earned the right to replace the weighted
 * pipeline, judged only on deals it never saw.
 *
 * Deliberately one-sided. Rejecting a good model costs the tenant a number they
 * were already living without; accepting a bad one puts a confident figure in
 * front of someone about to plan a quarter around it.
 */
export function acceptModel(
  learned: ForecastMetrics,
  naive: ForecastMetrics,
  converged: boolean,
): ModelVerdict {
  if (!converged) return { accepted: false, reason: "did-not-converge" };
  if (learned.count < FORECAST_ACCEPTANCE.minHoldoutDeals)
    return { accepted: false, reason: "no-holdout" };
  if (learned.auc < FORECAST_ACCEPTANCE.minAuc)
    return { accepted: false, reason: "cannot-discriminate" };
  if (learned.brier > naive.brier * FORECAST_ACCEPTANCE.maxBrierRatioVsNaive)
    return { accepted: false, reason: "no-better-than-naive" };
  return { accepted: true };
}

export type NaiveReason = ModelRejection | "insufficient-history" | "not-trained-yet";

export interface LearnedBasis {
  readonly kind: "learned";
  readonly modelId: string;
  readonly trainedAt: string;
  readonly featureSpecVersion: string;
  readonly trainingDeals: number;
  readonly holdoutDeals: number;
  readonly holdout: ForecastMetrics;
  readonly naiveHoldout: ForecastMetrics;
  readonly becameAvailableAt: string;
}

export interface NaiveBasis {
  readonly kind: "naive-weighted";
  readonly reason: NaiveReason;
  readonly readiness: ForecastReadiness;
}

/**
 * What the number on screen actually is.
 *
 * A discriminated union rather than a boolean and some optional fields, so a
 * surface cannot render a learned forecast's confidence next to a naive one's
 * arithmetic by forgetting a check.
 */
export type ForecastBasis = LearnedBasis | NaiveBasis;
