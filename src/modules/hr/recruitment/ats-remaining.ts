import {
  STAGE_TRANSITIONS,
  type CandidateStage,
} from "./recruitment-candidate-stages";

/**
 * Ratings on a scorecard are 0–10. A hiring-flow round's
 * `autoAdvanceThreshold` is 0–100. Comparing them raw would never advance.
 */
export function scorePercent(ratings: Record<string, number>): number | null {
  const values = Object.values(ratings).filter((n) => typeof n === "number" && Number.isFinite(n));
  if (values.length === 0) return null;
  const average = values.reduce((sum, n) => sum + n, 0) / values.length;
  return Math.round((average / 10) * 100);
}

const HIRE_RECOMMENDATIONS = new Set(["HIRE", "STRONG_HIRE"]);

/**
 * One legal step, and only out of screening or interview.
 *
 * Offer → Hired is the accept path. A scorecard must not hire someone.
 */
const SCORECARD_NEXT: Partial<Record<CandidateStage, CandidateStage>> = {
  SCREENING: "INTERVIEW",
  INTERVIEW: "OFFER",
};

export function advanceStageForScorecard(input: {
  stage: string;
  recommendation: string;
  ratings: Record<string, number>;
  threshold: number | null;
}): CandidateStage | null {
  if (input.threshold == null) return null;
  if (!HIRE_RECOMMENDATIONS.has(input.recommendation)) return null;
  const percent = scorePercent(input.ratings);
  if (percent == null || percent < input.threshold) return null;
  if (!(input.stage in STAGE_TRANSITIONS)) return null;
  const stage = input.stage as CandidateStage;
  const next = SCORECARD_NEXT[stage];
  if (!next) return null;
  if (!(STAGE_TRANSITIONS[stage] ?? []).includes(next)) return null;
  return next;
}

export interface FlowRound {
  name: string;
  roundType: string;
  mode: string;
  autoAdvanceThreshold: number | null;
}

const INTERVIEW_TYPE_HINT: Record<string, { roundType?: string; mode?: string }> = {
  HR: { roundType: "HR_SCREENING" },
  TECHNICAL: { roundType: "TECHNICAL" },
  FINAL: { roundType: "FINAL" },
  PHONE: { mode: "PHONE" },
  VIDEO: { mode: "VIDEO" },
  ONSITE: { mode: "ONSITE" },
};

/**
 * The round whose threshold this scorecard is judged against.
 *
 * An interview has no round id. When more than one round could match, and
 * more than one of those has a threshold, there is nothing honest to pick.
 */
export function roundForInterview<T extends FlowRound>(rounds: readonly T[], interviewType: string): T | null {
  const hint = INTERVIEW_TYPE_HINT[interviewType];
  const matches = hint
    ? rounds.filter(
        (round) =>
          (hint.roundType !== undefined && round.roundType === hint.roundType) ||
          (hint.mode !== undefined && round.mode === hint.mode),
      )
    : [];
  const pool = matches.length > 0 ? matches : rounds;
  const gated = pool.filter((round) => round.autoAdvanceThreshold != null);
  if (gated.length === 1) return gated[0] ?? null;
  if (matches.length === 1) return matches[0] ?? null;
  return null;
}

export interface JobRoundNames {
  rounds: readonly { name: string; roundType: string }[];
}

/**
 * Column titles stay the six legal stages. A round name is a subtitle, and
 * only when every open job agrees. Disagreeing jobs must not rename a column
 * to one of them.
 */
export function roundLabelForStage(stage: string, jobs: readonly JobRoundNames[]): string | null {
  if (stage !== "SCREENING" && stage !== "INTERVIEW") return null;
  const labels = jobs
    .map((job) => {
      const picked = job.rounds.filter((round) =>
        stage === "SCREENING" ? round.roundType === "HR_SCREENING" : round.roundType !== "HR_SCREENING",
      );
      return picked.map((round) => round.name).join(" · ");
    })
    .filter((label) => label.length > 0);
  const unique = [...new Set(labels)];
  if (unique.length === 0) return null;
  if (unique.length === 1) return unique[0] ?? null;
  return "Rounds differ by job";
}

/** Referral `bonus_amount` is major units. The payable event carries minor units. */
export function bonusAmountMinor(amount: string | null | undefined): number | null {
  if (amount == null) return null;
  const trimmed = amount.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}
