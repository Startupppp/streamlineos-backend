import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, ilike } from "drizzle-orm";
import {
  candidateApplications,
  candidates,
  jobPostings,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import type { ApplyInput } from "./dto/careers.schemas";

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
  ) {}

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
    const { jobPostingId, name, email, phone, linkedinUrl, coverLetter, resumeUrl, answers } =
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

      const candidateId = existingCandidate
        ? existingCandidate.id
        : (
            await tx
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
              .returning({ id: candidates.id })
          )[0]!.id;

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
      });

      return { id: candidateId };
    }, { orgId: job.orgId });

    await this.cache.invalidatePattern(`hr:candidates:list:${job.orgId}:*`);
    return result;
  }
}
