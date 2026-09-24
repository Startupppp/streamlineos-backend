import {
  resolveProvider,
  type ProviderBlocked,
  type ProviderCredentials,
} from "../integrations/provider-blocked";

export const ASSESSMENT_PLATFORM = "ASSESSMENT";

export interface AssessmentInviteRequest {
  /** The vendor's own test identifier, chosen by the recruiter. */
  testId: string;
  candidateEmail: string;
  candidateName: string;
  /** Ours, echoed back on the score webhook. */
  externalCaseKey: string;
}

export interface AssessmentInviteAccepted {
  /** The vendor's invitation id; every later score must carry it. */
  reference: string;
  /** Where the candidate takes the test. */
  candidateUrl: string;
}

export interface AssessmentAdapter {
  invite(
    credentials: ProviderCredentials,
    request: AssessmentInviteRequest,
  ): Promise<AssessmentInviteAccepted>;
}

/**
 * Empty, and the shape of the refusal is the deliverable.
 *
 * A stub adapter here would be worse than in most places: it would produce an
 * invitation URL that goes nowhere, and a candidate who follows it and finds a
 * dead page has been told by the employer to sit a test that does not exist.
 * The manual fallback — send the test from the vendor's own dashboard, record
 * the score here — is a real workflow that loses only the automation.
 */
export const ASSESSMENT_ADAPTERS: ReadonlyMap<string, AssessmentAdapter> = new Map();

export function resolveAssessment(
  credentials: ProviderCredentials | null,
): { adapter: AssessmentAdapter; credentials: ProviderCredentials } | ProviderBlocked {
  return resolveProvider(
    ASSESSMENT_PLATFORM,
    credentials,
    ASSESSMENT_ADAPTERS,
    "Assessments",
    "Send the test from the vendor's own dashboard and record the score here.",
  );
}

/**
 * A score, in the only form this product stores.
 *
 * Normalised to a percentage rather than kept in the vendor's own scale. Two
 * vendors reporting "42" mean different things and a recruiter comparing
 * candidates across them would be comparing nothing; `maxScore` is kept so the
 * raw figure can still be shown beside it.
 */
export interface NormalisedScore {
  score: number;
  maxScore: number;
  percent: number;
}

export function normaliseScore(score: number, maxScore: number): NormalisedScore | null {
  if (!Number.isFinite(score) || !Number.isFinite(maxScore)) return null;
  if (maxScore <= 0) return null;
  if (score < 0 || score > maxScore) return null;
  return { score, maxScore, percent: Math.round((score / maxScore) * 1000) / 10 };
}

/**
 * Whether a score passes, given the org's bar.
 *
 * Returns null when no bar is set rather than guessing one. A default pass mark
 * would put PASSED or FAILED on a candidate's record on the strength of a
 * number this product invented.
 */
export function verdictFor(
  percent: number,
  passPercent: number | null,
): "PASSED" | "FAILED" | null {
  if (passPercent === null) return null;
  return percent >= passPercent ? "PASSED" : "FAILED";
}
