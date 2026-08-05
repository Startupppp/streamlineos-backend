import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, gte, lt, lte, or, sql } from "drizzle-orm";
import { buildListResponse } from "../../../common/pagination/pagination";
import {
  candidateSlaTracking,
  candidates,
  interviewScorecards,
  interviewSlas,
  interviews,
  organizations,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { buildInterviewIcs } from "./ics.util";
import type {
  InterviewListInput,
  SelfInterviewListInput,
  UpsertSlaInput,
} from "./dto/hr-interviews.schemas";

interface MonthStage {
  total: number;
  breached: number;
}

@Injectable()
export class HrInterviewsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, query: InterviewListInput) {
    const conditions = [eq(interviews.orgId, orgId)];
    if (query.candidateId) conditions.push(eq(interviews.candidateId, query.candidateId));
    if (query.upcoming === "true") conditions.push(gte(interviews.scheduledAt, new Date()));
    if (query.relevant === "true") {
      const now = new Date();
      const todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date(now);
      todayEnd.setHours(23, 59, 59, 999);
      const relevanceFilter = or(
        and(gte(interviews.scheduledAt, todayStart), lte(interviews.scheduledAt, todayEnd)),
        and(eq(interviews.result, "PENDING"), lt(interviews.scheduledAt, now)),
      );
      if (relevanceFilter) conditions.push(relevanceFilter);
    }

    const where = and(...conditions);

    const [rows, totalRow] = await Promise.all([
      this.db.query.interviews.findMany({
        where,
        with: { candidate: true, interviewer: true, panelMembers: { columns: { userId: true } } },
        orderBy: [desc(interviews.scheduledAt)],
        limit: query.limit,
        offset: query.offset,
      }),
      this.db
        .select({ total: count() })
        .from(interviews)
        .where(where)
        .then((r) => r[0] ?? { total: 0 }),
    ]);

    const items = rows.map(({ panelMembers, ...iv }) => ({
      ...iv,
      panelInterviewerIds: panelMembers.map((m) => m.userId),
    }));

    return buildListResponse(items, Number(totalRow.total), {
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  async listMine(
    orgId: string,
    userId: string,
    query: SelfInterviewListInput,
  ) {
    const offset = (query.page - 1) * query.pageSize;
    const rows = await this.db.execute<{
      id: number;
      type: string;
      scheduled_at: Date;
      duration: number;
      location: string | null;
      meeting_link: string | null;
      result: "PENDING" | "PASSED" | "FAILED" | "NO_SHOW";
      candidate_first_name: string;
      candidate_last_name: string;
      job_title: string | null;
      scorecard_submitted_at: Date | null;
      total_count: string;
    }>(sql`
      SELECT
        i.id,
        i.type,
        i.scheduled_at,
        i.duration,
        i.location,
        i.meeting_link,
        i.result,
        c.first_name AS candidate_first_name,
        c.last_name AS candidate_last_name,
        jp.title AS job_title,
        sc.submitted_at AS scorecard_submitted_at,
        COUNT(*) OVER() AS total_count
      FROM interviews i
      INNER JOIN candidates c
        ON c.id = i.candidate_id AND c.org_id = ${orgId}
      LEFT JOIN job_postings jp
        ON jp.id = i.job_posting_id AND jp.org_id = ${orgId}
      LEFT JOIN interview_scorecards sc
        ON sc.interview_id = i.id AND sc.interviewer_id = ${userId}
      WHERE i.org_id = ${orgId}
        AND (
          i.interviewer_id = ${userId}
          OR EXISTS (
            SELECT 1
            FROM interview_panel_members ipm
            WHERE ipm.org_id = ${orgId}
              AND ipm.interview_id = i.id
              AND ipm.user_id = ${userId}
          )
        )
      ORDER BY i.scheduled_at DESC
      LIMIT ${query.pageSize}
      OFFSET ${offset}
    `);

    const total = Number(rows[0]?.total_count ?? 0);
    return buildListResponse(
      rows.map((row) => ({
        id: row.id,
        type: row.type,
        scheduledAt: row.scheduled_at,
        duration: row.duration,
        location: row.location,
        meetingLink: row.meeting_link,
        result: row.result,
        candidateFirstName: row.candidate_first_name,
        candidateLastName: row.candidate_last_name,
        jobTitle: row.job_title,
        scorecardSubmittedAt: row.scorecard_submitted_at,
      })),
      total,
      query,
    );
  }

  async isAssignedTo(orgId: string, userId: string, interviewId: number) {
    const rows = await this.db.execute<{ id: number }>(sql`
      SELECT i.id
      FROM interviews i
      WHERE i.org_id = ${orgId}
        AND i.id = ${interviewId}
        AND (
          i.interviewer_id = ${userId}
          OR EXISTS (
            SELECT 1
            FROM interview_panel_members ipm
            WHERE ipm.org_id = ${orgId}
              AND ipm.interview_id = i.id
              AND ipm.user_id = ${userId}
          )
        )
      LIMIT 1
    `);
    return rows.length > 0;
  }

  listSlas(orgId: string) {
    return this.db.query.interviewSlas.findMany({
      where: eq(interviewSlas.orgId, orgId),
      orderBy: (t, { asc }) => [asc(t.stage)],
      limit: 200,
    });
  }

  async stats(orgId: string) {
    const rows = await this.db
      .select({ result: interviews.result, count: sql<number>`count(*)::int` })
      .from(interviews)
      .where(eq(interviews.orgId, orgId))
      .groupBy(interviews.result);

    let total = 0;
    let pending = 0;
    let passed = 0;
    let failed = 0;
    for (const row of rows) {
      const value = Number(row.count);
      total += value;
      if (row.result === "PENDING") pending = value;
      if (row.result === "PASSED") passed = value;
      if (row.result === "FAILED") failed = value;
    }

    return { total, pending, passed, failed };
  }

  async upsertSla(orgId: string, input: UpsertSlaInput) {
    if (input.warningHours >= input.maxHours) {
      throw new BadRequestException("warningHours must be less than maxHours");
    }

    const [upserted] = await this.db
      .insert(interviewSlas)
      .values({
        orgId,
        stage: input.stage,
        maxHours: input.maxHours,
        warningHours: input.warningHours,
      })
      .onConflictDoUpdate({
        target: [interviewSlas.orgId, interviewSlas.stage],
        set: {
          maxHours: input.maxHours,
          warningHours: input.warningHours,
        },
      })
      .returning();

    return upserted;
  }

  async slaReport(orgId: string) {
    const now = new Date();
    const windowStart = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    const monthExpr = sql`date_trunc('month', ${candidateSlaTracking.enteredAt})`;
    const rows = await this.db
      .select({
        month: sql<string>`to_char(${monthExpr}, 'YYYY-MM')`,
        stage: candidateSlaTracking.stage,
        total: sql<number>`count(*)::int`,
        breached: sql<number>`sum(case when ${candidateSlaTracking.status} = 'BREACHED' then 1 else 0 end)::int`,
      })
      .from(candidateSlaTracking)
      .where(and(eq(candidateSlaTracking.orgId, orgId), gte(candidateSlaTracking.enteredAt, windowStart)))
      .groupBy(monthExpr, candidateSlaTracking.stage);

    const grouped: Record<string, Record<string, MonthStage>> = {};

    for (const row of rows) {
      if (!grouped[row.month]) grouped[row.month] = {};
      grouped[row.month][row.stage] = { total: Number(row.total), breached: Number(row.breached) };
    }

    const months: string[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    }

    const allStages = Array.from(
      new Set(Object.values(grouped).flatMap((m) => Object.keys(m))),
    ).sort();

    const report = months.map((month) => {
      const stageData = allStages.map((stage) => {
        const data = grouped[month]?.[stage] ?? { total: 0, breached: 0 };
        const breachPct = data.total > 0 ? Math.round((data.breached / data.total) * 100) : 0;
        return { stage, total: data.total, breached: data.breached, breachPct };
      });
      const totalAll = stageData.reduce((s, d) => s + d.total, 0);
      const breachedAll = stageData.reduce((s, d) => s + d.breached, 0);
      return {
        month,
        label: new Date(month + "-01").toLocaleString("en-US", { month: "short", year: "numeric" }),
        stages: stageData,
        overall: {
          total: totalAll,
          breached: breachedAll,
          breachPct: totalAll > 0 ? Math.round((breachedAll / totalAll) * 100) : 0,
        },
      };
    });

    const stageSummary = allStages.map((stage) => {
      const monthsWithData = report.filter((r) => {
        const s = r.stages.find((st) => st.stage === stage);
        return s && s.total > 0;
      });
      const avgBreachPct =
        monthsWithData.length > 0
          ? Math.round(
              monthsWithData.reduce((sum, r) => {
                const s = r.stages.find((st) => st.stage === stage);
                return sum + (s?.breachPct ?? 0);
              }, 0) / monthsWithData.length,
            )
          : 0;
      const totalBreached = report.reduce((sum, r) => {
        const s = r.stages.find((st) => st.stage === stage);
        return sum + (s?.breached ?? 0);
      }, 0);
      const totalAll = report.reduce((sum, r) => {
        const s = r.stages.find((st) => st.stage === stage);
        return sum + (s?.total ?? 0);
      }, 0);
      return { stage, avgBreachPct, totalBreached, totalAll };
    });

    return { report, stages: allStages, stageSummary };
  }

  async buildIcs(orgId: string, interviewId: number): Promise<{ ics: string; fileName: string } | null> {
    const interview = await this.db.query.interviews.findFirst({
      where: and(eq(interviews.id, interviewId), eq(interviews.orgId, orgId)),
      columns: {
        id: true,
        candidateId: true,
        interviewerId: true,
        type: true,
        scheduledAt: true,
        duration: true,
        location: true,
        meetingLink: true,
        notes: true,
      },
    });
    if (!interview) return null;

    const [candidate, interviewer, org] = await Promise.all([
      this.db.query.candidates.findFirst({
        where: eq(candidates.id, interview.candidateId),
        columns: { firstName: true, lastName: true, email: true },
      }),
      interview.interviewerId
        ? this.db.query.users.findFirst({
            where: eq(users.id, interview.interviewerId),
            columns: { name: true, email: true },
          })
        : Promise.resolve(null),
      this.db.query.organizations.findFirst({
        where: eq(organizations.id, orgId),
        columns: { name: true },
      }),
    ]);

    const candidateName = candidate
      ? `${candidate.firstName} ${candidate.lastName}`.trim()
      : "Candidate";

    return buildInterviewIcs({
      interviewId,
      orgId,
      scheduledAt: interview.scheduledAt,
      duration: interview.duration ?? 60,
      type: interview.type ?? "VIDEO",
      meetingLink: interview.meetingLink,
      notes: interview.notes,
      location: interview.location,
      candidateName,
      candidateEmail: candidate?.email ?? null,
      interviewerName: interviewer?.name ?? null,
      interviewerEmail: interviewer?.email ?? null,
      orgName: org?.name ?? "StreamlineOS",
    });
  }

  async scorecardSummary(orgId: string, interviewId: number) {
    const interview = await this.db.query.interviews.findFirst({
      where: and(eq(interviews.id, interviewId), eq(interviews.orgId, orgId)),
      columns: { id: true },
    });
    if (!interview) return null;

    const scorecards = await this.db.query.interviewScorecards.findMany({
      where: eq(interviewScorecards.interviewId, interviewId),
    });

    const submittedScorecards = scorecards.filter((sc) => sc.submittedAt !== null);

    const aggregated: Record<string, { total: number; count: number; average: number }> = {};
    for (const sc of submittedScorecards) {
      for (const [key, value] of Object.entries(sc.ratings)) {
        if (!aggregated[key]) {
          aggregated[key] = { total: 0, count: 0, average: 0 };
        }
        aggregated[key].total += value;
        aggregated[key].count += 1;
      }
    }
    for (const key of Object.keys(aggregated)) {
      const entry = aggregated[key];
      entry.average = entry.count > 0 ? entry.total / entry.count : 0;
    }

    const recommendationCounts = submittedScorecards.reduce<Record<string, number>>((acc, sc) => {
      const rec = sc.recommendation;
      acc[rec] = (acc[rec] ?? 0) + 1;
      return acc;
    }, {});

    return {
      interviewId,
      totalScorecards: scorecards.length,
      submittedCount: submittedScorecards.length,
      scorecards: submittedScorecards,
      aggregatedRatings: aggregated,
      recommendationCounts,
    };
  }
}
