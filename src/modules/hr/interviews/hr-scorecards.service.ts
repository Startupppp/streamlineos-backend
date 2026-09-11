import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gte, gt } from "drizzle-orm";
import { interviewScorecards, interviews, scorecardTemplates, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { subDays } from "../../../common/date";
import type {
  CreateScorecardTemplateInput,
  ScorecardAnalyticsQueryInput,
  UpdateScorecardTemplateInput,
} from "./dto/hr-interviews.schemas";

interface InterviewerScore {
  interviewerId: string;
  name: string | null;
  email: string;
  totalScorecards: number;
  avgRating: number;
  recommendations: Record<string, number>;
  hireRate: number;
  hiresAfterPositive: number;
  positiveScorecards: number;
}

const SCORECARD_ANALYTICS_BATCH_SIZE = 500;

@Injectable()
export class HrScorecardsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listTemplates(orgId: string) {
    return this.db.query.scorecardTemplates.findMany({
      limit: 100,
      where: eq(scorecardTemplates.orgId, orgId),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
  }

  async createTemplate(orgId: string, userId: string, input: CreateScorecardTemplateInput) {
    const [template] = await this.db
      .insert(scorecardTemplates)
      .values({
        orgId,
        name: input.name,
        criteria: input.criteria,
        createdBy: userId,
      })
      .returning();

    return template;
  }

  async updateTemplate(orgId: string, id: number, input: UpdateScorecardTemplateInput) {
    const existing = await this.db.query.scorecardTemplates.findFirst({
      where: and(eq(scorecardTemplates.id, id), eq(scorecardTemplates.orgId, orgId)),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Template not found.");

    await this.db
      .update(scorecardTemplates)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.criteria !== undefined && { criteria: input.criteria }),
        updatedAt: new Date(),
      })
      .where(and(eq(scorecardTemplates.id, id), eq(scorecardTemplates.orgId, orgId)));

    return { success: true };
  }

  async deleteTemplate(orgId: string, id: number) {
    const [deleted] = await this.db
      .delete(scorecardTemplates)
      .where(and(eq(scorecardTemplates.id, id), eq(scorecardTemplates.orgId, orgId)))
      .returning({ id: scorecardTemplates.id });

    if (!deleted) throw new NotFoundException("Template not found.");
    return { success: true };
  }

  async analytics(orgId: string, query: ScorecardAnalyticsQueryInput) {
    const since = subDays(new Date(), query.days);

    const conditions = [
      eq(interviews.orgId, orgId),
      gte(interviewScorecards.createdAt, since),
    ];
    if (query.jobId) conditions.push(eq(interviews.jobPostingId, query.jobId));
    if (query.roundType) conditions.push(eq(interviews.type, query.roundType));

    const scorecardRows: Array<{
      interviewerId: string;
      interviewerName: string | null;
      interviewerEmail: string | null;
      recommendation: string;
      interviewResult: typeof interviews.result.enumValues[number];
      jobPostingId: number | null;
      interviewType: typeof interviews.type.enumValues[number];
      createdAt: Date;
      ratings: Record<string, number>;
    }> = [];
    let afterId: number | undefined;
    while (true) {
      const rows = await this.db
        .select({
          id: interviewScorecards.id,
          interviewerId: interviewScorecards.interviewerId,
          interviewerName: users.name,
          interviewerEmail: users.email,
          recommendation: interviewScorecards.recommendation,
          interviewResult: interviews.result,
          jobPostingId: interviews.jobPostingId,
          interviewType: interviews.type,
          createdAt: interviewScorecards.createdAt,
          ratings: interviewScorecards.ratings,
        })
        .from(interviewScorecards)
        .innerJoin(interviews, eq(interviewScorecards.interviewId, interviews.id))
        .innerJoin(users, eq(interviewScorecards.interviewerId, users.id))
        .where(and(...conditions, afterId ? gt(interviewScorecards.id, afterId) : undefined))
        .orderBy(asc(interviewScorecards.id))
        .limit(SCORECARD_ANALYTICS_BATCH_SIZE);

      if (rows.length === 0) break;
      scorecardRows.push(...rows);
      afterId = rows[rows.length - 1]!.id;
      if (rows.length < SCORECARD_ANALYTICS_BATCH_SIZE) break;
    }

    const byInterviewer = new Map<string, InterviewerScore>();

    for (const row of scorecardRows) {
      const existing = byInterviewer.get(row.interviewerId) ?? {
        interviewerId: row.interviewerId,
        name: row.interviewerName,
        email: row.interviewerEmail ?? "",
        totalScorecards: 0,
        avgRating: 0,
        recommendations: {},
        hireRate: 0,
        hiresAfterPositive: 0,
        positiveScorecards: 0,
      };
      existing.totalScorecards += 1;

      const ratingsObj = row.ratings ?? {};
      const ratingValues = Object.values(ratingsObj);
      const avgR =
        ratingValues.length > 0 ? ratingValues.reduce((s, v) => s + v, 0) / ratingValues.length : 0;
      existing.avgRating =
        (existing.avgRating * (existing.totalScorecards - 1) + avgR) / existing.totalScorecards;

      const rec = row.recommendation;
      existing.recommendations[rec] = (existing.recommendations[rec] ?? 0) + 1;

      if (rec === "HIRE" || rec === "STRONG_HIRE") {
        existing.positiveScorecards += 1;
        if (row.interviewResult === "PASSED") existing.hiresAfterPositive += 1;
      }

      existing.hireRate =
        existing.positiveScorecards > 0
          ? (existing.hiresAfterPositive / existing.positiveScorecards) * 100
          : 0;

      byInterviewer.set(row.interviewerId, existing);
    }

    const interviewerStats = Array.from(byInterviewer.values()).map((s) => ({
      ...s,
      avgRating: Math.round(s.avgRating * 10) / 10,
      hireRate: Math.round(s.hireRate),
    }));

    const orgAvgRating = interviewerStats.length
      ? interviewerStats.reduce((s, r) => s + r.avgRating, 0) / interviewerStats.length
      : 0;

    const scoreDistribution = [
      { range: "0–2", count: 0 },
      { range: "2–4", count: 0 },
      { range: "4–6", count: 0 },
      { range: "6–8", count: 0 },
      { range: "8–10", count: 0 },
    ];
    for (const row of scorecardRows) {
      const ratingsObj = row.ratings ?? {};
      const vals = Object.values(ratingsObj);
      if (!vals.length) continue;
      const avg2 = vals.reduce((s, v) => s + v, 0) / vals.length;
      const bucketIdx = Math.min(4, Math.floor(avg2 / 2));
      scoreDistribution[bucketIdx].count += 1;
    }

    return {
      interviewerStats,
      orgAvgRating: Math.round(orgAvgRating * 10) / 10,
      totalScorecards: scorecardRows.length,
      scoreDistribution,
      period: { days: query.days, since: since.toISOString() },
    };
  }
}
