import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, isNotNull, lte } from "drizzle-orm";
import {
  candidateApplications,
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
 */

const ENROLLMENT_BATCH = 200;

export type SequenceSendOutcome = {
  sent: number;
  completed: number;
  heldWithoutConsent: number;
  skippedInactive: number;
};

interface DueEnrollment {
  id: number;
  sequenceId: number;
  candidateId: number;
  currentStep: number;
}

@Injectable()
export class CronRecruitmentSequencesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
  ) {}

  async sendDueSequenceSteps(): Promise<SequenceSendOutcome> {
    const outcome: SequenceSendOutcome = {
      sent: 0,
      completed: 0,
      heldWithoutConsent: 0,
      skippedInactive: 0,
    };
    const now = new Date();

    await forEachOrg(this.db, "recruitment-sequence-steps", async (tx, orgId) => {
      const due: DueEnrollment[] = await tx
        .select({
          id: emailSequenceEnrollments.id,
          sequenceId: emailSequenceEnrollments.sequenceId,
          candidateId: emailSequenceEnrollments.candidateId,
          currentStep: emailSequenceEnrollments.currentStep,
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
      columns: { email: true, firstName: true, lastName: true },
    });

    /**
     * The consent gate. `HELD_NO_CONSENT` is a stored reason a recruiter can
     * read on the enrollment, and it clears `next_send_at`, so the worker does
     * not keep picking the row up and re-deciding it every tick.
     */
    const consented = candidate?.email ? await this.hasConsent(tx, orgId, enrollment.candidateId) : false;
    if (!consented) {
      await tx
        .update(emailSequenceEnrollments)
        .set({ status: "HELD_NO_CONSENT", nextSendAt: null })
        .where(
          and(
            eq(emailSequenceEnrollments.id, enrollment.id),
            eq(emailSequenceEnrollments.orgId, orgId),
          ),
        );
      outcome.heldWithoutConsent += 1;
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
}
