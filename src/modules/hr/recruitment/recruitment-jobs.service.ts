import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
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
import { JobBoardPublisherService } from "./boards/job-board-publisher.service";
import type { AssignRecruiterInput, CreateJobInput, InternalApplyInput, JobListInput, PublishJobInput, UpdateJobInput } from "./dto/jobs.schemas";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";


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
    private readonly publisher: JobBoardPublisherService,
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
        applicationDeadline: input.applicationDeadline ? formatDateOnly(input.applicationDeadline) : undefined,
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
      with: {
        applications: {
          columns: { trackingToken: false },
        },
      },
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
    if (input.applicationDeadline !== undefined) updateData.applicationDeadline = formatDateOnly(input.applicationDeadline);
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

  /**
   * Ask for this job to be advertised on external boards.
   *
   * It answered `PUBLISHED` and stored `{platform}-{jobId}-{timestamp}` as an
   * external posting id whenever a token happened to be saved, having called
   * nobody. It now *queues*: each platform resolves through `resolveBoard`, a
   * blocked one gets a `BLOCKED` publication row carrying its code, and a
   * resolvable one gets a `QUEUED` row plus an outbox event. Nothing here talks
   * to a board — `JobBoardOutboxConsumer` does, and it is the only code that
   * can mark a posting `LIVE`, which it can only do from an id a vendor
   * returned.
   *
   * So the answer to "did it post?" is deliberately "it is queued", which is
   * the true answer at the moment the request returns. The board settings
   * screen reads the publication rows for what happened next.
   *
   * Opening the job to the careers site is a different act and is a status
   * patch to `OPEN`; this endpoint was never that and no longer reads as if it
   * might be.
   */
  async publish(orgId: string, jobId: number, input: PublishJobInput) {
    const job = await this.db.query.jobPostings.findFirst({
      where: and(eq(jobPostings.id, jobId), eq(jobPostings.orgId, orgId)),
      columns: { id: true, status: true },
    });
    if (!job) throw new NotFoundException("Job posting not found.");
    if (job.status === "DRAFT") {
      throw new BadRequestException("Cannot publish a DRAFT job. Set status to OPEN first.");
    }

    const results = await this.publisher.queue(orgId, jobId, input.platforms);
    const queued = results.filter((r) => r.status === "QUEUED").length;
    const blocked = results.filter((r) => r.status === "BLOCKED").length;
    await this.cache.invalidateNamespace(`hr:jobs:list:${orgId}`);

    return {
      results,
      queuedCount: queued,
      blockedCount: blocked,
      failedCount: results.length - queued - blocked,
    };
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
        and(
          eq(orgUnits.orgId, jobPostings.orgId),
          eq(orgUnits.id, jobPostings.orgDepartmentId),
          // Soft-deleting an org unit does not fire the posting's cascade, so `org_department_id`
          // outlives the department it names. Without this the badge rendered a deleted
          // department; with it the LEFT JOIN yields a null name and the mapping below already
          // collapses that to `department: null`, which is what the client's guard expects.
          isNull(orgUnits.deletedAt),
        ),
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
      await this.planLimits.assertWithinLimit(orgId, "hrCandidates");
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
      if (!created) throw new InternalServerErrorException("Failed to create candidate.");
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
