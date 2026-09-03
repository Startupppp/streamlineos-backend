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
  orgUnits,
  organizations,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { formatDateOnly } from "../../../common/date";
import type { AssignRecruiterInput, CreateJobInput, InternalApplyInput, JobListInput, PublishJobInput, UpdateJobInput } from "./dto/jobs.schemas";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";

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
    const key = `${input.status ?? ""}:${input.cursor ?? ""}:${input.pageSize}`;
    return this.cache.cachedVersioned(
      `hr:jobs:list:${orgId}`,
      key,
      async () => {
        const conditions = [eq(jobPostings.orgId, orgId)];
        if (input.status) conditions.push(eq(jobPostings.status, input.status));
        const baseWhere = and(...conditions);
        const position = decodeCursor(input.cursor);
        const where = and(
          baseWhere,
          position ? keysetBeforeId(jobPostings.createdAt, jobPostings.id, position) : undefined,
        );

        const [items, totalRow] = await Promise.all([
          this.db.query.jobPostings.findMany({
            where,
            orderBy: [desc(jobPostings.createdAt), desc(jobPostings.id)],
            limit: input.limit + 1,
          }),
          this.db
            .select({ total: sql<number>`count(*)::int` })
            .from(jobPostings)
            .where(baseWhere)
            .then((rows) => rows[0] ?? { total: 0 }),
        ]);

        const total = Number(totalRow.total);
        const page = buildCursorPage(items, input.pageSize, (job) => ({
          sortValue: job.createdAt.toISOString(),
          id: String(job.id),
        }));
        return {
          items: page.data,
          total,
          pagination: page.pagination,
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

    await this.cache.invalidateNamespace(`hr:jobs:list:${orgId}`);
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
    await this.cache.invalidateNamespace(`hr:jobs:list:${orgId}`);
    return { success: true };
  }

  async remove(orgId: string, jobId: number) {
    const removed = await this.db
      .delete(jobPostings)
      .where(and(eq(jobPostings.id, jobId), eq(jobPostings.orgId, orgId)))
      .returning({ id: jobPostings.id });
    if (removed.length === 0) throw new NotFoundException("Job posting not found.");
    await this.cache.invalidateNamespace(`hr:jobs:list:${orgId}`);
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
    const normalizedBase = baseTitle.trim().toLowerCase();
    const normalizedLocation = (source.location ?? "").trim().toLowerCase();
    const existingCopies = await this.db
      .select({ normTitle: sql<string>`lower(trim(${jobPostings.title}))` })
      .from(jobPostings)
      .where(
        and(
          eq(jobPostings.orgId, orgId),
          sql`lower(trim(${jobPostings.title})) LIKE ${normalizedBase + " (copy%"}`,
          sql`lower(trim(coalesce(${jobPostings.location}, ''))) = ${normalizedLocation}`,
          eq(jobPostings.type, source.type ?? "FULL_TIME"),
        ),
      )
      .limit(25);
    const clashingNorm = new Set(existingCopies.map((r) => r.normTitle));

    let title = `${baseTitle} (copy)`;
    for (let attempt = 2; attempt <= 21; attempt++) {
      if (!clashingNorm.has(title.trim().toLowerCase())) break;
      title = `${baseTitle} (copy ${attempt})`;
    }

    const [job] = await this.db
      .insert(jobPostings)
      .values({
        orgId,
        title,
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

    await this.cache.invalidateNamespace(`hr:jobs:list:${orgId}`);
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
      limit: 100,
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
        .where(and(eq(jobPostings.id, jobId), eq(jobPostings.orgId, orgId)));
      await this.cache.invalidateNamespace(`hr:jobs:list:${orgId}`);
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
      .where(eq(jobRecruiters.jobPostingId, jobId))
      .limit(100);
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

  async removeRecruiter(orgId: string, jobId: number, input: AssignRecruiterInput) {
    await this.ensureJob(orgId, jobId);
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

  /**
   * The client's `InternalJob` declares `department` and `departmentId`; this read shipped the
   * relation under its schema name, `orgDepartment` / `orgDepartmentId`, and `apiClient.get` is a
   * cast, so `job.department` was `undefined` on every row and the department badge in
   * `internal-jobs-client.tsx:109` — guarded by `{job.department && ...}` — silently never rendered
   * on any internal opening. `postedByUser` leaves the wire: no consumer reads it.
   */
  async listInternalJobs(orgId: string) {
    const rows = await this.db
      .select({
        id: jobPostings.id,
        title: jobPostings.title,
        departmentId: jobPostings.orgDepartmentId,
        departmentName: orgUnits.name,
        location: jobPostings.location,
        type: jobPostings.type,
        experience: jobPostings.experience,
        description: jobPostings.description,
        requirements: jobPostings.requirements,
        openings: jobPostings.openings,
        applicationDeadline: jobPostings.applicationDeadline,
        createdAt: jobPostings.createdAt,
      })
      .from(jobPostings)
      .leftJoin(
        orgUnits,
        and(eq(orgUnits.orgId, jobPostings.orgId), eq(orgUnits.id, jobPostings.orgDepartmentId)),
      )
      .where(
        and(eq(jobPostings.orgId, orgId), eq(jobPostings.isInternal, true), eq(jobPostings.status, "OPEN")),
      )
      .limit(100);
    return rows.map(({ departmentName, ...job }) => ({
      ...job,
      department: job.departmentId !== null && departmentName !== null ? { id: job.departmentId, name: departmentName } : null,
    }));
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
      where: and(
        eq(candidateApplications.orgId, orgId),
        eq(candidateApplications.candidateId, candidateId),
        eq(candidateApplications.jobPostingId, jobId),
      ),
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
