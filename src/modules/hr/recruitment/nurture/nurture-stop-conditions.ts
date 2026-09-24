/**
 * When a nurture campaign stops sending, and what it records as the reason.
 *
 * Pure, so the ordering below is pinned by a test rather than by whichever
 * branch the worker happens to evaluate first. Ordering is the whole of the
 * design here: several conditions are true at once for the same person, and
 * which one is written to the enrollment is what a recruiter reads months later
 * when they ask why a campaign went quiet.
 */

import {
  EMAIL_SEQUENCE_ENROLLMENT_STATUSES,
  type EmailSequenceEnrollmentStatus,
} from "../../../../db/schema";

/**
 * Re-exported from the schema rather than restated.
 *
 * The column is `text`, so extending the vocabulary needs no migration — which
 * is exactly why it needs one owner. `HELD_NO_CONSENT` was once added to the
 * schema's union while `email-sequences-schema.ts` still narrowed to four
 * values, and every sequence with one held enrollment threw on parse and took
 * the whole screen with it. A second list here would be the same defect with
 * one more place to forget.
 */
export const ENROLLMENT_STATUSES = EMAIL_SEQUENCE_ENROLLMENT_STATUSES;

export type EnrollmentStatus = EmailSequenceEnrollmentStatus;

/** A status a worker will never pick up again. */
export const TERMINAL_STATUSES: readonly EnrollmentStatus[] = ENROLLMENT_STATUSES.filter(
  (status) => status !== "ACTIVE",
);

export interface EnrollmentFacts {
  /**
   * True when this address is on the email suppression list.
   *
   * Deliberately a boolean rather than a cause. `findSuppressed` answers "must
   * not be sent to" and nothing finer, and the list holds opt-outs, spam
   * complaints, hard bounces and manual blocks side by side. Writing
   * `UNSUBSCRIBED` on the strength of it would be a specific claim about a
   * candidate's intent that this query never established — so the status says
   * what is actually known and no more.
   */
  suppressed: boolean;
  /**
   * True when some application of theirs carries a `consent_at`.
   *
   * A candidate a recruiter sourced or typed in has no application and so no
   * consent, and is held rather than mailed. The consent captured by the
   * sourcing extension is consent to *record* what was on a public profile; it
   * is not agreement to receive a campaign, and conflating the two is how an
   * ATS starts sending unsolicited mail with a consent record to point at.
   */
  hasConsent: boolean;
  /** When they applied to anything after this enrollment began, if they did. */
  appliedAfterEnrolmentAt: Date | null;
  /** When they last wrote in after this enrollment began, if they did. */
  repliedAfterEnrolmentAt: Date | null;
  /** `candidates.status` — HIRED and REJECTED both end the conversation. */
  candidateStatus: string | null;
}

export type StopDecision =
  | { stop: true; status: EnrollmentStatus; reason: string }
  | { stop: false };

const CLOSED_CANDIDATE_STATUSES = new Set(["HIRED", "REJECTED"]);

export function decideStop(facts: EnrollmentFacts): StopDecision {
  /*
    Suppression first. Whatever put the address on that list — an opt-out, a
    complaint, a bounce — it is the one instruction that came from outside this
    system, and it outranks every inference we draw about the candidate.
    Recording a different reason on a row whose real cause was an opt-out would
    make the opt-out invisible to anyone auditing why sending stopped.
  */
  if (facts.suppressed) {
    return {
      stop: true,
      status: "STOPPED_SUPPRESSED",
      reason: "This address is on the suppression list and must not be mailed.",
    };
  }

  /*
    Consent before any outcome, because it gates the send itself. A held
    enrollment is not a failed campaign — it is one that was never lawful to
    run for this person, and the distinction is the difference between a
    recruiter fixing their copy and a recruiter collecting consent.
  */
  if (!facts.hasConsent) {
    return {
      stop: true,
      status: "HELD_NO_CONSENT",
      reason: "No application of theirs carries consent to be contacted.",
    };
  }

  /*
    Applied before replied. Both are true for most people who apply — applying
    generally involves writing to somebody — and "they applied" is the fact
    worth keeping: it is the outcome the campaign existed to produce, while
    "they replied" only says a human should take over.
  */
  if (facts.appliedAfterEnrolmentAt) {
    return {
      stop: true,
      status: "STOPPED_APPLIED",
      reason: "Candidate applied after being enrolled.",
    };
  }

  if (facts.repliedAfterEnrolmentAt) {
    return {
      stop: true,
      status: "STOPPED_REPLIED",
      reason: "Candidate replied; a person should take it from here.",
    };
  }

  if (facts.candidateStatus && CLOSED_CANDIDATE_STATUSES.has(facts.candidateStatus)) {
    return {
      stop: true,
      status: "STOPPED_CLOSED",
      reason: `Candidate is ${facts.candidateStatus.toLowerCase()}.`,
    };
  }

  return { stop: false };
}

/**
 * Whether a stopped enrollment counts as the campaign having worked.
 *
 * Only an application does. A reply is engagement and a hire is an outcome that
 * the pipeline, not the campaign, delivered — counting either as a conversion
 * would let a campaign take credit for work done after somebody answered it.
 */
export function isConversion(status: EnrollmentStatus): boolean {
  return status === "STOPPED_APPLIED";
}
