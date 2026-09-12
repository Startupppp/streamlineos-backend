export interface NurtureSequenceSummary {
  readonly nurtureSequenceId: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: string;
  readonly stepCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NurtureStepView {
  readonly nurtureStepId: string;
  readonly stepNumber: number;
  /** As stored. `clampWaitHours` is what the sender actually waits — see below. */
  readonly waitHours: number;
}

export interface NurtureEnrollmentView {
  readonly nurtureEnrollmentId: string;
  readonly nurtureSequenceId: string;
  readonly partyId: string;
  /**
   * Resolved here rather than left to the caller.
   *
   * A screen may not render a raw id, so returning `partyId` alone forces every
   * caller to go and find the name — which is one request per row, or a
   * first-page lookup that silently degrades to "a customer you can't see" for
   * anybody further down the list. `partyNamesFor` answers the whole page in one
   * indexed query, which is what `autonomy-review.service.ts` already does for
   * the decision feed. Null only when the party is gone.
   */
  readonly partyName: string | null;
  readonly dealId: number | null;
  readonly dealName: string | null;
  readonly status: string;
  readonly currentStep: number;
  readonly exitReason: string | null;
  readonly exitedAt: Date | null;
  readonly enrolledAt: Date;
}
