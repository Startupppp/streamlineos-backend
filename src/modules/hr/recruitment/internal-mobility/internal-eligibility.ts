/**
 * Who may apply for an internal role, and what their current manager gets to
 * see about it.
 *
 * Pure, because both are policy rather than plumbing, and because the second
 * one is the kind of rule that quietly stops holding when somebody widens a
 * query. An internal application that reaches the applicant's own manager
 * before the applicant chose to tell them is how internal mobility stops being
 * used at all.
 */

export interface EmploymentFacts {
  /** `hr_employments.lifecycle_status`. */
  lifecycleStatus: string | null;
  joiningDate: Date | null;
  probationEndDate: Date | null;
  /** True once the employee has started serving notice. */
  onNotice: boolean;
}

export interface EligibilityPolicy {
  /** Months an employee must have completed before applying internally. */
  minimumTenureMonths: number;
  /** Whether somebody still on probation may apply. */
  allowDuringProbation: boolean;
}

export const DEFAULT_ELIGIBILITY: EligibilityPolicy = {
  /*
    Six months, which is the common Indian internal-mobility bar and long
    enough that a role is not a stepping stone out of the one somebody was
    hired into last quarter. It is a named constant rather than a literal
    because the number is a decision, not a fact.
  */
  minimumTenureMonths: 6,
  allowDuringProbation: false,
};

export type Eligibility =
  | { eligible: true }
  | { eligible: false; reason: string };

/**
 * Whether this employee may apply for an internal opening.
 *
 * "No employment record" refuses. The route is reachable by anybody holding a
 * recruitment view permission, which includes external recruiters and agency
 * users on some plans — and "internal" is not a synonym for "logged in".
 */
export function decideEligibility(
  facts: EmploymentFacts,
  now: Date,
  policy: EligibilityPolicy = DEFAULT_ELIGIBILITY,
): Eligibility {
  if (facts.lifecycleStatus === null) {
    return {
      eligible: false,
      reason: "Internal roles are open to employees. No employment record was found for you.",
    };
  }
  if (facts.lifecycleStatus !== "ACTIVE") {
    return {
      eligible: false,
      reason: "Internal roles are open to active employees.",
    };
  }
  /*
    Somebody serving notice is refused even though they are still ACTIVE. An
    internal move is a retention decision, and a resignation already in flight
    is a different conversation that belongs with their manager rather than in
    an application queue.
  */
  if (facts.onNotice) {
    return {
      eligible: false,
      reason: "You are serving notice. Speak to HR about staying rather than applying here.",
    };
  }
  if (!policy.allowDuringProbation && facts.probationEndDate !== null) {
    if (facts.probationEndDate.getTime() > now.getTime()) {
      return { eligible: false, reason: "You are still on probation." };
    }
  }
  if (facts.joiningDate === null) {
    /*
      A missing joining date refuses rather than passing. Tenure cannot be
      computed without it, and treating unknown as "long enough" makes the bar
      optional for exactly the records that are incomplete.
    */
    return {
      eligible: false,
      reason: "Your joining date is not recorded, so tenure cannot be checked. Ask HR to add it.",
    };
  }

  const months = monthsBetween(facts.joiningDate, now);
  if (months < policy.minimumTenureMonths) {
    return {
      eligible: false,
      reason: `Internal roles need ${policy.minimumTenureMonths} months in your current role. You have ${months}.`,
    };
  }

  return { eligible: true };
}

/**
 * Whole months completed, by calendar rather than by dividing days.
 *
 * 30.44-day months put somebody hired on 1 January over a six-month bar a day
 * early or a day late depending on which months fell in between, and an
 * eligibility answer that changes with the length of February is one nobody can
 * explain to the person it refused.
 */
export function monthsBetween(from: Date, to: Date): number {
  let months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

/**
 * The stage at which an internal application becomes visible to the applicant's
 * current manager.
 *
 * Confidential until the candidate reaches interview. Somebody exploring a move
 * has not decided to leave their team, and a manager who learns about it from a
 * dashboard finds out before the person meant to tell them — after which nobody
 * in that organisation applies internally again, which costs far more than the
 * transparency is worth.
 *
 * It becomes visible at interview rather than at offer because by then the
 * applicant is taking time out of their week for it, and the manager arranging
 * around that deserves to know why.
 */
const MANAGER_VISIBLE_FROM: readonly string[] = ["INTERVIEWING", "OFFERED", "ACCEPTED"];

export function managerMaySee(applicationStatus: string): boolean {
  return MANAGER_VISIBLE_FROM.includes(applicationStatus);
}

/**
 * What the applicant is told about that.
 *
 * Said up front on the apply screen rather than buried in a policy document —
 * somebody deciding whether to apply is entitled to know when their manager
 * will find out, and a surprise here is the thing that stops the next person
 * applying.
 */
export const CONFIDENTIALITY_NOTICE =
  "Your application stays between you and the hiring team until you reach the interview stage. After that your current manager can see it.";
