import { desc, eq, sql, sum } from "drizzle-orm";
import { aiUsageLogs } from "../../db/schema";
import { type Db } from "../../db/drizzle.module";

export async function queryAiUsage(db: Db, orgId: string) {
  const [totals, byFeature, daily] = await Promise.all([
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
  ]);

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
  };
}
