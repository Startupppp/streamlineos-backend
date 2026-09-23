import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { candidateApplications, candidateSlaTracking, candidates, jobPostings } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import type { DiversityReportQueryInput } from "./dto/candidates.schemas";

const PIPELINE_STAGES = ["NEW", "SCREENING", "INTERVIEW", "OFFER", "HIRED", "REJECTED"] as const;

/**
 * How many cards a column carries. The board is a drag surface, not a list, so
 * this stays a cap rather than becoming a cursor — but a column that holds more
 * than this now SAYS so (`truncated`, `shown`), because reporting `total: 812`
 * over 50 rendered cards told the recruiter the other 762 were on screen
 * somewhere. The candidates list at `/hr/recruitment/candidates` is the paged
 * surface, and the board points at it.
 */
const STAGE_CANDIDATE_LIMIT = 50;
const SLA_READ_LIMIT = 1000;

@Injectable()
export class RecruitmentPipelineService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async pipeline(orgId: string) {
    const [stageCandidates, countRows] = await Promise.all([
      Promise.all(
        PIPELINE_STAGES.map((stage) =>
          this.db.query.candidates.findMany({
            where: and(eq(candidates.orgId, orgId), eq(candidates.status, stage)),
            orderBy: [desc(candidates.createdAt)],
            limit: STAGE_CANDIDATE_LIMIT,
            with: {
              applications: {
                columns: { id: true },
                with: { jobPosting: { columns: { id: true, title: true } } },
                limit: 1,
                orderBy: (apps, { desc: d }) => [d(apps.appliedAt)],
              },
            },
          }),
        ),
      ),
      this.db
        .select({ status: candidates.status, total: sql<number>`count(*)::int` })
        .from(candidates)
        .where(eq(candidates.orgId, orgId))
        .groupBy(candidates.status),
    ]);

    const totals = new Map<string, number>();
    for (const row of countRows) {
      totals.set(row.status, Number(row.total));
    }

    const candidateIds = stageCandidates.flat().map((c) => c.id);
    const slaRows = candidateIds.length
      ? await this.db
          .select({
            candidateId: candidateSlaTracking.candidateId,
            stage: candidateSlaTracking.stage,
            status: candidateSlaTracking.status,
          })
          .from(candidateSlaTracking)
          .where(
            and(eq(candidateSlaTracking.orgId, orgId), inArray(candidateSlaTracking.candidateId, candidateIds)),
          )
          .limit(SLA_READ_LIMIT)
      : [];

    const slaLookup = new Map<string, string>();
    for (const row of slaRows) {
      slaLookup.set(`${row.candidateId}:${row.stage}`, row.status);
    }

    const stages = PIPELINE_STAGES.map((stage, index) => ({
      stage,
      total: totals.get(stage) ?? 0,
      shown: stageCandidates[index].length,
      truncated: (totals.get(stage) ?? 0) > stageCandidates[index].length,
      candidates: stageCandidates[index].map((c) => {
        const latestApp = c.applications?.[0] ?? null;
        return {
          id: c.id,
          name: `${c.firstName} ${c.lastName}`,
          email: c.email,
          phone: c.phone ?? null,
          source: c.source ?? null,
          rating: c.rating ?? null,
          jobTitle: latestApp?.jobPosting?.title ?? null,
          applicationId: latestApp?.id ?? null,
          appliedAt: c.createdAt ?? null,
          slaStatus: slaLookup.get(`${c.id}:${stage}`) ?? null,
          resumeUrl: c.resumeUrl ?? null,
          notes: c.notes ?? null,
        };
      }),
    }));

    return { stages };
  }

  async diversityReport(orgId: string, query: DiversityReportQueryInput) {
    const departmentIds = query.departmentIds
      ? query.departmentIds.split(",").map((id) => id.trim()).filter(Boolean)
      : [];

    const conditions: SQL[] = [eq(candidates.orgId, orgId)];

    if (query.jobId) {
      conditions.push(
        sql`${candidates.id} IN (SELECT candidate_id FROM candidate_applications WHERE job_posting_id = ${query.jobId})`,
      );
    }
    if (query.from) conditions.push(gte(candidates.createdAt, new Date(query.from)));
    if (query.to) conditions.push(lte(candidates.createdAt, new Date(query.to)));
    if (departmentIds.length > 0) {
      conditions.push(
        sql`${candidates.id} IN (SELECT candidate_id FROM candidate_applications ca JOIN job_postings jp ON jp.id = ca.job_posting_id WHERE jp.org_department_id = ANY(ARRAY[${sql.join(
          departmentIds.map((id) => sql`${id}`),
          sql`, `,
        )}]::text[]))`,
      );
    }

    const baseWhere = and(...conditions);

    const [genderRows, locationRows, sourceRows, stageRows, totalRow] = await Promise.all([
      this.db
        .select({ gender: candidates.gender, count: sql<number>`count(*)::int` })
        .from(candidates)
        .where(and(baseWhere, isNotNull(candidates.gender)))
        .groupBy(candidates.gender),
      this.db
        .select({ location: candidates.location, count: sql<number>`count(*)::int` })
        .from(candidates)
        .where(and(baseWhere, isNotNull(candidates.location)))
        .groupBy(candidates.location)
        .orderBy(sql`count(*) DESC`)
        .limit(20),
      this.db
        .select({ source: candidates.source, count: sql<number>`count(*)::int` })
        .from(candidates)
        .where(baseWhere)
        .groupBy(candidates.source)
        .orderBy(sql`count(*) DESC`),
      this.db
        .select({ status: candidates.status, count: sql<number>`count(*)::int` })
        .from(candidates)
        .where(baseWhere)
        .groupBy(candidates.status),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(candidates)
        .where(baseWhere),
    ]);

    return {
      total: totalRow[0]?.count ?? 0,
      genderBreakdown: genderRows.map((r) => ({ gender: r.gender ?? "Unknown", count: r.count })),
      locationBreakdown: locationRows.map((r) => ({ location: r.location ?? "Unknown", count: r.count })),
      sourceBreakdown: sourceRows.map((r) => ({ source: r.source ?? "Unknown", count: r.count })),
      stageBreakdown: stageRows.map((r) => ({ stage: r.status ?? "Unknown", count: r.count })),
    };
  }

  bgvCompliance(orgId: string) {
    return this.cache.cached(
      `hr:bgv-compliance:${orgId}`,
      async () => {
        const rows = await this.db
          .select({
            jobPostingId: candidateApplications.jobPostingId,
            jobTitle: jobPostings.title,
            total: count(candidateApplications.id),
            cleared: sql<number>`sum(case when ${candidates.bgvStatus} = 'CLEARED' then 1 else 0 end)::int`,
            failed: sql<number>`sum(case when ${candidates.bgvStatus} = 'FAILED' then 1 else 0 end)::int`,
            pending: sql<number>`sum(case when ${candidates.bgvStatus} = 'PENDING' then 1 else 0 end)::int`,
            initiated: sql<number>`sum(case when ${candidates.bgvStatus} = 'INITIATED' then 1 else 0 end)::int`,
            notInitiated: sql<number>`sum(case when ${candidates.bgvStatus} = 'NOT_INITIATED' or ${candidates.bgvStatus} is null then 1 else 0 end)::int`,
          })
          .from(candidateApplications)
          .innerJoin(candidates, eq(candidateApplications.candidateId, candidates.id))
          .innerJoin(jobPostings, eq(candidateApplications.jobPostingId, jobPostings.id))
          .where(and(eq(jobPostings.orgId, orgId), eq(candidates.orgId, orgId)))
          .groupBy(candidateApplications.jobPostingId, jobPostings.title);

        return rows.map((r) => ({
          jobPostingId: r.jobPostingId,
          jobTitle: r.jobTitle,
          total: r.total,
          cleared: r.cleared ?? 0,
          failed: r.failed ?? 0,
          pending: r.pending ?? 0,
          initiated: r.initiated ?? 0,
          notInitiated: r.notInitiated ?? 0,
          clearedPct: r.total > 0 ? Math.round(((r.cleared ?? 0) / r.total) * 100) : 0,
        }));
      },
      CACHE_TTL.MEDIUM,
    );
  }
}
