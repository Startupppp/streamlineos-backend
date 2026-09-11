/**
 * Moving one enrolment along: claiming its next step and composing it, or
 * ending it.
 *
 * Both are conditional writes on the enrolment still being live. Neither
 * decides whether it is time — the cadence, the wait and the per-tick send cap
 * are all answered in `NurtureStepSenderService.runDueStepsForOrg` before
 * anything here runs — and the only way a step reaches a customer is
 * `OutboundService.composeAndHold`, which holds every message it drafts.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.types";
import { crmNurtureEnrollments, crmNurtureStepAttempts } from "../../../../db/schema";
import type { NurtureCandidate, NurtureStepDeps } from "../nurture-step-sender.types";

/**
 * Claim the step, compose, record what came of it.
 *
 * The claim is a conditional advance of `current_step`, and it happens BEFORE
 * the provider call rather than after. That ordering is the whole safety
 * argument: two ticks overlapping — a slow sweep and the next one, or two
 * workers — resolve to one winner at the database, and the loser does not
 * draft. Written the other way round, both would compose, both would pay, and
 * both would hold a differently worded message to the same customer.
 *
 * A crash between the claim and the attempt row therefore loses a step rather
 * than repeating one, and the same is true of a compose that throws: the claim
 * is not rolled back. `composeAndHold` commits its hold in its own
 * transaction, so a throw is not proof no message is waiting, and between
 * skipping a follow-up and sending a second one to somebody who may already
 * have the first, only the second is unrecallable.
 */
export async function attemptNurtureStep(
  deps: NurtureStepDeps,
  organizationId: string,
  candidate: NurtureCandidate,
  stepNumber: number,
): Promise<"held" | "refused" | "failed" | "lost"> {
  const [claimed] = await deps.db
    .update(crmNurtureEnrollments)
    .set({ currentStep: stepNumber })
    .where(
      and(
        eq(crmNurtureEnrollments.organizationId, organizationId),
        eq(crmNurtureEnrollments.nurtureEnrollmentId, candidate.nurtureEnrollmentId),
        eq(crmNurtureEnrollments.status, "active"),
        eq(crmNurtureEnrollments.currentStep, stepNumber - 1),
      ),
    )
    .returning({ id: crmNurtureEnrollments.nurtureEnrollmentId });

  if (!claimed) return "lost";

  let outcome: "held" | "refused";
  let reason: string | null = null;
  let outboundMessageId: string | null = null;
  let autonomyHoldId: string | null = null;

  try {
    const composed = await deps.outbound.composeAndHold({
      organizationId,
      partyId: candidate.partyId,
      // `deal_id` is an integer column against `deals.id`; `composeAndHold`
      // takes the identifier as a string, as every other caller passes it.
      dealId: candidate.dealId === null ? null : String(candidate.dealId),
    });

    if (composed.held) {
      outcome = "held";
      outboundMessageId = composed.outboundMessageId;
      autonomyHoldId = composed.autonomyHoldId;
    } else {
      outcome = "refused";
      reason = composed.reason;
    }
  } catch (error) {
    deps.logger.error(
      `step ${stepNumber} of enrolment ${candidate.nurtureEnrollmentId} could not be composed: ` +
        (error instanceof Error ? error.message : String(error)),
    );
    return "failed";
  }

  /**
   * `onConflictDoNothing` against `uniq_crm_nurture_step_attempts_step`.
   *
   * The claim already made a second attempt at this step impossible, so a
   * conflict here means a row this sweep cannot explain — and the useful
   * response is to leave the existing record alone rather than to fail the
   * tick over bookkeeping for a message that has already been held.
   */
  await deps.db
    .insert(crmNurtureStepAttempts)
    .values({
      organizationId,
      nurtureEnrollmentId: candidate.nurtureEnrollmentId,
      stepNumber,
      outcome,
      reason,
      outboundMessageId,
      autonomyHoldId,
    })
    .onConflictDoNothing();

  return outcome;
}

/**
 * End an enrolment, conditionally on it still being live.
 *
 * `WHERE status = 'active'` for the reason `SequenceReplyExitService` gives
 * for the same predicate: a reply landing in the same second must win, and an
 * unconditional write would replace `replied` with `sequence-paused` — burying
 * the one outcome the feature is judged on under the one that merely happened
 * to be checked second.
 */
export async function stopNurtureEnrolment(
  db: Db,
  organizationId: string,
  candidate: NurtureCandidate,
  status: "exited" | "completed",
  exitReason: string | null,
): Promise<boolean> {
  const [stopped] = await db
    .update(crmNurtureEnrollments)
    .set({ status, exitReason, exitedAt: new Date() })
    .where(
      and(
        eq(crmNurtureEnrollments.organizationId, organizationId),
        eq(crmNurtureEnrollments.nurtureEnrollmentId, candidate.nurtureEnrollmentId),
        eq(crmNurtureEnrollments.status, "active"),
      ),
    )
    .returning({ id: crmNurtureEnrollments.nurtureEnrollmentId });

  return Boolean(stopped);
}
