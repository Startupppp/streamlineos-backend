import type { Logger } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.types";
import type { OutboundService } from "../outbound.service";

export interface NurtureSweepOutcome {
  /** Live enrolments looked at, whether or not anything was due. */
  considered: number;
  /** In cadence and not yet due. The steady state, and the number that should dominate. */
  waiting: number;
  /**
   * Due, but over this tick's send cap. Counted separately from `waiting`
   * because a number that stays above zero means the cap is now the thing
   * setting the cadence, and calling that "waiting" would hide it.
   */
  deferred: number;
  held: number;
  refused: number;
  exited: number;
  completed: number;
  /** A due step whose compose threw. Skipped, never retried — see `attemptNurtureStep`. */
  failed: number;
}

/** A live enrolment as one sweep tick sees it, with the state of the sequence behind it. */
export interface NurtureCandidate {
  readonly nurtureEnrollmentId: string;
  readonly nurtureSequenceId: string;
  readonly partyId: string;
  readonly dealId: number | null;
  readonly currentStep: number;
  readonly enrolledAt: Date;
  readonly updatedAt: Date;
  readonly sequenceStatus: string;
  readonly sequenceDeletedAt: Date | null;
}

/**
 * What `NurtureStepSenderService` hands its libs in place of `this`.
 *
 * `db` is the ambient tenant transaction — a request's, or the one `forEachOrg`
 * opens — exactly as `this.db` is, so a step's claim and its attempt row land
 * where they did as methods. `logger` keeps the `NurtureSender` context.
 */
export interface NurtureStepDeps {
  readonly db: Db;
  readonly outbound: OutboundService;
  readonly logger: Logger;
}
