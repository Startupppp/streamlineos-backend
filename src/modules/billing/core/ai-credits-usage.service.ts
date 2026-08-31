import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { aiUsageLogs, orgAiCredits } from "../../../db/schema";
import { milliToCredits } from "../../ai/core/billing/ai-model-pricing.constants";

export interface AiCreditsUsageResult {
  lifetimeConsumedCredits: number;
  lifetimeConsumedMilli: number;
  totals: {
    requests: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    credits: number;
    costUsd: number;
  };
  byFeature: Array<{
    feature: string;
    requests: number;
    totalTokens: number;
    credits: number;
    costUsd: number;
  }>;
  byModel: Array<{
    model: string;
    requests: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    credits: number;
    costUsd: number;
  }>;
  daily: Array<{
    date: string;
    requests: number;
    totalTokens: number;
    credits: number;
  }>;
}

@Injectable()
export class AiCreditsUsageService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getUsage(orgId: string, days: number): Promise<AiCreditsUsageResult> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [totalsRows, byFeatureRows, byModelRows, dailyRows, walletRows] = await Promise.all([
      this.db
        .select({
          requests: sql<number>`count(*)::int`,
          promptTokens: sql<number>`coalesce(sum(${aiUsageLogs.promptTokens}), 0)::int`,
          completionTokens: sql<number>`coalesce(sum(${aiUsageLogs.completionTokens}), 0)::int`,
          totalTokens: sql<number>`coalesce(sum(${aiUsageLogs.totalTokens}), 0)::int`,
          creditsMilli: sql<number>`coalesce(sum(${aiUsageLogs.creditsMilli}), 0)::int`,
          costUsd: sql<string>`coalesce(sum(${aiUsageLogs.estimatedCostUsd}), 0)::text`,
        })
        .from(aiUsageLogs)
        .where(and(eq(aiUsageLogs.orgId, orgId), gte(aiUsageLogs.createdAt, since))),

      this.db
        .select({
          feature: aiUsageLogs.feature,
          requests: sql<number>`count(*)::int`,
          totalTokens: sql<number>`coalesce(sum(${aiUsageLogs.totalTokens}), 0)::int`,
          creditsMilli: sql<number>`coalesce(sum(${aiUsageLogs.creditsMilli}), 0)::int`,
          costUsd: sql<string>`coalesce(sum(${aiUsageLogs.estimatedCostUsd}), 0)::text`,
        })
        .from(aiUsageLogs)
        .where(and(eq(aiUsageLogs.orgId, orgId), gte(aiUsageLogs.createdAt, since)))
        .groupBy(aiUsageLogs.feature),

      this.db
        .select({
          model: aiUsageLogs.model,
          requests: sql<number>`count(*)::int`,
          promptTokens: sql<number>`coalesce(sum(${aiUsageLogs.promptTokens}), 0)::int`,
          completionTokens: sql<number>`coalesce(sum(${aiUsageLogs.completionTokens}), 0)::int`,
          totalTokens: sql<number>`coalesce(sum(${aiUsageLogs.totalTokens}), 0)::int`,
          creditsMilli: sql<number>`coalesce(sum(${aiUsageLogs.creditsMilli}), 0)::int`,
          costUsd: sql<string>`coalesce(sum(${aiUsageLogs.estimatedCostUsd}), 0)::text`,
        })
        .from(aiUsageLogs)
        .where(and(eq(aiUsageLogs.orgId, orgId), gte(aiUsageLogs.createdAt, since)))
        .groupBy(aiUsageLogs.model),

      this.db
        .select({
          date: sql<string>`to_char(date_trunc('day', ${aiUsageLogs.createdAt}), 'YYYY-MM-DD')`,
          requests: sql<number>`count(*)::int`,
          totalTokens: sql<number>`coalesce(sum(${aiUsageLogs.totalTokens}), 0)::int`,
          creditsMilli: sql<number>`coalesce(sum(${aiUsageLogs.creditsMilli}), 0)::int`,
        })
        .from(aiUsageLogs)
        .where(and(eq(aiUsageLogs.orgId, orgId), gte(aiUsageLogs.createdAt, since)))
        .groupBy(sql`date_trunc('day', ${aiUsageLogs.createdAt})`),

      this.db
        .select({
          lifetimeConsumed: orgAiCredits.lifetimeConsumed,
        })
        .from(orgAiCredits)
        .where(eq(orgAiCredits.orgId, orgId))
        .limit(1),
    ]);

    const totalsRow = totalsRows[0];
    const lifetimeConsumedMilli = Number(walletRows[0]?.lifetimeConsumed ?? 0);

    return {
      lifetimeConsumedCredits: milliToCredits(lifetimeConsumedMilli),
      lifetimeConsumedMilli,
      totals: {
        requests: Number(totalsRow?.requests ?? 0),
        promptTokens: Number(totalsRow?.promptTokens ?? 0),
        completionTokens: Number(totalsRow?.completionTokens ?? 0),
        totalTokens: Number(totalsRow?.totalTokens ?? 0),
        credits: milliToCredits(Number(totalsRow?.creditsMilli ?? 0)),
        costUsd: Number(totalsRow?.costUsd ?? 0),
      },
      byFeature: byFeatureRows.map((r) => ({
        feature: r.feature,
        requests: Number(r.requests),
        totalTokens: Number(r.totalTokens),
        credits: milliToCredits(Number(r.creditsMilli)),
        costUsd: Number(r.costUsd),
      })),
      byModel: byModelRows.map((r) => ({
        model: r.model,
        requests: Number(r.requests),
        promptTokens: Number(r.promptTokens),
        completionTokens: Number(r.completionTokens),
        totalTokens: Number(r.totalTokens),
        credits: milliToCredits(Number(r.creditsMilli)),
        costUsd: Number(r.costUsd),
      })),
      daily: dailyRows.map((r) => ({
        date: r.date,
        requests: Number(r.requests),
        totalTokens: Number(r.totalTokens),
        credits: milliToCredits(Number(r.creditsMilli)),
      })),
    };
  }
}
