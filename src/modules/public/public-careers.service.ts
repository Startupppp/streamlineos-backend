import {
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import {
  candidateApplications,
  candidates,
  jobPostings,
  organizations,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { withPublicToken } from "../../common/tenant/with-public-token";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { randomBytes } from "node:crypto";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import type { ApplyInput } from "./dto/public.schemas";

@Injectable()
export class PublicCareersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly planLimits: PlanLimitsService,
  ) {}

  async getApplicationStatus(token: string) {
    const application = await withPublicToken(this.db, token, (tx) =>
      tx.query.candidateApplications.findFirst({
        where: eq(candidateApplications.trackingToken, token),
        columns: { orgId: true, status: true, appliedAt: true, updatedAt: true },
      }),
    );

    if (!application) throw new NotFoundException("Application not found");

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const full = await tx.query.candidateApplications.findFirst({
          where: eq(candidateApplications.trackingToken, token),
          columns: { status: true, appliedAt: true, updatedAt: true },
          with: {
            candidate: { columns: { firstName: true, lastName: true, email: true } },
            jobPosting: { columns: { title: true, location: true, type: true } },
          },
        });
        if (!full) throw new NotFoundException("Application not found");

        return {
          status: full.status,
          appliedAt: full.appliedAt,
          updatedAt: full.updatedAt,
          job: full.jobPosting,
          candidate: full.candidate,
        };
      },
      { orgId: application.orgId },
    );
  }

  async listOrgJobs(orgSlug: string) {
    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.slug, orgSlug),
      columns: { id: true, name: true, logo: true, industry: true },
    });
    if (!org) throw new NotFoundException("Organization not found");

    const jobs = await this.db
      .select({
        id: jobPostings.id,
        title: jobPostings.title,
        location: jobPostings.location,
        type: jobPostings.type,
        experience: jobPostings.experience,
        salaryMin: jobPostings.salaryMin,
        salaryMax: jobPostings.salaryMax,
        openings: jobPostings.openings,
        applicationDeadline: jobPostings.applicationDeadline,
        createdAt: jobPostings.createdAt,
      })
      .from(jobPostings)
      .where(and(eq(jobPostings.orgId, org.id), eq(jobPostings.status, "OPEN")))
      .orderBy(desc(jobPostings.createdAt));

    return { org, jobs };
  }

  async getOrgJob(orgSlug: string, jobId: number) {
    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.slug, orgSlug),
      columns: { id: true, name: true, logo: true },
    });
    if (!org) throw new NotFoundException("Organization not found");

    const job = await this.db.query.jobPostings.findFirst({
      where: and(
        eq(jobPostings.id, jobId),
        eq(jobPostings.orgId, org.id),
        eq(jobPostings.status, "OPEN"),
      ),
    });
    if (!job) throw new NotFoundException("Job not found");

    return { org, job };
  }

  async applyToOrgJob(orgSlug: string, jobId: number, input: ApplyInput) {
    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.slug, orgSlug),
      columns: { id: true, name: true },
    });
    if (!org) throw new NotFoundException("Organization not found");

    const job = await this.db.query.jobPostings.findFirst({
      where: and(
        eq(jobPostings.id, jobId),
        eq(jobPostings.orgId, org.id),
        eq(jobPostings.status, "OPEN"),
      ),
      columns: { id: true, title: true },
    });
    if (!job) throw new NotFoundException("Job not found or no longer accepting applications.");

    const nameParts = input.name.split(/\s+/);
    const firstName = nameParts[0] ?? input.name;
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : "-";
    const trackingToken = randomBytes(32).toString("hex");

    return runInTenantTransaction(this.db, async (tx) => {
      const [existingByEmail] = await tx
        .select({ id: candidates.id })
        .from(candidates)
        .where(and(eq(candidates.email, input.email), eq(candidates.orgId, org.id)))
        .limit(1);
      if (!existingByEmail) {
        await this.planLimits.assertWithinLimit(org.id, "hrCandidates", 1, tx);
      }
      const [candidate] = await tx
        .insert(candidates)
        .values({
          orgId: org.id,
          firstName,
          lastName,
          email: input.email,
          phone: input.phone ?? null,
          linkedinUrl: input.linkedinUrl ?? null,
          resumeUrl: input.resumeUrl ?? null,
          source: "CAREERS_PAGE",
          status: "NEW",
        })
        .onConflictDoNothing()
        .returning({ id: candidates.id });

      let candidateId: number | undefined = existingByEmail?.id ?? candidate?.id;
      if (!candidateId) {
        const [raced] = await tx
          .select({ id: candidates.id })
          .from(candidates)
          .where(and(eq(candidates.email, input.email), eq(candidates.orgId, org.id)))
          .limit(1);
        candidateId = raced?.id;
      }

      if (!candidateId) throw new InternalServerErrorException("Failed to process application.");

      await tx.insert(candidateApplications).values({
        orgId: org.id,
        candidateId,
        jobPostingId: jobId,
        status: "APPLIED",
        coverLetter: input.coverLetter ?? null,
        trackingToken,
      });

      return { trackingToken };
    }, { orgId: org.id });
  }
}
