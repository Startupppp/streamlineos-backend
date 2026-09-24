/**
 * Which openings an employee may apply to, given the grade they are on and the
 * grade the opening is posted at.
 *
 * Pure and separate from eligibility because it answers a different question:
 * eligibility is about the person, and this is about the distance between two
 * rungs. Both refuse, and an applicant who is told "you are not eligible" when
 * the real answer is "that role is three grades up" learns the wrong thing.
 */

export interface GradePolicy {
  /** How many grades above their own an employee may apply to. */
  maxStepsUp: number;
  /** Whether an employee may apply to a role below their current grade. */
  allowStepDown: boolean;
}

export const DEFAULT_GRADE_POLICY: GradePolicy = {
  /*
    One rung. Two is a promotion the hiring team is not qualified to make on
    an application form, and nothing below a named constant explains why the
    number is what it is.
  */
  maxStepsUp: 1,
  /*
    A step down is allowed. People move sideways and downwards on purpose —
    into a different function, out of management, back to delivery — and a
    rule that refuses it would be a rule against the main reason internal
    mobility exists.
  */
  allowStepDown: true,
};

export type GradeMoveKind = "lateral" | "step-up" | "step-down" | "leap" | "ungraded";

export type GradeDecision =
  | { allowed: true; kind: GradeMoveKind }
  | { allowed: false; kind: GradeMoveKind; reason: string };

/**
 * Decides on ranks, never on level names.
 *
 * `hr_job_levels.rank` is the org's own ordering; the names ("L4", "Senior
 * Manager", "Band C") are theirs to choose and carry no order at all. Sorting
 * on a name is how "L10" ends up below "L9".
 *
 * A null on either side is `ungraded` and **allows**. Most openings will never
 * carry a level, and refusing every one of them would make the feature a wall
 * rather than a rule — the org that wants the rule enforced is the org that
 * grades its jobs.
 */
export function decideGradeMove(
  currentRank: number | null,
  targetRank: number | null,
  policy: GradePolicy = DEFAULT_GRADE_POLICY,
): GradeDecision {
  if (currentRank === null || targetRank === null) {
    return { allowed: true, kind: "ungraded" };
  }

  const steps = targetRank - currentRank;

  if (steps === 0) return { allowed: true, kind: "lateral" };

  if (steps < 0) {
    if (policy.allowStepDown) return { allowed: true, kind: "step-down" };
    return {
      allowed: false,
      kind: "step-down",
      reason: "This role is below your current grade, and this organisation does not accept downward internal applications.",
    };
  }

  if (steps <= policy.maxStepsUp) return { allowed: true, kind: "step-up" };

  return {
    allowed: false,
    kind: "leap",
    /*
      Says the distance, not just "no". An applicant who is told the number can
      tell whether they misread the posting or whether the answer is "not this
      year", and the second one is a conversation with their manager rather
      than a support ticket about a broken button.
    */
    reason: `This role is ${steps} grades above yours. Internal applications may go up ${policy.maxStepsUp === 1 ? "one grade" : `${policy.maxStepsUp} grades`} at most — talk to HR about a larger move.`,
  };
}

/**
 * Whether the applicant's own manager has to sign off before this application
 * may advance.
 *
 * A step down or a lateral still needs it: the manager is losing somebody
 * either way, and "did the grade go up" is not what the approval is about.
 * `ungraded` needs it too — an unknown distance is not a small one.
 *
 * The one exemption is having no manager to ask. An org with no head on the
 * applicant's department would otherwise produce an application that can never
 * advance, and a queue nobody owns is indistinguishable from a bug.
 */
export function approvalRequired(managerMembershipId: number | null): "PENDING" | "NOT_REQUIRED" {
  return managerMembershipId === null ? "NOT_REQUIRED" : "PENDING";
}
