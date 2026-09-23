import { BadRequestException, Inject, Injectable, InternalServerErrorException } from "@nestjs/common";
import { and, desc, eq, ilike } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  candidateApplications,
  candidates,
  jobPostings,
  candidateDocumentsVault,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { PaymentRequiredException } from "../../common/http/api-exceptions";
import { logger } from "../../common/logger/logger.service";
import { OutboxWriter } from "../../common/outbox/outbox-writer";
import { RecruitmentWebhooksService } from "../hr/recruitment/webhooks/recruitment-webhooks.service";
import type { ApplyInput } from "./dto/careers.schemas";
import { StorageService } from "../storage/storage.service";

function isQuotaExceededError(error: unknown): error is PaymentRequiredException {
  if (!(error instanceof PaymentRequiredException)) return false;
  const body = error.getResponse();
  return typeof body === "object" && body !== null && "code" in body && body.code === "QUOTA_EXCEEDED";
}

export type ApplyJobNotFound = { error: "job_not_found" };

export function isApplyJobNotFound(value: unknown): value is ApplyJobNotFound {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    value.error === "job_not_found"
  );
}

@Injectable()
export class CareersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly planLimits: PlanLimitsService,
    private readonly recruitmentWebhooks: RecruitmentWebhooksService,
    private readonly storage: StorageService,
  ) {}

  async uploadResume(
    orgId: string,
    candidateId: number,
    userId: string,
    file: Buffer,
    fileName: string,
    mimeType: string,
  ) {
    const [candidate] = await this.db
      .select({ id: candidates.id })
      .from(candidates)
      .where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)))
      .limit(1);

    if (!candidate) {
      throw new BadRequestException("Candidate not found or access denied.");
    }

    const upload = await this.storage.uploadFile(orgId, file, "candidates/resumes", `${candidateId}/${fileName}`, mimeType);

    await this.db.insert(candidateDocumentsVault).values({
      candidateId,
      orgId,
      filename: fileName,
      s3Key: upload.key,
      fileUrl: upload.key, // Presumed public URL pattern
      fileType: mimeType,
      fileSize: upload.size,
      documentType: "RESUME",
      uploadedBy: userId,
    });

    return { key: upload.key };
  }

  listOpenJobs() {
    return this.db
      .select({
        id: jobPostings.id,
        title: jobPostings.title,
        location: jobPostings.location,
        type: jobPostings.type,
        experience: jobPostings.experience,
        description: jobPostings.description,
        requirements: jobPostings.requirements,
        benefits: jobPostings.benefits,
        openings: jobPostings.openings,
        applicationDeadline: jobPostings.applicationDeadline,
        screeningQuestions: jobPostings.screeningQuestions,
        createdAt: jobPostings.createdAt,
      })
      .from(jobPostings)
      .where(eq(jobPostings.status, "OPEN"))
      .orderBy(desc(jobPostings.createdAt));
  }

  async apply(input: ApplyInput) {
    console.log('DB:', this.db);
    const { jobPostingId, name, email, phone, linkedinUrl, coverLetter, resumeUrl, answers, consent } =
      input;
    const normalizedEmail = email.toLowerCase().trim();

    const [job] = await this.db
      .select({ id: jobPostings.id, orgId: jobPostings.orgId })
      .from(jobPostings)
      .where(and(eq(jobPostings.id, jobPostingId), eq(jobPostings.status, "OPEN")))
      .limit(1);

    if (!job) return { error: "job_not_found" as const };

    const nameParts = name.trim().split(/\s+/);
    const firstName = nameParts[0] ?? name.trim();
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : "-";

    const result = await runInTenantTransaction(this.db, async (tx) => {
      const existingCandidate = await tx.query.candidates.findFirst({
        where: and(eq(candidates.orgId, job.orgId), ilike(candidates.email, normalizedEmail)),
        columns: { id: true },
      });

      let candidateId: number;
      if (existingCandidate) {
        candidateId = existingCandidate.id;
      } else {
        try {
          await this.planLimits.assertWithinLimit(job.orgId, "hrCandidates", 1, tx);
        } catch (error) {
          if (!isQuotaExceededError(error)) throw error;
          logger.warn("[careers] application refused: candidate quota exceeded", {
            orgId: job.orgId,
            jobPostingId,
          });
          throw new BadRequestException(
            "This job posting is not accepting applications at this time.",
          );
        }
        const [created] = await tx
          .insert(candidates)
          .values({
            orgId: job.orgId,
            firstName,
            lastName,
            email: normalizedEmail,
            phone: phone ?? null,
            linkedinUrl: linkedinUrl ?? null,
            resumeUrl: resumeUrl ?? null,
            source: "CAREERS_PAGE",
            status: "NEW",
          })
          .returning({ id: candidates.id });
        if (!created) throw new InternalServerErrorException("Failed to create candidate.");
        candidateId = created.id;
      }

      const existingApplication = await tx.query.candidateApplications.findFirst({
        where: and(eq(candidateApplications.candidateId, candidateId), eq(candidateApplications.jobPostingId, jobPostingId)),
        columns: { id: true },
      });
      if (existingApplication) {
        return { id: candidateId, alreadyApplied: true };
      }

      await tx.insert(candidateApplications).values({
        orgId: job.orgId,
        candidateId,
        jobPostingId,
        status: "APPLIED",
        coverLetter: coverLetter ?? null,
        screeningAnswers: answers,
        consentAt: consent ? new Date() : null,
      });

      await OutboxWriter.emit(tx, {
        eventId: randomUUID(),
        organizationId: job.orgId,
        aggregateType: "candidate",
        aggregateId: candidateId.toString(),
        aggregateVersion: 1,
        eventType: "candidate.applied",
        payload: {
          candidateId,
          jobPostingId,
        },
        occurredAt: new Date(),
      });

      return { id: candidateId };
    }, { orgId: job.orgId });

    await this.cache.invalidateNamespace(`hr:candidates:list:${job.orgId}`);
    return result;
  }
}
