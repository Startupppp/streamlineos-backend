import { desc, eq, sql, sum } from "drizzle-orm";
import { aiUsageLogs } from "../../db/schema";
import { aiFeedback } from "../../db/schema/ai/ai-feedback";
import { supportAiSuggestions } from "../../db/schema/support/support-ai";
import { type Db } from "../../db/drizzle.module";

export async function queryAiUsage(db: Db, orgId: string) {
  const [totals, byFeature, daily, latencyStats, feedbackByFeature, suggestionCounts] = await Promise.all([
    db
      .select({
        totalTokens: sum(aiUsageLogs.totalTokens).mapWith(Number),
        promptTokens: sum(aiUsageLogs.promptTokens).mapWith(Number),
        completionTokens: sum(aiUsageLogs.completionTokens).mapWith(Number),
        estimatedCostUsd: sql<string>`COALESCE(SUM(${aiUsageLogs.estimatedCostUsd}), 0)::text`,
        requestCount: sql<number>`COUNT(*)::int`,
      })
      .from(aiUsageLogs)
      .where(eq(aiUsageLogs.orgId, orgId)),

    db
      .select({
        feature: aiUsageLogs.feature,
        model: aiUsageLogs.model,
        totalTokens: sum(aiUsageLogs.totalTokens).mapWith(Number),
        estimatedCostUsd: sql<string>`COALESCE(SUM(${aiUsageLogs.estimatedCostUsd}), 0)::text`,
        requestCount: sql<number>`COUNT(*)::int`,
      })
      .from(aiUsageLogs)
      .where(eq(aiUsageLogs.orgId, orgId))
      .groupBy(aiUsageLogs.feature, aiUsageLogs.model)
      .orderBy(desc(sql`SUM(${aiUsageLogs.totalTokens})`)),

    db
      .select({
        date: sql<string>`DATE(${aiUsageLogs.createdAt})::text`,
        totalTokens: sum(aiUsageLogs.totalTokens).mapWith(Number),
        estimatedCostUsd: sql<string>`COALESCE(SUM(${aiUsageLogs.estimatedCostUsd}), 0)::text`,
        requestCount: sql<number>`COUNT(*)::int`,
      })
      .from(aiUsageLogs)
      .where(eq(aiUsageLogs.orgId, orgId))
      .groupBy(sql`DATE(${aiUsageLogs.createdAt})`)
      .orderBy(desc(sql`DATE(${aiUsageLogs.createdAt})`))
      .limit(30),

    db
      .select({
        avgLatencyMs: sql<number | null>`AVG(${aiUsageLogs.latencyMs})::float`,
        p95LatencyMs: sql<number | null>`PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ${aiUsageLogs.latencyMs})::float`,
        errorRate: sql<number>`(COUNT(*) FILTER (WHERE ${aiUsageLogs.outcome} != 'ok' AND ${aiUsageLogs.outcome} IS NOT NULL)::float / NULLIF(COUNT(*), 0))::float`,
      })
      .from(aiUsageLogs)
      .where(eq(aiUsageLogs.orgId, orgId)),

    db
      .select({
        feature: aiFeedback.feature,
        up: sql<number>`COUNT(*) FILTER (WHERE ${aiFeedback.rating} = 'UP')::int`,
        down: sql<number>`COUNT(*) FILTER (WHERE ${aiFeedback.rating} = 'DOWN')::int`,
        total: sql<number>`COUNT(*)::int`,
      })
      .from(aiFeedback)
      .where(eq(aiFeedback.orgId, orgId))
      .groupBy(aiFeedback.feature),

    db
      .select({
        accepted: sql<number>`COUNT(*) FILTER (WHERE ${supportAiSuggestions.status} = 'accepted')::int`,
        rejected: sql<number>`COUNT(*) FILTER (WHERE ${supportAiSuggestions.status} = 'rejected')::int`,
        pending: sql<number>`COUNT(*) FILTER (WHERE ${supportAiSuggestions.status} = 'pending')::int`,
      })
      .from(supportAiSuggestions)
      .where(eq(supportAiSuggestions.orgId, orgId)),
  ]);

  const latency = latencyStats[0] ?? { avgLatencyMs: null, p95LatencyMs: null, errorRate: 0 };
  const suggestions = suggestionCounts[0] ?? { accepted: 0, rejected: 0, pending: 0 };

  return {
    totals: totals[0] ?? {
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      estimatedCostUsd: "0",
      requestCount: 0,
    },
    byFeature,
    daily,
    performance: {
      avgLatencyMs: latency.avgLatencyMs ?? null,
      p95LatencyMs: latency.p95LatencyMs ?? null,
      errorRate: latency.errorRate ?? 0,
    },
    acceptance: {
      feedbackByFeature: feedbackByFeature.map((r) => ({
        feature: r.feature,
        up: r.up,
        down: r.down,
        total: r.total,
        ratio: r.total > 0 ? Number((r.up / r.total).toFixed(4)) : null,
      })),
      supportSuggestions: {
        accepted: suggestions.accepted,
        rejected: suggestions.rejected,
        pending: suggestions.pending,
      },
    },
  };
}
