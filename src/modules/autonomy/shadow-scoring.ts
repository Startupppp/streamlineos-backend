import type { DecisionKind } from "../../db/schema/crm/autonomous-decisions";
import type { ShadowVerdict } from "../../db/schema/crm/autonomy-scoring";
import { actThresholdFor } from "./decision-record";

/**
 * Deciding what to score, and what a disagreement means.
 *
 * Pure. Sampling that is not deterministic per decision cannot be tested and
 * cannot be reasoned about after the fact — "was this one scored?" has to have
 * an answer that does not depend on when you ask.
 */

export interface SamplingSettings {
  readonly shadowSampleRate: number;
  readonly shadowDailyCap: number;
}

export interface SamplingInput {
  readonly decisionId: string;
  readonly kind: DecisionKind;
  readonly outcome: string;
  readonly confidence: number | null;
  readonly settings: SamplingSettings;
  /** How many scores this organisation has already written today. */
  readonly scoredToday: number;
}

export interface SamplingDecision {
  readonly score: boolean;
  readonly reason:
    | "not-applied"
    | "routine"
    | "daily-cap-reached"
    | "rate-zero"
    | "near-threshold"
    | "sampled"
    | "not-sampled";
}

/**
 * Routine filing is deterministic and has no judgement to second-guess.
 *
 * Scoring it would spend the daily cap on the one action type that cannot be
 * wrong, crowding out the ones that can.
 */
const NEVER_SCORED: ReadonlySet<DecisionKind> = new Set(["activity.logged"]);

/**
 * A stable number in [0, 1) derived from the decision id.
 *
 * `Math.random()` would mean a retry of the same decision could sample
 * differently, so a replayed workflow would score work it already scored — and
 * the unique index would then reject the second write as a conflict rather than
 * as the no-op it actually is. Hashing the id makes sampling a property of the
 * decision rather than of the moment.
 */
export function samplingFraction(decisionId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < decisionId.length; i++) {
    hash ^= decisionId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  // >>> 0 first: Math.imul returns a signed 32-bit value.
  return (hash >>> 0) / 2 ** 32;
}

export function shouldShadowScore(input: SamplingInput): SamplingDecision {
  // Only a decision that changed something has an outcome worth checking.
  if (input.outcome !== "applied") return { score: false, reason: "not-applied" };
  if (NEVER_SCORED.has(input.kind)) return { score: false, reason: "routine" };
  if (input.settings.shadowDailyCap <= 0 || input.scoredToday >= input.settings.shadowDailyCap)
    return { score: false, reason: "daily-cap-reached" };
  if (input.settings.shadowSampleRate <= 0) return { score: false, reason: "rate-zero" };

  /**
   * Always score the marginal ones.
   *
   * A decision that cleared its threshold by a hair is where the system is most
   * likely to be wrong, and leaving those to a 10% dice roll wastes the sample
   * on the confident cases that were never in doubt.
   */
  if (input.confidence !== null) {
    const threshold = actThresholdFor(input.kind);
    if (input.confidence < threshold + 0.05) return { score: true, reason: "near-threshold" };
  }

  return samplingFraction(input.decisionId) < input.settings.shadowSampleRate
    ? { score: true, reason: "sampled" }
    : { score: false, reason: "not-sampled" };
}

/**
 * Whether a second opinion is worth a human's attention.
 *
 * Derived here rather than taken from the scorer, for the same reason
 * reversibility is derived from the action kind: a caller that could set it
 * would eventually set it wrong, and the review queue is only useful while
 * everything in it deserves to be there.
 */
export function needsHumanReview(
  verdict: ShadowVerdict,
  originalConfidence: number | null,
  kind: DecisionKind,
): boolean {
  // An outright disagreement always goes to a person.
  if (verdict === "disagrees") return true;

  /**
   * A failed second pass is NOT routed.
   *
   * It says nothing about the decision — only that the scorer broke. Routing it
   * would fill the queue with provider outages and teach people to clear the
   * queue without reading it.
   */
  if (verdict === "failed") return false;

  // Uncertain only matters when the original was itself marginal.
  if (verdict === "uncertain" && originalConfidence !== null)
    return originalConfidence < actThresholdFor(kind) + 0.1;

  return false;
}

/** Clamp a stored rate into range, so a bad row cannot spend without limit. */
export function normaliseSampleRate(value: number | string | null | undefined): number {
  const parsed = typeof value === "string" ? Number.parseFloat(value) : (value ?? Number.NaN);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(1, Math.max(0, parsed));
}
