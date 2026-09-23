import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  candidateApplications,
  candidates,
  jobPostings,
  jobRequisitions,
} from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { nextAggregateVersions } from "../../../common/outbox/aggregate-version";
import { legalPathBetween, type CandidateStage } from "./recruitment-candidate-stages";

/**
 * Everything an accepted offer closes, in the transaction that commits the
 * acceptance.
 *
 * Before this, accepting an offer changed one column. The candidate stayed at
 * whatever stage the board last saw, the application the candidate can read on
 * `/application-status/:token` stayed `APPLIED`, the job kept advertising an
 * opening that was gone, the requisition stayed `APPROVED` for a seat that was
 * filled, and no `candidate.hired` reached a webhook subscriber. Those are not
 * five features; they are one fact — the seat is taken — recorded in five
 * places, so they commit together.
 *
 * The person, the employment and onboarding are NOT here. Those need their own
 * transactions after this one commits (backend CLAUDE.md §4) and are driven by
 * `RecruitmentOfferAcceptanceService`.
 */

export interface AcceptedOffer {
  readonly id: number;
  readonly candidateId: number;
  readonly jobPostingId: number | null;
}

export interface HireCompletion {
  /** True when the candidate was already `HIRED`; nothing was written. */
  readonly alreadyHired: boolean;
  readonly candidateId: number;
  readonly jobPostingId: number | null;
  readonly stagesWalked: CandidateStage[];
  readonly applicationId: number | null;
  readonly openingsRemaining: number | null;
  readonly jobFilled: boolean;
  readonly requisitionsFilled: number;
}

async function walkCandidateToHired(
  tx: Db,
  orgId: string,
  candidateId: number,
  from: CandidateStage,
): Promise<CandidateStage[]> {
  const path = legalPathBetween(from, "HIRED");
  if (path === null || path.length === 0) return [];
  /**
   * Written as one UPDATE to the final stage after checking the route exists,
   * not one UPDATE per hop: the intermediate stages are not states the
   * candidate was ever in, and writing them would put four rows through the SLA
   * tracker and four `candidate.stage_changed` automations for a single hire.
   * The path is still computed, because the point is to refuse a hire the map
   * has no route for — not to pretend the candidate passed a screen.
   */
  await tx
    .update(candidates)
    .set({ status: "HIRED", updatedAt: new Date() })
    .where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)));
  return path;
}

export async function completeHire(
  tx: Db,
  orgId: string,
  offer: AcceptedOffer,
): Promise<HireCompletion> {
  const candidate = await tx.query.candidates.findFirst({
    where: and(eq(candidates.id, offer.candidateId), eq(candidates.orgId, orgId)),
    columns: { id: true, status: true },
  });

  const empty: HireCompletion = {
    alreadyHired: true,
    candidateId: offer.candidateId,
    jobPostingId: offer.jobPostingId,
    stagesWalked: [],
    applicationId: null,
    openingsRemaining: null,
    jobFilled: false,
    requisitionsFilled: 0,
  };
  if (!candidate) return empty;

  /**
   * The idempotency guard for everything below. A candidate already `HIRED` has
   * already consumed an opening, so a replayed acceptance must not consume a
   * second one.
   */
  if (candidate.status === "HIRED") return empty;

  const stagesWalked = await walkCandidateToHired(
    tx,
    orgId,
    offer.candidateId,
    candidate.status as CandidateStage,
  );

  const application = await tx.query.candidateApplications.findFirst({
    where: offer.jobPostingId
      ? and(
          eq(candidateApplications.orgId, orgId),
          eq(candidateApplications.candidateId, offer.candidateId),
          eq(candidateApplications.jobPostingId, offer.jobPostingId),
        )
      : and(
          eq(candidateApplications.orgId, orgId),
          eq(candidateApplications.candidateId, offer.candidateId),
        ),
    columns: { id: true, jobPostingId: true },
    orderBy: (t, { desc }) => [desc(t.appliedAt)],
  });

  if (application)
    await tx
      .update(candidateApplications)
      .set({ status: "ACCEPTED", updatedAt: new Date() })
      .where(
        and(eq(candidateApplications.id, application.id), eq(candidateApplications.orgId, orgId)),
      );

  const jobPostingId = offer.jobPostingId ?? application?.jobPostingId ?? null;
  let openingsRemaining: number | null = null;
  let jobFilled = false;
  let requisitionsFilled = 0;

  if (jobPostingId !== null) {
    /**
     * `GREATEST(openings - 1, 0)` rather than a read-then-write: the decrement
     * is the whole reason two accepts must not both run, and computing it in
     * SQL keeps it correct under the row lock this UPDATE already takes. It
     * never goes below zero, so an over-hired job reports a filled seat rather
     * than a negative one.
     */
    const [updatedJob] = await tx
      .update(jobPostings)
      .set({
        openings: sql`GREATEST(${jobPostings.openings} - 1, 0)`,
        updatedAt: new Date(),
      })
      .where(and(eq(jobPostings.id, jobPostingId), eq(jobPostings.orgId, orgId)))
      .returning({ openings: jobPostings.openings, status: jobPostings.status });

    if (updatedJob) {
      openingsRemaining = updatedJob.openings;
      if (updatedJob.openings === 0 && updatedJob.status !== "CLOSED") {
        await tx
          .update(jobPostings)
          .set({ status: "FILLED", updatedAt: new Date() })
          .where(and(eq(jobPostings.id, jobPostingId), eq(jobPostings.orgId, orgId)));
        jobFilled = true;
      }
    }

    if (jobFilled) {
      /**
       * Only once the last opening is gone. A requisition for three seats is
       * not filled by the first hire, and marking it so would leave the
       * recruiter unable to explain why the job is still open.
       */
      const filled = await tx
        .update(jobRequisitions)
        .set({ status: "FILLED", updatedAt: new Date() })
        .where(
          and(
            eq(jobRequisitions.orgId, orgId),
            eq(jobRequisitions.linkedJobId, jobPostingId),
            eq(jobRequisitions.status, "APPROVED"),
          ),
        )
        .returning({ id: jobRequisitions.id });
      requisitionsFilled = filled.length;
    }
  }

  const occurredAt = new Date();
  const aggregate = {
    organizationId: orgId,
    aggregateType: "candidate",
    aggregateId: String(offer.candidateId),
  };
  const [hiredVersion, handoffVersion] = await nextAggregateVersions(tx, aggregate, 2);
  const payload = { candidateId: offer.candidateId, jobPostingId, offerId: offer.id };
  await OutboxWriter.emitMany(tx, [
    {
      eventId: randomUUID(),
      ...aggregate,
      aggregateVersion: hiredVersion ?? 1,
      eventType: "candidate.hired",
      payload,
      occurredAt,
    },
    {
      eventId: randomUUID(),
      ...aggregate,
      aggregateVersion: handoffVersion ?? 2,
      eventType: "hire.handoff",
      payload,
      occurredAt,
    },
  ]);

  return {
    alreadyHired: false,
    candidateId: offer.candidateId,
    jobPostingId,
    stagesWalked,
    applicationId: application?.id ?? null,
    openingsRemaining,
    jobFilled,
    requisitionsFilled,
  };
}
