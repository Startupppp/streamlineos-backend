import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import {
  candidateApplications,
  candidates,
  jobPostings,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
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
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

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
        createdAt: jobPostings.createdAt,
      })
      .from(jobPostings)
      .where(eq(jobPostings.status, "OPEN"))
      .orderBy(desc(jobPostings.createdAt));
  }

  async apply(input: ApplyInput) {
    const { jobPostingId, name, email, phone, linkedinUrl, coverLetter, resumeUrl } =
      input;

    const [job] = await this.db
      .select({ id: jobPostings.id, orgId: jobPostings.orgId })
      .from(jobPostings)
      .where(and(eq(jobPostings.id, jobPostingId), eq(jobPostings.status, "OPEN")))
      .limit(1);

    if (!job) return { error: "job_not_found" as const };

    const nameParts = name.trim().split(/\s+/);
    const firstName = nameParts[0] ?? name.trim();
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : "-";

    return this.db.transaction(async (tx) => {
      const [candidate] = await tx
        .insert(candidates)
        .values({
          orgId: job.orgId,
          firstName,
          lastName,
          email: email.toLowerCase().trim(),
          phone: phone ?? null,
          linkedinUrl: linkedinUrl ?? null,
          resumeUrl: resumeUrl ?? null,
          source: "CAREERS_PAGE",
          status: "NEW",
        })
        .returning({ id: candidates.id });

      await tx.insert(candidateApplications).values({
        orgId: job.orgId,
        candidateId: candidate.id,
        jobPostingId,
        status: "APPLIED",
        coverLetter: coverLetter ?? null,
      });

      return { id: candidate.id };
    });
  }
}
