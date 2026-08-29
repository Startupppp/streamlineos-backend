import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import {
  autonomousDecisions,
  autonomyHolds,
  crmNurtureEnrollments,
  crmNurtureStepAttempts,
  crmOutboundMessages,
} from "../../../db/schema";

/**
 * The reply that ends the sequence, applied the moment the reply lands.
 *
 * This is the half of the ticket that cannot be done lazily. The workflow
 * re-reads the enrolment when it wakes and would refuse to send over a reply
 * anyway — `resolveCadence` checks it first — and `evaluateGuardrails` would
 * refuse the individual message a third time with `reply-arrived`. So why do it
 * here as well?
 *
 * Because of the message that is ALREADY WAITING. A step drafted an hour ago is
 * sitting at `held` with a live run counting down its window, and the customer
 * has just replied. Nothing about the next step's wake, days away, touches that
 * hold. The send-time guardrail would catch it — `repliedAt > draftedAt` — and
 * that is a genuine second line of defence rather than a redundancy, but until
 * it fires the review feed shows a message about to go to somebody who has just
 * written in, and the countdown on it is real. Cancelling it here is what makes
 * the product's claim ("a reply exits the sequence immediately") true at the
 * moment a person would go looking to check.
 *
 * ── Where this is called from ─────────────────────────────────────────────────
 *
 * `AutonomyService.processActivity`, which the ingress workflow's
 * `extract-and-act` step calls for every communication it files. That is the
 * inbound seam, reached one level in — and the level matters. `processActivity`
 * runs `classifyDelivery` first, so by the time this is called the message has
 * been judged a genuine delivery rather than a bounce or an out-of-office. A
 * hook placed directly in `inbound-ingress.workflow.ts` would not have that: an
 * Exchange auto-reply would end the sequence, which is the same class of mistake
 * as sending over a person, inverted — the automation stops because a robot
 * answered.
 *
 * It is also why this service holds nothing but a database handle. Injecting it
 * into `AutonomyService` means the module that provides it must be importable by
 * `AutonomyModule`, and anything reaching back for `OutboundService` would close
 * that loop into a cycle Nest refuses at boot.
 */
@Injectable()
export class SequenceReplyExitService {
  private readonly logger = new Logger("NurtureExit");

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * They said something. Stop every sequence aimed at them, and unwind what is
   * already in flight.
   *
   * Never throws outward, and the caller relies on that. It runs inside the
   * ingress workflow's `extract-and-act` step, and a failure here must not
   * dead-letter the delivery of a customer's message — the reply itself is worth
   * more than the bookkeeping about the sequence it interrupted. A failure is
   * loud in the log and self-correcting: the next wake reaches
   * `resolveCadence`, which checks the reply first and exits the enrolment then.
   */
  async onInboundReply(
    organizationId: string,
    partyId: string | null,
    context: { activityId: string },
  ): Promise<{ exited: number; cancelledHolds: number }> {
    if (!partyId) return { exited: 0, cancelledHolds: 0 };

    try {
      return await this.exit(organizationId, partyId, context.activityId);
    } catch (error) {
      this.logger.error(
        `could not exit sequences for party ${partyId} on reply ${context.activityId}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return { exited: 0, cancelledHolds: 0 };
    }
  }

  private async exit(
    organizationId: string,
    partyId: string,
    activityId: string,
  ): Promise<{ exited: number; cancelledHolds: number }> {
    const now = new Date();

    /**
     * The enrolments first, and conditionally on still being active.
     *
     * `WHERE status = 'active'` is not decoration: an operator stopping the
     * enrolment by hand in the same second must resolve one way, and a row
     * overwritten here would replace their `manual-stop` with `replied` and lose
     * the fact that a person intervened.
     */
    const exited = await this.db
      .update(crmNurtureEnrollments)
      .set({ status: "exited", exitReason: "replied", exitedAt: now })
      .where(
        and(
          eq(crmNurtureEnrollments.organizationId, organizationId),
          eq(crmNurtureEnrollments.partyId, partyId),
          eq(crmNurtureEnrollments.status, "active"),
        ),
      )
      .returning({ id: crmNurtureEnrollments.nurtureEnrollmentId });

    if (exited.length === 0) return { exited: 0, cancelledHolds: 0 };

    const enrolmentIds = exited.map((row) => row.id);

    /**
     * The holds those enrolments placed and that have not resolved yet.
     *
     * Read through `crm_nurture_step_attempts` rather than by matching holds on
     * the party, because a hold on that party may have been placed by the
     * one-off compose route or by the quote loop, and this has no mandate over
     * either. A sequence unwinds what a sequence started.
     */
    const attempts = await this.db
      .select({
        holdId: crmNurtureStepAttempts.autonomyHoldId,
        outboundMessageId: crmNurtureStepAttempts.outboundMessageId,
      })
      .from(crmNurtureStepAttempts)
      .where(
        and(
          eq(crmNurtureStepAttempts.organizationId, organizationId),
          inArray(crmNurtureStepAttempts.nurtureEnrollmentId, enrolmentIds),
          isNotNull(crmNurtureStepAttempts.autonomyHoldId),
        ),
      );

    let cancelledHolds = 0;

    for (const attempt of attempts) {
      if (!attempt.holdId) continue;
      const cancelled = await this.cancelHold(
        organizationId,
        attempt.holdId,
        attempt.outboundMessageId,
      );
      if (cancelled) cancelledHolds += 1;
    }

    this.logger.log(
      `reply ${activityId} exited ${exited.length} sequence enrolment(s) for party ${partyId}` +
        (cancelledHolds > 0 ? ` and cancelled ${cancelledHolds} waiting message(s)` : ""),
    );

    return { exited: exited.length, cancelledHolds };
  }

  /**
   * Stop one waiting message in all three places that have to agree.
   *
   * The same three-way update `OutboundWorkflow.stop` performs, and for the same
   * reason: a message left at `held` under a cancelled hold shows in the review
   * feed as still about to send, and a ledger row still saying `held` tells the
   * scoreboard a decision is in flight that nothing will ever resolve.
   *
   * `outcome: 'reversed'` rather than `'skipped'`, and the distinction is
   * deliberate. `outbound.workflow.ts` reserves `reversed` for a decision undone
   * from outside and uses `skipped` when a guardrail declines on its own reading
   * of the world. This is the former: the customer's reply reversed it. Counting
   * it as `skipped` would credit the guardrails with a save they did not make,
   * and the correction rate is the number this feature will be judged by.
   */
  private async cancelHold(
    organizationId: string,
    holdId: string,
    outboundMessageId: string | null,
  ): Promise<boolean> {
    const summary = "They replied, so the rest of the sequence was stopped.";

    const cancelled = await this.db
      .update(autonomyHolds)
      .set({ status: "cancelled", cancelledAt: new Date(), cancelReason: summary })
      .where(
        and(
          eq(autonomyHolds.organizationId, organizationId),
          eq(autonomyHolds.autonomyHoldId, holdId),
          // Only a hold still waiting. One already sent, cancelled or failed has
          // been resolved by somebody with a better claim than this, and moving
          // it back would rewrite what happened.
          eq(autonomyHolds.status, "held"),
        ),
      )
      .returning({ decisionId: autonomyHolds.autonomousDecisionId });

    const row = cancelled[0];
    if (!row) return false;

    if (outboundMessageId) {
      await this.db
        .update(crmOutboundMessages)
        .set({ status: "cancelled", blockedReason: "reply-arrived" })
        .where(
          and(
            eq(crmOutboundMessages.organizationId, organizationId),
            eq(crmOutboundMessages.outboundMessageId, outboundMessageId),
          ),
        );
    }

    await this.db
      .update(autonomousDecisions)
      .set({ outcome: "reversed", reversedAt: new Date(), reversedReason: summary })
      .where(
        and(
          eq(autonomousDecisions.organizationId, organizationId),
          eq(autonomousDecisions.autonomousDecisionId, row.decisionId),
        ),
      );

    return true;
  }
}
