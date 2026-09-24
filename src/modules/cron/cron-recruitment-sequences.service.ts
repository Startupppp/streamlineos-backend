import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gt, isNotNull, lte } from "drizzle-orm";
import {
  candidateApplications,
  candidateMessages,
  candidates,
  emailSequenceEnrollments,
  emailSequenceSteps,
  emailSequences,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { TenantTx } from "../../common/tenant/with-tenant";
import { forEachOrg } from "../../common/tenant";
import { logger } from "../../common/logger/logger.service";
import { EmailService } from "../email/email.service";
import { EmailSuppressionService } from "../email/email-suppression.service";
import {
  decideStop,
  type EnrollmentFacts,
  type EnrollmentStatus,
} from "../hr/recruitment/nurture/nurture-stop-conditions";

/**
 * The sender for candidate email sequences.
 *
 * `POST /email-sequences/:id/enroll` wrote an `ACTIVE` enrollment with a
 * `next_send_at`, and nothing ever read that column. The screen said a drip was
 * running; no step was ever delivered. This is the worker that makes the
 * enrollment mean something — and the consent check that decides, at send time,
 * whether it may.
 *
 * Consent is re-checked per step rather than once at enrollment, because
 * withdrawal has to stop a sequence that is already running. It is read from
 * `candidate_applications.consent_at`, the field the public apply stamps: a
 * candidate a recruiter typed in by hand has no application and therefore no
 * consent, and is held rather than mailed.
 *
 * EMAIL only. `email_sequence_steps` carries a subject and an HTML body and no
 * channel column, so there is no WhatsApp step to send and no opt-in to check
 * for one. WhatsApp is ATS-W1-012 and is not built.
 *
 * Every stop condition is decided by `decideStop`, not here, so the precedence
 * between them is pinned by a test rather than by the order these branches
 * happen to sit in. What this file owns is gathering the facts that decision
 * needs — one read each, on the row that is about to be mailed.
 */

const ENROLLMENT_BATCH = 200;

export type SequenceSendOutcome = {
  sent: number;
  completed: number;
  heldWithoutConsent: number;
  skippedInactive: number;
  /** Enrollments closed by a stop condition this tick, keyed by the status written. */
  stopped: Partial<Record<EnrollmentStatus, number>>;
};

interface DueEnrollment {
  id: number;
  sequenceId: number;
  candidateId: number;
  currentStep: number;
  enrolledAt: Date;
}

@Injectable()
export class CronRecruitmentSequencesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
    private readonly suppression: EmailSuppressionService,
  ) {}

  async sendDueSequenceSteps(): Promise<SequenceSendOutcome> {
    const outcome: SequenceSendOutcome = {
      sent: 0,
      completed: 0,
      heldWithoutConsent: 0,
      skippedInactive: 0,
      stopped: {},
    };
    const now = new Date();

    await forEachOrg(this.db, "recruitment-sequence-steps", async (tx, orgId) => {
      const due: DueEnrollment[] = await tx
        .select({
          id: emailSequenceEnrollments.id,
          sequenceId: emailSequenceEnrollments.sequenceId,
          candidateId: emailSequenceEnrollments.candidateId,
          currentStep: emailSequenceEnrollments.currentStep,
          enrolledAt: emailSequenceEnrollments.enrolledAt,
        })
        .from(emailSequenceEnrollments)
        .where(
          and(
            eq(emailSequenceEnrollments.orgId, orgId),
            eq(emailSequenceEnrollments.status, "ACTIVE"),
            isNotNull(emailSequenceEnrollments.nextSendAt),
            lte(emailSequenceEnrollments.nextSendAt, now),
          ),
        )
        .orderBy(asc(emailSequenceEnrollments.nextSendAt))
        .limit(ENROLLMENT_BATCH);

      for (const enrollment of due)
        await this.advanceOne(tx, orgId, enrollment, now, outcome);
    });

    return outcome;
  }

  private async advanceOne(
    tx: TenantTx,
    orgId: string,
    enrollment: DueEnrollment,
    now: Date,
    outcome: SequenceSendOutcome,
  ): Promise<void> {
    const sequence = await tx.query.emailSequences.findFirst({
      where: and(eq(emailSequences.id, enrollment.sequenceId), eq(emailSequences.orgId, orgId)),
      columns: { isActive: true, name: true },
    });
    if (!sequence?.isActive) {
      outcome.skippedInactive += 1;
      return;
    }

    const candidate = await tx.query.candidates.findFirst({
      where: and(eq(candidates.id, enrollment.candidateId), eq(candidates.orgId, orgId)),
      columns: { email: true, firstName: true, lastName: true, status: true },
    });

    /*
      Every stop condition, decided together.

      They are gathered before the step is read rather than after, because a
      campaign that has already done its job should cost one decision and no
      send — and because a stopped enrollment clears `next_send_at`, so the
      worker does not pick the row up and re-decide it on every tick for the
      rest of its life.
    */
    const facts = await this.gatherFacts(tx, orgId, enrollment, candidate?.email ?? null);
    const decision = decideStop(facts);
    if (decision.stop) {
      await tx
        .update(emailSequenceEnrollments)
        .set({ status: decision.status, nextSendAt: null })
        .where(
          and(
            eq(emailSequenceEnrollments.id, enrollment.id),
            eq(emailSequenceEnrollments.orgId, orgId),
          ),
        );
      outcome.stopped[decision.status] = (outcome.stopped[decision.status] ?? 0) + 1;
      /*
        `heldWithoutConsent` predates `stopped` and the cron controller still
        reports it, so it stays a first-class counter rather than becoming one
        key among eight. Removing it would silently blank a number an operator
        already watches.
      */
      if (decision.status === "HELD_NO_CONSENT") outcome.heldWithoutConsent += 1;
      return;
    }

    const steps = await tx
      .select({
        stepOrder: emailSequenceSteps.stepOrder,
        subject: emailSequenceSteps.subject,
        htmlBody: emailSequenceSteps.htmlBody,
        delayDays: emailSequenceSteps.delayDays,
      })
      .from(emailSequenceSteps)
      .where(
        and(
          eq(emailSequenceSteps.orgId, orgId),
          eq(emailSequenceSteps.sequenceId, enrollment.sequenceId),
        ),
      )
      .orderBy(asc(emailSequenceSteps.stepOrder))
      .limit(100);

    const next = steps[enrollment.currentStep];
    if (!next) {
      await tx
        .update(emailSequenceEnrollments)
        .set({ status: "COMPLETED", completedAt: now, nextSendAt: null })
        .where(
          and(
            eq(emailSequenceEnrollments.id, enrollment.id),
            eq(emailSequenceEnrollments.orgId, orgId),
          ),
        );
      outcome.completed += 1;
      return;
    }

    try {
      await this.email.sendEmail({
        to: candidate?.email ?? "",
        subject: next.subject,
        html: next.htmlBody,
      });
    } catch (error) {
      /**
       * A send that failed leaves the enrollment exactly where it was, so the
       * next tick retries this step. Advancing on failure would silently skip
       * a message the recruiter believes went out.
       */
      logger.error("[recruitment-sequences] step send failed; enrollment left for retry", {
        orgId,
        enrollmentId: enrollment.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    /*
      The sent step becomes a candidate message.

      Without this there is no record that a campaign ever contacted anybody:
      `sent` was a counter in a cron return value that nothing persisted, so
      "how many did this campaign send" had no answer and "did they reply" had
      nothing to compare a reply against. It is a real outbound message to the
      candidate, so `candidate_messages` is where it belongs — and it is what
      makes the reply detection above work at all.

      Failing to record it must not un-send the mail, which has already left. So
      this is deliberately not fatal: the step still advances and the failure is
      logged rather than retried, because a retry would send the mail twice.
    */
    try {
      await tx.insert(candidateMessages).values({
        orgId,
        candidateId: enrollment.candidateId,
        direction: "OUTBOUND",
        channel: "EMAIL",
        subject: next.subject,
        body: next.htmlBody,
        sentAt: now,
        externalId: `sequence:${enrollment.sequenceId}:step:${next.stepOrder}:enrollment:${enrollment.id}`,
      });
    } catch (error) {
      logger.error("[recruitment-sequences] step sent but not recorded", {
        orgId,
        enrollmentId: enrollment.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const following = steps[enrollment.currentStep + 1];
    const nextSendAt = following
      ? new Date(now.getTime() + following.delayDays * 24 * 60 * 60 * 1000)
      : null;

    await tx
      .update(emailSequenceEnrollments)
      .set({
        currentStep: enrollment.currentStep + 1,
        nextSendAt,
        ...(following ? {} : { status: "COMPLETED" as const, completedAt: now }),
      })
      .where(
        and(
          eq(emailSequenceEnrollments.id, enrollment.id),
          eq(emailSequenceEnrollments.orgId, orgId),
        ),
      );
    outcome.sent += 1;
    if (!following) outcome.completed += 1;
  }

  /**
   * One read per condition, on the enrollment about to be mailed.
   *
   * Gathered rather than short-circuited, so `decideStop` sees the whole
   * picture and the precedence between conditions lives in one tested place. It
   * is four small indexed lookups against a row we are already about to send
   * mail to, which is not where this worker's cost is.
   */
  private async gatherFacts(
    tx: TenantTx,
    orgId: string,
    enrollment: DueEnrollment,
    candidateEmail: string | null,
  ): Promise<EnrollmentFacts> {
    const [hasConsent, appliedAfterEnrolmentAt, repliedAfterEnrolmentAt, suppressed, candidateStatus] =
      await Promise.all([
        this.hasConsent(tx, orgId, enrollment.candidateId),
        this.appliedSince(tx, orgId, enrollment.candidateId, enrollment.enrolledAt),
        this.repliedSince(tx, orgId, enrollment.candidateId, enrollment.enrolledAt),
        this.isSuppressed(candidateEmail, orgId),
        this.candidateStatus(tx, orgId, enrollment.candidateId),
      ]);

    return {
      suppressed,
      hasConsent: candidateEmail ? hasConsent : false,
      appliedAfterEnrolmentAt,
      repliedAfterEnrolmentAt,
      candidateStatus,
    };
  }

  /**
   * Consent is on the application, not the candidate, because that is where the
   * public apply records it. Any application of theirs carrying a `consent_at`
   * is enough — they agreed to be contacted about working here.
   */
  private async hasConsent(tx: TenantTx, orgId: string, candidateId: number): Promise<boolean> {
    const [row] = await tx
      .select({ id: candidateApplications.id })
      .from(candidateApplications)
      .where(
        and(
          eq(candidateApplications.orgId, orgId),
          eq(candidateApplications.candidateId, candidateId),
          isNotNull(candidateApplications.consentAt),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /**
   * An application filed after the enrollment began.
   *
   * "After" is load-bearing. Most nurture targets are past applicants, so an
   * unbounded "have they ever applied" would stop every campaign on its first
   * tick and report the campaign as having converted somebody it never
   * contacted.
   */
  private async appliedSince(
    tx: TenantTx,
    orgId: string,
    candidateId: number,
    since: Date,
  ): Promise<Date | null> {
    const [row] = await tx
      .select({ appliedAt: candidateApplications.appliedAt })
      .from(candidateApplications)
      .where(
        and(
          eq(candidateApplications.orgId, orgId),
          eq(candidateApplications.candidateId, candidateId),
          gt(candidateApplications.appliedAt, since),
        ),
      )
      .orderBy(desc(candidateApplications.appliedAt))
      .limit(1);
    return row?.appliedAt ?? null;
  }

  /**
   * An inbound message since the enrollment began.
   *
   * Inbound only: the outbound rows this worker writes are the campaign talking
   * to itself, and counting one would stop every sequence immediately after its
   * first step.
   */
  private async repliedSince(
    tx: TenantTx,
    orgId: string,
    candidateId: number,
    since: Date,
  ): Promise<Date | null> {
    const [row] = await tx
      .select({ sentAt: candidateMessages.sentAt })
      .from(candidateMessages)
      .where(
        and(
          eq(candidateMessages.orgId, orgId),
          eq(candidateMessages.candidateId, candidateId),
          eq(candidateMessages.direction, "INBOUND"),
          gt(candidateMessages.sentAt, since),
        ),
      )
      .orderBy(desc(candidateMessages.sentAt))
      .limit(1);
    return row?.sentAt ?? null;
  }

  private async candidateStatus(
    tx: TenantTx,
    orgId: string,
    candidateId: number,
  ): Promise<string | null> {
    const row = await tx.query.candidates.findFirst({
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
      columns: { status: true },
    });
    return row?.status ?? null;
  }

  /**
   * Read through `EmailSuppressionService` rather than with a query here, so
   * this worker and `EmailOutboxService` agree about who must not be mailed.
   *
   * Without it the outbox would silently drop each step while the enrollment
   * stayed ACTIVE and rescheduled itself forever — a campaign that reads as
   * running and sends nothing.
   */
  private async isSuppressed(email: string | null, orgId: string): Promise<boolean> {
    if (!email) return false;
    const suppressed = await this.suppression.findSuppressed([email], orgId);
    return suppressed.size > 0;
  }
}
