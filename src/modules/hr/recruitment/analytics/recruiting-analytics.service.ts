import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import {
  candidateApplications,
  candidateOffers,
  candidates,
  interviews,
  jobPostings,
  organizationMembers,
  users,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import {
  buildFunnel,
  offerAcceptRate,
  percentiles,
  sourcePerformance,
  type FunnelStep,
  type Percentiles,
  type SourcePerformance,
} from "./funnel-math";

export interface AnalyticsWindow {
  from: Date;
  to: Date;
}

export interface InterviewerLoad {
  membershipId: number;
  name: string;
  scheduled: number;
  completed: number;
}

export interface RecruitingAnalytics {
  window: { from: Date; to: Date };
  funnel: FunnelStep[];
  timeToFillDays: Percentiles;
  sources: SourcePerformance[];
  interviewerLoad: InterviewerLoad[];
  offers: { accepted: number; declined: number; outstanding: number; acceptRate: number | null };
  /**
   * True when nothing in the window produced a single row.
   *
   * Carried explicitly so a screen can say "no applications in this period"
   * rather than rendering five charts of zero, which reads as a broken
   * dashboard rather than a quiet quarter.
   */
  empty: boolean;
}

@Injectable()
export class RecruitingAnalyticsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async forWindow(orgId: string, window: AnalyticsWindow): Promise<RecruitingAnalytics> {
    const [funnelCounts, fillDays, sources, load, offers] = await Promise.all([
      this.funnelCounts(orgId, window),
      this.timeToFillDays(orgId, window),
      this.sourceCounts(orgId, window),
      this.interviewerLoad(orgId, window),
      this.offerCounts(orgId, window),
    ]);

    const funnel = buildFunnel(funnelCounts);
    return {
      window: { from: window.from, to: window.to },
      funnel,
      timeToFillDays: percentiles(fillDays),
      sources: sourcePerformance(sources),
      interviewerLoad: load,
      offers: {
        ...offers,
        acceptRate: offerAcceptRate(offers.accepted, offers.declined),
      },
      empty:
        (funnelCounts[0]?.count ?? 0) === 0 &&
        sources.length === 0 &&
        load.length === 0 &&
        offers.accepted + offers.declined + offers.outstanding === 0,
    };
  }

  /**
   * The funnel, counted from applications rather than from candidate status.
   *
   * A candidate's own `status` is a single value that moves, so counting it
   * gives the shape of the pipeline right now and loses everyone who passed
   * through. Applications are per job and keep their terminal status, which is
   * what a conversion rate is actually about.
   */
  private async funnelCounts(orgId: string, window: AnalyticsWindow) {
    const [row] = await this.db
      .select({
        applied: sql<number>`count(*)::int`,
        screened: sql<number>`count(*) filter (where ${candidateApplications.status} <> 'APPLIED')::int`,
        interviewed: sql<number>`count(*) filter (where ${candidateApplications.status} in ('INTERVIEWING','OFFERED','ACCEPTED'))::int`,
        offered: sql<number>`count(*) filter (where ${candidateApplications.status} in ('OFFERED','ACCEPTED'))::int`,
        hired: sql<number>`count(*) filter (where ${candidateApplications.status} = 'ACCEPTED')::int`,
      })
      .from(candidateApplications)
      .where(
        and(
          eq(candidateApplications.orgId, orgId),
          gte(candidateApplications.appliedAt, window.from),
          lte(candidateApplications.appliedAt, window.to),
        ),
      );

    /*
      The stages are cumulative and nested on purpose — everyone offered was
      also interviewed. A funnel built from mutually exclusive buckets would
      show conversions above 100% as soon as somebody skipped a stage, which
      happens constantly with internal candidates.
    */
    return [
      { stage: "Applied", count: row?.applied ?? 0 },
      { stage: "Screened", count: row?.screened ?? 0 },
      { stage: "Interviewed", count: row?.interviewed ?? 0 },
      { stage: "Offered", count: row?.offered ?? 0 },
      { stage: "Hired", count: row?.hired ?? 0 },
    ];
  }

  /** Days from a job opening to its first accepted offer, per job. */
  private async timeToFillDays(orgId: string, window: AnalyticsWindow): Promise<number[]> {
    const rows = await this.db
      .select({
        days: sql<number>`extract(epoch from (min(${candidateApplications.updatedAt}) - ${jobPostings.createdAt})) / 86400`,
      })
      .from(candidateApplications)
      .innerJoin(
        jobPostings,
        and(
          eq(jobPostings.orgId, candidateApplications.orgId),
          eq(jobPostings.id, candidateApplications.jobPostingId),
        ),
      )
      .where(
        and(
          eq(candidateApplications.orgId, orgId),
          eq(candidateApplications.status, "ACCEPTED"),
          gte(candidateApplications.updatedAt, window.from),
          lte(candidateApplications.updatedAt, window.to),
        ),
      )
      .groupBy(jobPostings.id, jobPostings.createdAt)
      .limit(1000);

    /*
      Negative values are dropped rather than clamped to zero. They mean the
      job row was created after the hire — a backfilled requisition — and a
      zero-day fill in the median would make the whole distribution a lie.
    */
    return rows.map((row) => Math.round(Number(row.days))).filter((days) => days >= 0);
  }

  private async sourceCounts(orgId: string, window: AnalyticsWindow) {
    const rows = await this.db
      .select({
        source: candidates.source,
        applicants: sql<number>`count(distinct ${candidateApplications.id})::int`,
        hires: sql<number>`count(distinct ${candidateApplications.id}) filter (where ${candidateApplications.status} = 'ACCEPTED')::int`,
      })
      .from(candidateApplications)
      .innerJoin(
        candidates,
        and(
          eq(candidates.orgId, candidateApplications.orgId),
          eq(candidates.id, candidateApplications.candidateId),
        ),
      )
      .where(
        and(
          eq(candidateApplications.orgId, orgId),
          gte(candidateApplications.appliedAt, window.from),
          lte(candidateApplications.appliedAt, window.to),
        ),
      )
      .groupBy(candidates.source)
      .limit(50);

    return rows.map((row) => ({
      source: row.source,
      applicants: row.applicants,
      hires: row.hires,
    }));
  }

  private async interviewerLoad(
    orgId: string,
    window: AnalyticsWindow,
  ): Promise<InterviewerLoad[]> {
    const rows = await this.db
      .select({
        membershipId: interviews.interviewerMembershipId,
        firstName: users.firstName,
        lastName: users.lastName,
        scheduled: sql<number>`count(*)::int`,
        completed: sql<number>`count(*) filter (where ${interviews.result} <> 'PENDING')::int`,
      })
      .from(interviews)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, interviews.orgId),
          eq(organizationMembers.id, interviews.interviewerMembershipId),
        ),
      )
      /*
        A minimal projection of `users`, never the whole relation: that table
        still carries authentication secrets and legacy payroll fields, and this
        needs two names to render a bar chart label.
      */
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(
        and(
          eq(interviews.orgId, orgId),
          gte(interviews.scheduledAt, window.from),
          lte(interviews.scheduledAt, window.to),
        ),
      )
      .groupBy(interviews.interviewerMembershipId, users.firstName, users.lastName)
      .orderBy(sql`count(*) desc`)
      .limit(50);

    return rows
      .filter((row): row is typeof row & { membershipId: number } => row.membershipId !== null)
      .map((row) => ({
        membershipId: row.membershipId,
        name: [row.firstName, row.lastName].filter(Boolean).join(" ") || "Unnamed interviewer",
        scheduled: row.scheduled,
        completed: row.completed,
      }));
  }

  private async offerCounts(orgId: string, window: AnalyticsWindow) {
    const [row] = await this.db
      .select({
        accepted: sql<number>`count(*) filter (where ${candidateOffers.offerStatus} = 'ACCEPTED')::int`,
        declined: sql<number>`count(*) filter (where ${candidateOffers.offerStatus} = 'DECLINED')::int`,
        outstanding: sql<number>`count(*) filter (where ${candidateOffers.offerStatus} = 'SENT')::int`,
      })
      .from(candidateOffers)
      .where(
        and(
          eq(candidateOffers.orgId, orgId),
          gte(candidateOffers.createdAt, window.from),
          lte(candidateOffers.createdAt, window.to),
        ),
      );

    return {
      accepted: row?.accepted ?? 0,
      declined: row?.declined ?? 0,
      outstanding: row?.outstanding ?? 0,
    };
  }
}
