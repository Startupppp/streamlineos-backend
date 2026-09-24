import {
  resolveProvider,
  type ProviderBlocked,
  type ProviderCredentials,
} from "../provider-blocked";
import { integrationFor } from "../integration-catalog";

/**
 * LinkedIn Recruiter System Connect — the interface, the mappers, and the
 * reason nothing runs through it.
 *
 * RSC is a partner programme: two-way candidate and stage sync into LinkedIn
 * Recruiter is only available to approved ATS partners holding partner keys.
 * This deployment has neither, and the honest shape of that is an interface
 * with no registered implementation — not a stub that pretends, and not a
 * silence that leaves a recruiter wondering why their Recruiter seat never
 * shows the pipeline.
 *
 * The mappers are here and are tested even though nothing calls them across a
 * network yet. They are the part that is genuinely ours: LinkedIn's ATS status
 * vocabulary is fixed and published, our six stages are ours, and the
 * translation between them is a decision we have to get right before a
 * partnership rather than during one. Testing them now is what makes
 * "when keys arrive, the same interface — no rewrite" a true claim instead of
 * an intention.
 */

export const RSC_PLATFORM = "LINKEDIN_RSC";

/**
 * LinkedIn's published ATS candidate states. Not ours, and deliberately not
 * renamed to look like ours — a mapping table where both sides use the same
 * words is a mapping nobody checks.
 */
export const RSC_STATES = [
  "NEW",
  "IN_REVIEW",
  "INTERVIEWING",
  "OFFER_EXTENDED",
  "HIRED",
  "REJECTED",
] as const;

export type RscState = (typeof RSC_STATES)[number];

/** Our pipeline stages, as `candidates.status` holds them. */
export type CandidateStage = "NEW" | "SCREENING" | "INTERVIEW" | "OFFER" | "HIRED" | "REJECTED";

/**
 * Ours → theirs. Total on purpose: a `Record` rather than a lookup with a
 * fallback, so adding a seventh stage to the pipeline fails to compile here
 * instead of silently syncing it as `NEW`.
 */
export const STAGE_TO_RSC: Record<CandidateStage, RscState> = {
  NEW: "NEW",
  SCREENING: "IN_REVIEW",
  INTERVIEW: "INTERVIEWING",
  OFFER: "OFFER_EXTENDED",
  HIRED: "HIRED",
  REJECTED: "REJECTED",
};

/**
 * Theirs → ours, for a candidate arriving from an InMail apply.
 *
 * Not the inverse of the table above, because it cannot be: LinkedIn has
 * states we do not model, and a state we cannot place has to land somewhere a
 * recruiter will look. `NEW` is that place — an applicant at the top of the
 * pipeline is recoverable, and one silently dropped is not.
 */
export function rscStateToStage(state: string): CandidateStage {
  const match = (Object.entries(STAGE_TO_RSC) as [CandidateStage, RscState][]).find(
    ([, theirs]) => theirs === state.toUpperCase(),
  );
  return match?.[0] ?? "NEW";
}

export interface RscCandidate {
  readonly candidateId: number;
  readonly firstName: string;
  readonly lastName: string | null;
  readonly email: string;
  readonly profileUrl: string | null;
  readonly jobPostingId: number;
}

export interface RscStageChange {
  readonly candidateId: number;
  readonly jobPostingId: number;
  readonly state: RscState;
  readonly changedAt: Date;
}

export interface RscInMailApply {
  readonly externalId: string;
  readonly name: string;
  readonly email: string;
  readonly profileUrl: string | null;
  readonly jobReference: string;
  readonly state: RscState;
}

export interface LinkedInRscAdapter {
  pushCandidate(credentials: ProviderCredentials, candidate: RscCandidate): Promise<{ externalId: string }>;
  pushStage(credentials: ProviderCredentials, change: RscStageChange): Promise<void>;
  pullInMailApply(credentials: ProviderCredentials, since: Date): Promise<RscInMailApply[]>;
}

/**
 * Empty, and the catalog says why in words a recruiter can act on.
 *
 * A partnership landing means registering an implementation here. Nothing else
 * in this file changes, which is the whole reason the interface exists before
 * the implementation does.
 */
export const RSC_ADAPTERS: ReadonlyMap<string, LinkedInRscAdapter> = new Map();

export function resolveRsc(
  credentials: ProviderCredentials | null,
): { adapter: LinkedInRscAdapter; credentials: ProviderCredentials } | ProviderBlocked {
  const definition = integrationFor(RSC_PLATFORM);
  return resolveProvider<LinkedInRscAdapter>(
    RSC_PLATFORM,
    credentials,
    RSC_ADAPTERS,
    definition?.label ?? "LinkedIn Recruiter",
    definition?.manualFallback ?? undefined,
  );
}
