import type { ProbationCoverage } from "../lifecycle/probation-coverage";

export const PROBATION_LEAVE_REFUSAL =
  "This leave type is not available during your probation period. Contact HR if you have questions.";

export type ProbationLeaveDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

export interface ProbationLeaveInput {
  probationRestricted: boolean | null | undefined;
  coverage: ProbationCoverage;
}

/**
 * The four product decisions behind `leave_policies.probation_restricted`:
 * (1) a restricted type still ACCRUES during probation and only becomes unbookable,
 *     because leave is earned from the joining date; (2) `no-record` — probation was
 *     never recorded for this person — ALLOWS, because the flag seeds `true` and
 *     refusing would block every organisation that never used the probation module;
 * (3) there is NO per-request override permission — the administrator's lever is the
 *     policy flag itself, which is durable and auditable; (4) the whole request is
 *     judged on the DATES REQUESTED (its start date), so a window that opens during
 *     probation is refused entirely rather than silently trimmed.
 */
export function decideProbationLeave(input: ProbationLeaveInput): ProbationLeaveDecision {
  if (!input.probationRestricted) return { allowed: true };

  switch (input.coverage) {
    case "on-probation":
      return { allowed: false, reason: PROBATION_LEAVE_REFUSAL };
    case "past-probation":
    case "no-record":
      return { allowed: true };
    default: {
      void (input.coverage satisfies never);
      return { allowed: false, reason: PROBATION_LEAVE_REFUSAL };
    }
  }
}
