import {
  BadRequestException,
  InternalServerErrorException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import {
  candidateApplications,
  candidateDocumentsVault,
  candidates,
  organizationMembers,
  organizations,
} from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import type { PlanLimitsService } from "../billing/core/plan-limits.service";
import { PaymentRequiredException } from "../../common/http/api-exceptions";
import { logger } from "../../common/logger/logger.service";
import { OutboxWriter } from "../../common/outbox/outbox-writer";
import { nextAggregateVersion } from "../../common/outbox/aggregate-version";
import type { ScreeningQuestion } from "../../db/schema/hr/hiring-core";
import { evaluateScreening } from "./careers-screening";
import { type ResumeIntake } from "./careers-resume-intake";
import { splitName } from "../../common/hr/split-person-name";
import type { ApplyInput } from "./dto/public.schemas";

/**
 * The write half of the one public apply door.
 *
 * Split from `PublicCareersService` because the service is the tenant/HTTP
 * boundary — resolve the org, resolve the job, refuse a knockout — while this
 * file is one transaction that has to hold five things together: the candidate,
 * the application, the consent stamp, the vault pointer and
 * `candidate.applied`. They commit together or not at all, which is the whole
 * reason the legacy `/careers/apply` and this endpoint could not simply be run
 * one after the other.
 */

function isQuotaExceededError(error: unknown): error is PaymentRequiredException {
  if (!(error instanceof PaymentRequiredException)) return false;
  const body = error.getResponse();
  return typeof body === "object" && body !== null && "code" in body && body.code === "QUOTA_EXCEEDED";
}

export interface ApplyJob {
  readonly id: number;
  readonly title: string;
  readonly screeningQuestions: ScreeningQuestion[] | null;
  /** The recruiter who opened the job; the custodian of anything filed against it. */
  readonly postedBy: string | null;
}

export interface ApplyResult {
  readonly trackingToken: string;
  /** True when this email had already applied to this job; nothing new was written. */
  readonly duplicate: boolean;
  readonly resumeStored: boolean;
  readonly resumeReason: string | null;
}

/**
 * Refuses the application on a knockout or a missing required answer, and
 * returns the answers worth storing otherwise.
 *
 * Runs before the transaction opens, so a refused application leaves no
 * candidate, no application row and no event — "does not create an application
 * row" is a property of the ordering, not of a cleanup.
 */
export function screenOrRefuse(job: ApplyJob, input: ApplyInput): Record<string, string> {
  const verdict = evaluateScreening(job.screeningQuestions, input.answers);
  if (verdict.outcome === "missing")
    throw new BadRequestException(
      `Please answer the required question(s): ${verdict.questions.join("; ")}`,
    );
  if (verdict.outcome === "knocked-out")
    throw new UnprocessableEntityException({
      code: "SCREENING_KNOCKOUT",
      message: verdict.reason,
      question: verdict.question,
    });
  return verdict.answers;
}

/**
 * Who `candidate_documents_vault.uploaded_by` names for a file nobody in the
 * organisation uploaded.
 *
 * The column is NOT NULL and a BEFORE INSERT trigger
 * (`hr_sync_actor_membership`) resolves it to an `organization_members` row,
 * raising `foreign_key_violation` when it cannot — so a sentinel string is
 * refused and there is no "the candidate" to name. The custodian is therefore
 * the recruiter who opened the job, falling back to the organisation owner.
 * That is what the column can honestly mean here: who in this organisation is
 * answerable for the record. What the file IS — a résumé a candidate attached
 * to their own application — is already carried by `document_type` and by the
 * candidate the row hangs off.
 */
async function resolveVaultCustodian(
  tx: Db,
  orgId: string,
  postedBy: string | null,
): Promise<string> {
  if (postedBy) {
    const [member] = await tx
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, postedBy)))
      .limit(1);
    if (member) return member.userId;
  }
  const [owner] = await tx
    .select({ userId: organizationMembers.userId })
    .from(organizations)
    .innerJoin(organizationMembers, eq(organizationMembers.id, organizations.ownerMembershipId))
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!owner)
    throw new InternalServerErrorException("This organisation cannot receive uploaded files.");
  return owner.userId;
}

interface RecordApplicationInput {
  readonly tx: Db;
  readonly planLimits: PlanLimitsService;
  readonly orgId: string;
  readonly job: ApplyJob;
  readonly input: ApplyInput;
  readonly answers: Record<string, string>;
  readonly resume: ResumeIntake;
}

/**
 * Everything the application commits, inside the caller's tenant transaction.
 *
 * The advisory lock is what makes "the same email cannot apply twice" true
 * under concurrency. `candidate_applications` carries no unique index on
 * (org, candidate, job) and one cannot safely be added to a live table that may
 * already hold duplicates, so the serialisation is taken explicitly on the
 * (org, job, email) triple — the same shape `OnboardingInitiationService` uses
 * to make its own initiate idempotent.
 */
export async function recordApplication({
  tx,
  planLimits,
  orgId,
  job,
  input,
  answers,
  resume,
}: RecordApplicationInput): Promise<ApplyResult> {
  const email = input.email.toLowerCase().trim();
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${orgId}:${job.id}:${email}`}, 0))`,
  );

  const [existingByEmail] = await tx
    .select({ id: candidates.id })
    .from(candidates)
    .where(and(eq(candidates.email, email), eq(candidates.orgId, orgId)))
    .limit(1);

  if (!existingByEmail) {
    try {
      await planLimits.assertWithinLimit(orgId, "hrCandidates", 1, tx);
    } catch (error) {
      if (!isQuotaExceededError(error)) throw error;
      logger.warn("[public-careers] job application refused: candidate quota exceeded", {
        orgId,
        jobPostingId: job.id,
      });
      throw new BadRequestException(
        "This job posting is not accepting applications at this time.",
      );
    }
  }

  const { firstName, lastName } = splitName(input.name);
  const candidateId =
    existingByEmail?.id ??
    (await tx
      .insert(candidates)
      .values({
        orgId,
        firstName,
        lastName,
        email,
        phone: input.phone ?? null,
        linkedinUrl: input.linkedinUrl ?? null,
        resumeUrl: input.resumeUrl ?? null,
        source: "CAREERS_PAGE",
        status: "NEW",
      })
      .returning({ id: candidates.id })
      .then((rows) => rows[0]?.id));

  if (candidateId === undefined)
    throw new InternalServerErrorException("Failed to process application.");

  const existingApplication = await tx.query.candidateApplications.findFirst({
    where: and(
      eq(candidateApplications.orgId, orgId),
      eq(candidateApplications.candidateId, candidateId),
      eq(candidateApplications.jobPostingId, job.id),
    ),
    columns: { id: true, trackingToken: true },
  });

  if (existingApplication) {
    /**
     * A second apply is answered with the FIRST application's tracking token,
     * not an error: the candidate's intent succeeded the first time, and a
     * duplicate submission from a double-clicked button should hand them back
     * the link they were owed. A row from before tracking tokens existed gets
     * one now rather than returning null.
     */
    const token = existingApplication.trackingToken ?? randomBytes(32).toString("hex");
    if (!existingApplication.trackingToken)
      await tx
        .update(candidateApplications)
        .set({ trackingToken: token })
        .where(
          and(
            eq(candidateApplications.id, existingApplication.id),
            eq(candidateApplications.orgId, orgId),
          ),
        );
    return { trackingToken: token, duplicate: true, resumeStored: false, resumeReason: "duplicate-application" };
  }

  const trackingToken = randomBytes(32).toString("hex");
  await tx.insert(candidateApplications).values({
    orgId,
    candidateId,
    jobPostingId: job.id,
    status: "APPLIED",
    coverLetter: input.coverLetter ?? null,
    screeningAnswers: answers,
    consentAt: new Date(),
    trackingToken,
  });

  if (resume.stored) {
    const custodian = await resolveVaultCustodian(tx, orgId, job.postedBy);
    await tx.insert(candidateDocumentsVault).values({
      orgId,
      candidateId,
      filename: resume.filename,
      s3Key: resume.key,
      fileUrl: resume.key,
      fileType: resume.fileType,
      fileSize: resume.fileSize,
      documentType: "RESUME",
      uploadedBy: custodian,
      /**
       * Whatever the scanner returned. `PENDING` here means no scanner was
       * configured, not that one is still running, and the vault download
       * refuses anything that is not CLEAN.
       */
      avResult: resume.avResult,
    });
  }

  const aggregate = {
    organizationId: orgId,
    aggregateType: "candidate",
    aggregateId: String(candidateId),
  };
  await OutboxWriter.emit(tx, {
    eventId: randomUUID(),
    ...aggregate,
    aggregateVersion: await nextAggregateVersion(tx, aggregate),
    eventType: "candidate.applied",
    payload: { candidateId, jobPostingId: job.id, source: "CAREERS_PAGE" },
    occurredAt: new Date(),
  });

  return {
    trackingToken,
    duplicate: false,
    resumeStored: resume.stored,
    resumeReason: resume.stored ? null : resume.reason,
  };
}
