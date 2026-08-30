import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, gte, lte, sql } from "drizzle-orm";
import {
  candidateOffers,
  candidateSlaTracking,
  candidates,
  interviews,
  jobPostings,
  scheduledReports,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import type { CreateScheduledReportInput, GenerateReportInput } from "./dto/hr-interviews.schemas";

const CANDIDATE_STATUSES = ["NEW", "SCREENING", "INTERVIEW", "OFFER", "HIRED", "REJECTED"] as const;
type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

function isCandidateStatus(value: string): value is CandidateStatus {
  return (CANDIDATE_STATUSES as readonly string[]).includes(value);
}

const CANDIDATE_FIELDS = [
  "id", "firstName", "lastName", "email", "phone", "status", "source",
  "currentCompany", "currentRole", "experienceYears", "rating", "aiScore",
  "location", "gender", "createdAt",
] as const;

const JOB_FIELDS = [
  "id", "title", "status", "type", "location", "openings", "salaryMin",
  "salaryMax", "createdAt", "applicationDeadline",
] as const;

const INTERVIEW_FIELDS = [
  "id", "type", "scheduledAt", "result", "rating", "duration", "location",
  "createdAt",
] as const;

const OFFER_FIELDS = [
  "id", "offerStatus", "offeredSalary", "offeredDesignation", "joiningDate",
  "validUntil", "sentAt", "respondedAt", "createdAt",
] as const;

const STAGES = ["NEW", "SCREENING", "INTERVIEW", "OFFER", "HIRED", "REJECTED"] as const;

function pickFields(row: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((f) => [f, row[f] ?? null]));
}

@Injectable()
export class HrRecruitmentReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async generateReport(orgId: string, input: GenerateReportInput) {
    const { entity, fields, filters } = input;
    let rows: Record<string, unknown>[] = [];

    if (entity === "candidates") {
      const validFields = fields.filter((f) => (CANDIDATE_FIELDS as readonly string[]).includes(f));
      const conditions = [eq(candidates.orgId, orgId)];
      if (filters.status && isCandidateStatus(filters.status)) {
        conditions.push(eq(candidates.status, filters.status));
      }
      if (filters.dateFrom) conditions.push(gte(candidates.createdAt, new Date(filters.dateFrom)));
      if (filters.dateTo) conditions.push(lte(candidates.createdAt, new Date(filters.dateTo)));
      const result = await this.db.select().from(candidates).where(and(...conditions)).limit(1000);
      rows = result.map((r) => pickFields(r, validFields.length ? validFields : [...CANDIDATE_FIELDS]));
    }

    if (entity === "jobs") {
      const validFields = fields.filter((f) => (JOB_FIELDS as readonly string[]).includes(f));
      const conditions = [eq(jobPostings.orgId, orgId)];
      if (filters.dateFrom) conditions.push(gte(jobPostings.createdAt, new Date(filters.dateFrom)));
      if (filters.dateTo) conditions.push(lte(jobPostings.createdAt, new Date(filters.dateTo)));
      if (filters.departmentId) conditions.push(eq(jobPostings.orgDepartmentId, filters.departmentId));
      const result = await this.db.select().from(jobPostings).where(and(...conditions)).limit(1000);
      rows = result.map((r) => pickFields(r, validFields.length ? validFields : [...JOB_FIELDS]));
    }

    if (entity === "interviews") {
      const validFields = fields.filter((f) => (INTERVIEW_FIELDS as readonly string[]).includes(f));
      const conditions = [eq(interviews.orgId, orgId)];
      if (filters.dateFrom) conditions.push(gte(interviews.scheduledAt, new Date(filters.dateFrom)));
      if (filters.dateTo) conditions.push(lte(interviews.scheduledAt, new Date(filters.dateTo)));
      const result = await this.db.select().from(interviews).where(and(...conditions)).limit(1000);
      rows = result.map((r) => pickFields(r, validFields.length ? validFields : [...INTERVIEW_FIELDS]));
    }

    if (entity === "offers") {
      const validFields = fields.filter((f) => (OFFER_FIELDS as readonly string[]).includes(f));
      const conditions = [eq(candidateOffers.orgId, orgId)];
      if (filters.dateFrom) conditions.push(gte(candidateOffers.createdAt, new Date(filters.dateFrom)));
      if (filters.dateTo) conditions.push(lte(candidateOffers.createdAt, new Date(filters.dateTo)));
      const result = await this.db.select({
        id: candidateOffers.id,
        offerStatus: candidateOffers.offerStatus,
        offeredSalary: candidateOffers.offeredSalary,
        offeredDesignation: candidateOffers.offeredDesignation,
        joiningDate: candidateOffers.joiningDate,
        validUntil: candidateOffers.validUntil,
        sentAt: candidateOffers.sentAt,
        respondedAt: candidateOffers.respondedAt,
        createdAt: candidateOffers.createdAt,
      }).from(candidateOffers).where(and(...conditions)).limit(1000);
      rows = result.map((r) => pickFields(r, validFields.length ? validFields : [...OFFER_FIELDS]));
    }

    return { rows, entity, fields, total: rows.length };
  }

  listScheduledReports(orgId: string) {
    return this.db.query.scheduledReports.findMany({
      where: eq(scheduledReports.orgId, orgId),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
      limit: 100,
    });
  }

  async createScheduledReport(orgId: string, userId: string, input: CreateScheduledReportInput) {
    const [report] = await this.db
      .insert(scheduledReports)
      .values({
        orgId,
        createdBy: userId,
        name: input.name,
        reportConfig: input.reportConfig,
        schedule: input.schedule,
        recipients: input.recipients,
      })
      .returning();
    return report;
  }

  async deleteScheduledReport(orgId: string, id: number) {
    await this.db
      .delete(scheduledReports)
      .where(and(eq(scheduledReports.id, id), eq(scheduledReports.orgId, orgId)));
    return { success: true };
  }

  analytics(orgId: string) {
    return this.cache.cached(
      `hr:recruitment-analytics:${orgId}`,
      () => this.buildAnalytics(orgId),
      CACHE_TTL.MEDIUM,
    );
  }

  private async buildAnalytics(orgId: string) {
    const timeToHireData = await this.db
      .select({
        stage: candidateSlaTracking.stage,
        avgHours: sql<number>`AVG(EXTRACT(EPOCH FROM (${candidateSlaTracking.updatedAt} - ${candidateSlaTracking.enteredAt})) / 3600)`,
        count: count(),
      })
      .from(candidateSlaTracking)
      .where(eq(candidateSlaTracking.orgId, orgId))
      .groupBy(candidateSlaTracking.stage);

    const pipelineVelocity = await this.db
      .select({ status: candidates.status, count: count() })
      .from(candidates)
      .where(eq(candidates.orgId, orgId))
      .groupBy(candidates.status);

    const [totalResult] = await this.db
      .select({ total: count() })
      .from(candidates)
      .where(eq(candidates.orgId, orgId));

    const [hiredResult] = await this.db
      .select({ hired: count() })
      .from(candidates)
      .where(and(eq(candidates.orgId, orgId), eq(candidates.status, "HIRED")));

    const total = Number(totalResult?.total ?? 0);
    const hired = Number(hiredResult?.hired ?? 0);
    const hireRate = total > 0 ? Math.round((hired / total) * 100) : 0;

    const stageTimes = Object.fromEntries(
      timeToHireData.map((r) => [r.stage, { avgHours: Number(r.avgHours ?? 0), count: Number(r.count) }]),
    );

    const funnel = STAGES.map((stage) => {
      const stageCount = pipelineVelocity.find((v) => v.status === stage);
      const stageTiming = stageTimes[stage];
      return {
        stage,
        count: Number(stageCount?.count ?? 0),
        avgDaysInStage: stageTiming ? Math.round((stageTiming.avgHours / 24) * 10) / 10 : null,
      };
    });

    return { funnel, hireRate, totalCandidates: total, totalHired: hired };
  }

  async stats(orgId: string) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [jobs, candsByStatus, upcoming, hiredMonth, sourceBreakdown, avgTimeToHire] =
      await Promise.all([
        this.db
          .select({ status: jobPostings.status, count: sql<number>`count(*)` })
          .from(jobPostings)
          .where(eq(jobPostings.orgId, orgId))
          .groupBy(jobPostings.status),

        this.db
          .select({ status: candidates.status, count: sql<number>`count(*)` })
          .from(candidates)
          .where(eq(candidates.orgId, orgId))
          .groupBy(candidates.status),

        this.db
          .select({ count: sql<number>`count(*)` })
          .from(interviews)
          .where(and(eq(interviews.orgId, orgId), gte(interviews.scheduledAt, now))),

        this.db
          .select({ count: sql<number>`count(*)` })
          .from(candidates)
          .where(
            and(
              eq(candidates.orgId, orgId),
              eq(candidates.status, "HIRED"),
              gte(candidates.updatedAt, monthStart),
            ),
          ),

        this.db
          .select({ source: candidates.source, count: sql<number>`count(*)` })
          .from(candidates)
          .where(eq(candidates.orgId, orgId))
          .groupBy(candidates.source),

        this.db
          .select({
            avgDays: sql<number>`COALESCE(AVG(EXTRACT(EPOCH FROM (${candidates.updatedAt} - ${candidates.createdAt})) / 86400), 0)`,
          })
          .from(candidates)
          .where(and(eq(candidates.orgId, orgId), eq(candidates.status, "HIRED"))),
      ]);

    let totalJobs = 0;
    let openJobs = 0;
    for (const row of jobs) {
      const cnt = Number(row.count);
      totalJobs += cnt;
      if (row.status === "OPEN") openJobs += cnt;
    }

    const funnel: Record<string, number> = {};
    let totalCandidates = 0;
    let newCandidates = 0;
    for (const row of candsByStatus) {
      const cnt = Number(row.count);
      totalCandidates += cnt;
      if (row.status === "NEW") newCandidates += cnt;
      funnel[row.status ?? "UNKNOWN"] = cnt;
    }

    const sources = sourceBreakdown.map((s) => ({
      source: s.source ?? "Unknown",
      count: Number(s.count),
    }));

    return {
      totalJobs,
      openJobs,
      totalCandidates,
      newCandidates,
      upcomingInterviews: Number(upcoming[0]?.count ?? 0),
      hiredThisMonth: Number(hiredMonth[0]?.count ?? 0),
      funnel,
      sources,
      avgTimeToHireDays: Math.round(Number(avgTimeToHire[0]?.avgDays ?? 0)),
    };
  }
}
