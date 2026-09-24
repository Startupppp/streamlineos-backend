/**
 * The background-verification state machine, and the rule that a verdict has to
 * say who reached it.
 *
 * Pure, because the invariant this file exists to hold is a claim about
 * evidence rather than about storage: nothing may record `CLEARED` on an
 * agency's behalf unless an agency actually said so. That rule is easy to state
 * and easy to lose in a service that also opens transactions and calls vendors,
 * so it lives here with a test around it.
 */

export const BGV_STATUSES = [
  "NOT_INITIATED",
  "INITIATED",
  "PENDING",
  "CLEARED",
  "FAILED",
] as const;

export type BgvStatus = (typeof BGV_STATUSES)[number];

/** Who is asserting the status. */
export const BGV_SOURCES = ["MANUAL", "AGENCY"] as const;
export type BgvSource = (typeof BGV_SOURCES)[number];

/** Statuses that mean the check is finished, one way or the other. */
export const TERMINAL_BGV_STATUSES: readonly BgvStatus[] = ["CLEARED", "FAILED"];

/**
 * What each status may become.
 *
 * A finished check can be re-opened — an agency re-runs a report, a recruiter
 * discovers the wrong person was checked — so `CLEARED` and `FAILED` both lead
 * back to `INITIATED`. What they may not do is move sideways into each other
 * without passing through a fresh check, because "we changed our mind about the
 * verdict" and "we ran it again and got a different answer" are different
 * events and only the second is defensible.
 */
const TRANSITIONS: Record<BgvStatus, readonly BgvStatus[]> = {
  NOT_INITIATED: ["INITIATED"],
  INITIATED: ["PENDING", "CLEARED", "FAILED", "NOT_INITIATED"],
  PENDING: ["CLEARED", "FAILED", "NOT_INITIATED"],
  CLEARED: ["INITIATED", "NOT_INITIATED"],
  FAILED: ["INITIATED", "NOT_INITIATED"],
};

export function canTransition(from: BgvStatus, to: BgvStatus): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

export interface VerdictClaim {
  from: BgvStatus;
  to: BgvStatus;
  source: BgvSource;
  /** The agency's case id. Required for an agency verdict. */
  reference: string | null;
}

export type VerdictRefusal = { ok: false; reason: string };
export type VerdictAccepted = { ok: true };
export type VerdictDecision = VerdictAccepted | VerdictRefusal;

/**
 * Whether a status change may be recorded.
 *
 * The asymmetry between the two sources is the whole point. A recruiter who ran
 * a check by hand may record any outcome — that is the manual fallback the
 * whole product leans on, and refusing it would just push the answer into a
 * free-text note. But the row then says `MANUAL`, and nothing downstream may
 * read it as an agency clearance.
 *
 * An agency verdict has the opposite constraint: it may only arrive with a
 * reference to the report it came from. A `CLEARED` with no case id is
 * indistinguishable from a forged one, and the offer policy that trusts agency
 * verdicts is the reason somebody would forge it.
 */
export function decideVerdict(claim: VerdictClaim): VerdictDecision {
  if (!canTransition(claim.from, claim.to)) {
    return {
      ok: false,
      reason: `A background check cannot go from ${claim.from} to ${claim.to}. Re-open it first.`,
    };
  }

  if (claim.source === "AGENCY" && !claim.reference) {
    return {
      ok: false,
      reason: "An agency verdict must carry the agency's case reference.",
    };
  }

  return { ok: true };
}

/**
 * Whether this verdict satisfies a policy that requires an agency check.
 *
 * Deliberately not "is the status CLEARED". A recruiter recording CLEARED after
 * calling two referees is a real and useful thing to do, and it is also not an
 * agency verification — the distinction only exists if something reads it.
 */
export function isAgencyClearance(status: BgvStatus, source: BgvSource | null): boolean {
  return status === "CLEARED" && source === "AGENCY";
}

/**
 * What a candidate's BGV state means in words, for a recruiter reading it.
 *
 * The `CLEARED` line names its source. "Cleared" alone, on a screen, is
 * precisely the claim this module exists to stop being made on an agency's
 * behalf by somebody who ticked a box.
 */
export function describeBgv(status: BgvStatus, source: BgvSource | null): string {
  switch (status) {
    case "NOT_INITIATED":
      return "Not started.";
    case "INITIATED":
      return source === "AGENCY" ? "Sent to the agency." : "Marked as started.";
    case "PENDING":
      return source === "AGENCY" ? "The agency is still checking." : "In progress.";
    case "CLEARED":
      return source === "AGENCY"
        ? "Cleared by the verification agency."
        : "Recorded as cleared by a recruiter — no agency verified this.";
    case "FAILED":
      return source === "AGENCY" ? "The agency reported a problem." : "Recorded as failed.";
  }
}
