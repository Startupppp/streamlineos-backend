import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  candidateApplications,
  candidateSources,
  candidates,
  jobPostings,
  jobRecruiters,
  organizations,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import { PlanLimitsService } from "../billing/plan-limits.service";
import { formatDateOnly } from "../../common/date";
import type { AssignRecruiterInput, CreateJobInput, InternalApplyInput, JobListInput, PublishJobInput, UpdateJobInput } from "./dto/jobs.schemas";

type PublishStatus = "PUBLISHED" | "NO_INTEGRATION" | "INACTIVE" | "NO_TOKEN";

const SHARE_PLATFORMS = [
  { key: "LINKEDIN", name: "LinkedIn", baseUrl: "https://www.linkedin.com/sharing/share-offsite/?url=" },
  { key: "WHATSAPP", name: "WhatsApp", baseUrl: "https://wa.me/?text=" },
  { key: "TWITTER", name: "Twitter / X", baseUrl: "https://twitter.com/intent/tweet?url=" },
] as const;

@Injectable()
export class RecruitmentJobsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  async list(orgId: string, input: JobListInput) {
    const key = `hr:jobs:list:${orgId}:${input.status ?? ""}:${input.page}:${input.pageSize}`;
    return this.cache.cached(
      key,
      async () => {
        const conditions = [eq(jobPostings.orgId, orgId)];
        if (input.status) conditions.push(eq(jobPostings.status, input.status));
        const where = and(...conditions);

        const [items, totalRow] = await Promise.all([
          this.db.query.jobPostings.findMany({
            where,
            orderBy: [desc(jobPostings.createdAt)],
            limit: input.limit,
            offset: input.offset,
          }),
          this.db
            .select({ total: sql<number>`count(*)::int` })
            .from(jobPostings)
            .where(where)
            .then((rows) => rows[0] ?? { total: 0 }),
        ]);

        const total = Number(totalRow.total);
        return {
          items,
          total,
          page: input.page,
          pageSize: input.pageSize,
          totalPages: input.pageSize > 0 ? Math.ceil(total / input.pageSize) : 0,
        };
      },
      CACHE_TTL.MEDIUM,
    );
  }

  async create(orgId: string, userId: string, input: CreateJobInput) {
    await this.planLimits.assertWithinLimit(orgId, "hrJobPostings");

    const normalizedTitle = input.title.trim().toLowerCase();
    const normalizedLocation = (input.location ?? "").trim().toLowerCase();
    const normalizedType = input.type ?? "FULL_TIME";

    const existing = await this.db.query.jobPostings.findFirst({
      where: and(
        eq(jobPostings.orgId, orgId),
        sql`lower(trim(${jobPostings.title})) = ${normalizedTitle}`,
        sql`lower(trim(coalesce(${jobPostings.location}, ''))) = ${normalizedLocation}`,
        eq(jobPostings.type, normalizedType),
      ),
      columns: { id: true },
    });
    if (existing) {
      throw new ConflictException("A job posting with the same title, location, and type already exists.");
    }

    const [job] = await this.db
      .insert(jobPostings)
      .values({
        orgId,
        title: input.title,
        orgDepartmentId: input.departmentId,
        hiringFlowId: input.hiringFlowId,
        location: input.location,
        type: input.type || "FULL_TIME",
        experience: input.experience,
        salaryMin: input.salaryMin?.toString(),
        salaryMax: input.salaryMax?.toString(),
        description: input.description,
        requirements: input.requirements,
        benefits: input.benefits,
        openings: input.openings || 1,
        applicationDeadline: input.applicationDeadline ? formatDateOnly(new Date(input.applicationDeadline)) : undefined,
        status: input.status ?? "DRAFT",
        postedBy: userId,
        screeningQuestions: input.screeningQuestions,
      })
      .returning();

    await this.cache.invalidatePattern(`hr:jobs:list:${orgId}:*`);
    return job;
  }

  async getOne(orgId: string, jobId: number) {
    const job = await this.db.query.jobPostings.findFirst({
      where: and(eq(jobPostings.id, jobId), eq(jobPostings.orgId, orgId)),
      with: { applications: true },
    });
    if (!job) throw new NotFoundException("Job posting not found.");
    return job;
  }

  async update(orgId: string, jobId: number, input: UpdateJobInput) {
    const existing = await this.db.query.jobPostings.findFirst({
      where: and(eq(jobPostings.id, jobId), eq(jobPostings.orgId, orgId)),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Job posting not found.");

    const updateData: Partial<typeof jobPostings.$inferInsert> = { updatedAt: new Date() };
    if (input.title !== undefined) updateData.title = input.title;
    if (input.departmentId !== undefined) updateData.orgDepartmentId = input.departmentId;
    if (input.location !== undefined) updateData.location = input.location;
    if (input.type !== undefined) updateData.type = input.type;
    if (input.experience !== undefined) updateData.experience = input.experience;
    if (input.salaryMin !== undefined) updateData.salaryMin = String(input.salaryMin);
    if (input.salaryMax !== undefined) updateData.salaryMax = String(input.salaryMax);
    if (input.description !== undefined) updateData.description = input.description;
    if (input.requirements !== undefined) updateData.requirements = input.requirements;
    if (input.benefits !== undefined) updateData.benefits = input.benefits;
    if (input.status !== undefined) updateData.status = input.status;
    if (input.openings !== undefined) updateData.openings = input.openings;
    if (input.applicationDeadline !== undefined) updateData.applicationDeadline = formatDateOnly(new Date(input.applicationDeadline));
    if (input.hiringFlowId !== undefined) updateData.hiringFlowId = input.hiringFlowId;
    if (input.screeningQuestions !== undefined) updateData.screeningQuestions = input.screeningQuestions;

    await this.db.update(jobPostings).set(updateData).where(and(eq(jobPostings.id, jobId), eq(jobPostings.orgId, orgId)));
    await this.cache.invalidatePattern(`hr:jobs:list:${orgId}:*`);
    return { success: true };
  }

  async remove(orgId: string, jobId: number) {
    await this.db.delete(jobPostings).where(and(eq(jobPostings.id, jobId), eq(jobPostings.orgId, orgId)));
    await this.cache.invalidatePattern(`hr:jobs:list:${orgId}:*`);
    return { success: true };
  }

  /**
   * Clone a job posting as a new DRAFT. Title is unique-suffixed to avoid
   * conflicting with the source posting (same location + type).
   */
  async duplicate(orgId: string, userId: string, jobId: number) {
    const source = await this.db.query.jobPostings.findFirst({
      where: and(eq(jobPostings.id, jobId), eq(jobPostings.orgId, orgId)),
    });
    if (!source) throw new NotFoundException("Job posting not found.");

    const baseTitle = source.title.replace(/\s*\(copy(?:\s+\d+)?\)\s*$/i, "").trim();
    let title = `${baseTitle} (copy)`;
    let attempt = 1;
    // Ensure we don't trip the title+location+type uniqueness check forever.
    while (attempt <= 20) {
      const clash = await this.db.query.jobPostings.findFirst({
        where: and(
          eq(jobPostings.orgId, orgId),
          sql`lower(trim(${jobPostings.title})) = ${title.trim().toLowerCase()}`,
          sql`lower(trim(coalesce(${jobPostings.location}, ''))) = ${(source.location ?? "").trim().toLowerCase()}`,
          eq(jobPostings.type, source.type ?? "FULL_TIME"),
        ),
        columns: { id: true },
      });
      if (!clash) break;
      attempt += 1;
      title = `${baseTitle} (copy ${attempt})`;
    }

    const [job] = await this.db
      .insert(jobPostings)
      .values({
        orgId,
        title,
        departmentId: source.departmentId,
        orgDepartmentId: source.orgDepartmentId,
        hiringFlowId: source.hiringFlowId,
        location: source.location,
        type: source.type ?? "FULL_TIME",
        experience: source.experience,
        salaryMin: source.salaryMin,
        salaryMax: source.salaryMax,
        description: source.description,
        requirements: source.requirements,
        benefits: source.benefits,
        openings: source.openings ?? 1,
        applicationDeadline: source.applicationDeadline,
        status: "DRAFT",
        postedBy: userId,
        screeningQuestions: source.screeningQuestions,
        isInternal: source.isInternal,
      })
      .returning();

    await this.cache.invalidatePattern(`hr:jobs:list:${orgId}:*`);
    return job;
  }

  async publish(orgId: string, jobId: number, input: PublishJobInput) {
    const job = await this.db.query.jobPostings.findFirst({
      where: and(eq(jobPostings.id, jobId), eq(jobPostings.orgId, orgId)),
    });
    if (!job) throw new NotFoundException("Job posting not found.");
    if (job.status === "DRAFT") {
      throw new BadRequestException("Cannot publish a DRAFT job. Set status to OPEN first.");
    }

    const sources = await this.db.query.candidateSources.findMany({
      where: eq(candidateSources.orgId, orgId),
    });

    const results: Array<{ platform: string; status: PublishStatus }> = [];
    const externalIds: Record<string, string> = { ...(job.externalPostingIds ?? {}) };

    for (const platform of input.platforms) {
      const src = sources.find((s) => s.platform === platform);
      if (!src) {
        results.push({ platform, status: "NO_INTEGRATION" });
        continue;
      }
      if (!src.isActive) {
        results.push({ platform, status: "INACTIVE" });
        continue;
      }
      if (!src.oauthToken) {
        results.push({ platform, status: "NO_TOKEN" });
        continue;
      }
      externalIds[platform.toLowerCase()] = `${platform.toLowerCase()}-${jobId}-${Date.now()}`;
      results.push({ platform, status: "PUBLISHED" });
    }

    const publishedCount = results.filter((r) => r.status === "PUBLISHED").length;
    if (publishedCount > 0) {
      await this.db
        .update(jobPostings)
        .set({ externalPostingIds: externalIds, updatedAt: new Date() })
        .where(eq(jobPostings.id, jobId));
      await this.cache.invalidatePattern(`hr:jobs:list:${orgId}:*`);
    }

    return { results, publishedCount, externalIds };
  }

  async listRecruiters(orgId: string, jobId: number) {
    await this.ensureJob(orgId, jobId);
    return this.db
      .select({
        id: jobRecruiters.id,
        userId: jobRecruiters.userId,
        assignedBy: jobRecruiters.assignedBy,
        assignedAt: jobRecruiters.assignedAt,
        name: users.name,
        email: users.email,
        image: users.image,
      })
      .from(jobRecruiters)
      .innerJoin(users, eq(jobRecruiters.userId, users.id))
      .where(eq(jobRecruiters.jobPostingId, jobId));
  }

  async assignRecruiter(orgId: string, userId: string, jobId: number, input: AssignRecruiterInput) {
    await this.ensureJob(orgId, jobId);
    const [row] = await this.db
      .insert(jobRecruiters)
      .values({ jobPostingId: jobId, userId: input.userId, assignedBy: userId })
      .onConflictDoNothing()
      .returning();
    return row ?? { message: "Already assigned" };
  }

  async removeRecruiter(jobId: number, input: AssignRecruiterInput) {
    await this.db
      .delete(jobRecruiters)
      .where(and(eq(jobRecruiters.jobPostingId, jobId), eq(jobRecruiters.userId, input.userId)));
    return { success: true };
  }

  async share(orgId: string, jobId: number) {
    const [job, org] = await Promise.all([
      this.db.query.jobPostings.findFirst({
        where: and(eq(jobPostings.id, jobId), eq(jobPostings.orgId, orgId)),
        columns: { id: true, title: true, location: true, type: true },
      }),
      this.db.query.organizations.findFirst({
        where: eq(organizations.id, orgId),
        columns: { slug: true },
      }),
    ]);
    if (!job) throw new NotFoundException("Job posting not found");
    if (!org?.slug) throw new InternalServerErrorException("Organization not configured");

    const appUrl = (process.env.APP_URL ?? "").replace(/\/$/, "");
    const baseJobUrl = `${appUrl}/careers/${org.slug}/jobs/${jobId}/apply`;

    const shareLinks = SHARE_PLATFORMS.map(({ key, name, baseUrl }) => {
      const utmUrl = `${baseJobUrl}?utm_source=${key.toLowerCase()}&utm_medium=social&utm_campaign=job_${jobId}`;
      const encoded = encodeURIComponent(key === "WHATSAPP" ? `${job.title} — Apply now: ${utmUrl}` : utmUrl);
      return { platform: key, name, url: `${baseUrl}${encoded}`, utmUrl };
    });

    return {
      jobId,
      title: job.title,
      shareLinks,
      directLink: baseJobUrl,
      careersPageLink: `${appUrl}/careers/${org.slug}`,
    };
  }

  listInternalJobs(orgId: string) {
    return this.db.query.jobPostings.findMany({
      where: and(eq(jobPostings.orgId, orgId), eq(jobPostings.isInternal, true), eq(jobPostings.status, "OPEN")),
      with: {
        department: { columns: { id: true, name: true } },
        orgDepartment: { columns: { id: true, name: true } },
        postedByUser: { columns: { id: true, name: true } },
      },
      columns: {
        id: true,
        title: true,
        departmentId: true,
        orgDepartmentId: true,
        location: true,
        type: true,
        experience: true,
        description: true,
        requirements: true,
        openings: true,
        applicationDeadline: true,
        createdAt: true,
      },
      limit: 100,
    });
  }

  async internalApply(orgId: string, userId: string, jobId: number, input: InternalApplyInput) {
    const job = await this.db.query.jobPostings.findFirst({
      where: and(
        eq(jobPostings.id, jobId),
        eq(jobPostings.orgId, orgId),
        eq(jobPostings.isInternal, true),
        eq(jobPostings.status, "OPEN"),
      ),
      columns: { id: true },
    });
    if (!job) throw new NotFoundException("Job not found or not accepting internal applications");

    const applicant = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { name: true, email: true },
    });
    const applicantEmail = applicant?.email ?? "";
    const applicantName = applicant?.name ?? "";

    const existing = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.email, applicantEmail), eq(candidates.orgId, orgId)),
      columns: { id: true },
    });

    let candidateId: number;
    if (existing) {
      candidateId = existing.id;
    } else {
      const [created] = await this.db
        .insert(candidates)
        .values({
          orgId,
          firstName: applicantName.split(" ")[0] || "Employee",
          lastName: applicantName.split(" ").slice(1).join(" ") || "",
          email: applicantEmail,
          source: "INTERNAL",
        })
        .returning({ id: candidates.id });
      candidateId = created.id;
    }

    const existingApp = await this.db.query.candidateApplications.findFirst({
      where: and(eq(candidateApplications.candidateId, candidateId), eq(candidateApplications.jobPostingId, jobId)),
      columns: { id: true },
    });
    if (existingApp) throw new ConflictException("You have already applied for this position");

    const [application] = await this.db
      .insert(candidateApplications)
      .values({
        orgId,
        candidateId,
        jobPostingId: jobId,
        coverLetter: input.coverLetter,
        notes: input.notes,
        status: "APPLIED",
      })
      .returning();

    return application;
  }

  private async ensureJob(orgId: string, jobId: number) {
    const job = await this.db.query.jobPostings.findFirst({
      where: and(eq(jobPostings.id, jobId), eq(jobPostings.orgId, orgId)),
      columns: { id: true },
    });
    if (!job) throw new NotFoundException("Job not found");
  }
}
