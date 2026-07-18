import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, gte, lt, lte, or } from "drizzle-orm";
import { buildListResponse } from "../../common/pagination/pagination";
import {
  candidateSlaTracking,
  candidates,
  interviewScorecards,
  interviewSlas,
  interviews,
  organizations,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { buildInterviewIcs } from "./ics.util";
import type { InterviewListInput, UpsertSlaInput } from "./dto/hr-interviews.schemas";

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

  listSlas(orgId: string) {
    return this.db.query.interviewSlas.findMany({
      where: eq(interviewSlas.orgId, orgId),
      orderBy: (t, { asc }) => [asc(t.stage)],
    });
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
    const records = await this.db
      .select({
        stage: candidateSlaTracking.stage,
        status: candidateSlaTracking.status,
        enteredAt: candidateSlaTracking.enteredAt,
      })
      .from(candidateSlaTracking)
      .where(eq(candidateSlaTracking.orgId, orgId))
      .orderBy(desc(candidateSlaTracking.enteredAt));

    const grouped: Record<string, Record<string, MonthStage>> = {};

    for (const record of records) {
      const month = record.enteredAt.toISOString().slice(0, 7);
      if (!grouped[month]) grouped[month] = {};
      if (!grouped[month][record.stage]) grouped[month][record.stage] = { total: 0, breached: 0 };
      grouped[month][record.stage].total++;
      if (record.status === "BREACHED") {
        grouped[month][record.stage].breached++;
      }
    }

    const now = new Date();
    const months: string[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(d.toISOString().slice(0, 7));
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
