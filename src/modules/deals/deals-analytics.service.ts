import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, ne, notInArray, sql, sum } from "drizzle-orm";
import { deals, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";

const STAGE_PROBABILITIES: Record<string, number> = {
  LEAD: 10,
  PROSPECT: 20,
  QUALIFICATION: 30,
  PROPOSAL: 50,
  NEGOTIATION: 70,
  CLOSING: 85,
  WON: 100,
  LOST: 0,
};

export interface ForecastMonth {
  month: string;
  label: string;
  weighted: number;
  bestCase: number;
  dealCount: number;
}

export interface ForecastSummary {
  totalWeighted: number;
  totalBestCase: number;
  totalDeals: number;
  byMonth: ForecastMonth[];
  byStage: Array<{
    stage: string;
    count: number;
    totalValue: number;
    weightedValue: number;
    avgProbability: number;
  }>;
}

@Injectable()
export class DealsAnalyticsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async getStats(orgId: string) {
    const [activeRow, wonRow] = await Promise.all([
      this.db
        .select({ cnt: count(), total: sum(deals.value) })
        .from(deals)
        .where(and(eq(deals.orgId, orgId), ne(deals.stage, "WON"), ne(deals.stage, "LOST"))),
      this.db
        .select({ total: sum(deals.value) })
        .from(deals)
        .where(and(eq(deals.orgId, orgId), eq(deals.stage, "WON"))),
    ]);
    return {
      active: activeRow[0]?.cnt ?? 0,
      pipelineValue: Number(activeRow[0]?.total ?? 0),
      wonValue: Number(wonRow[0]?.total ?? 0),
    };
  }

  getAging(orgId: string) {
    return this.cache.cached(
      `deals:aging:${orgId}`,
      async () => {
        const allDeals = await this.db
          .select({
            id: deals.id,
            name: deals.name,
            value: deals.value,
            stage: deals.stage,
            updatedAt: deals.updatedAt,
            createdAt: deals.createdAt,
            assignedToId: deals.assignedToId,
            assigneeName: users.name,
          })
          .from(deals)
          .leftJoin(users, eq(deals.assignedToId, users.id))
          .where(and(eq(deals.orgId, orgId), notInArray(deals.stage, ["WON", "LOST"])))
          .orderBy(sql`${deals.updatedAt} asc`)
          .limit(100);

        const now = Date.now();
        const enriched = allDeals.map((d) => {
          const updated = d.updatedAt ? new Date(d.updatedAt).getTime() : now;
          const daysInStage = Math.floor((now - updated) / (1000 * 60 * 60 * 24));
          return {
            ...d,
            daysInStage,
            isStale: daysInStage > 14,
            isCritical: daysInStage > 30,
          };
        });

        const stale = enriched.filter((d) => d.isStale).length;
        const critical = enriched.filter((d) => d.isCritical).length;

        return {
          summary: { total: enriched.length, stale, critical },
          deals: enriched,
        };
      },
      CACHE_TTL.MEDIUM,
    );
  }

  getForecast(orgId: string) {
    return this.cache.cached(
      CACHE_KEYS.dealsForecast(orgId),
      () => this.buildForecast(orgId),
      CACHE_TTL.MEDIUM,
    );
  }

  private async buildForecast(orgId: string): Promise<ForecastSummary> {
    const allDeals = await this.db
      .select({
        value: deals.value,
        stage: deals.stage,
        probability: deals.probability,
        expectedCloseDate: deals.expectedCloseDate,
        createdAt: deals.createdAt,
      })
      .from(deals)
      .where(and(eq(deals.orgId, orgId), notInArray(deals.stage, ["WON", "LOST"])));

    const monthMap = new Map<string, ForecastMonth>();
    const stageMap = new Map<string, { count: number; totalValue: number; weightedValue: number; probSum: number }>();

    for (const deal of allDeals) {
      const value = Number(deal.value ?? 0);
      const probability = deal.probability || STAGE_PROBABILITIES[deal.stage] || 20;
      const weighted = Math.round((value * probability) / 100);

      const closeDate = deal.expectedCloseDate
        ? new Date(deal.expectedCloseDate)
        : deal.createdAt
          ? new Date(new Date(deal.createdAt).getTime() + 90 * 24 * 60 * 60 * 1000)
          : new Date();

      const monthKey = `${closeDate.getFullYear()}-${String(closeDate.getMonth() + 1).padStart(2, "0")}`;
      const monthLabel = closeDate.toLocaleDateString("en-IN", { month: "short", year: "numeric" });

      const existing = monthMap.get(monthKey) ?? { month: monthKey, label: monthLabel, weighted: 0, bestCase: 0, dealCount: 0 };
      existing.weighted += weighted;
      existing.bestCase += value;
      existing.dealCount += 1;
      monthMap.set(monthKey, existing);

      const stageData = stageMap.get(deal.stage) ?? { count: 0, totalValue: 0, weightedValue: 0, probSum: 0 };
      stageData.count += 1;
      stageData.totalValue += value;
      stageData.weightedValue += weighted;
      stageData.probSum += probability;
      stageMap.set(deal.stage, stageData);
    }

    const byMonth = [...monthMap.values()].sort((a, b) => a.month.localeCompare(b.month));
    const byStage = [...stageMap.entries()].map(([stage, data]) => ({
      stage,
      count: data.count,
      totalValue: data.totalValue,
      weightedValue: data.weightedValue,
      avgProbability: data.count > 0 ? Math.round(data.probSum / data.count) : 0,
    }));

    return {
      totalWeighted: byMonth.reduce((s, m) => s + m.weighted, 0),
      totalBestCase: byMonth.reduce((s, m) => s + m.bestCase, 0),
      totalDeals: allDeals.length,
      byMonth,
      byStage,
    };
  }

  getWinLoss(orgId: string) {
    return this.cache.cached(
      `deals:win-loss:${orgId}`,
      async () => {
        const wonDeals = await this.db
          .select({
            count: sql<number>`count(*)::int`,
            totalValue: sql<number>`COALESCE(SUM(${deals.value}::numeric), 0)::float`,
          })
          .from(deals)
          .where(and(eq(deals.orgId, orgId), eq(deals.stage, "WON")));

        const lostDeals = await this.db
          .select({
            count: sql<number>`count(*)::int`,
            totalValue: sql<number>`COALESCE(SUM(${deals.value}::numeric), 0)::float`,
          })
          .from(deals)
          .where(and(eq(deals.orgId, orgId), eq(deals.stage, "LOST")));

        const lostByReason = await this.db
          .select({
            reason: sql<string>`COALESCE(${deals.lostReason}, 'Not specified')`,
            count: sql<number>`count(*)::int`,
            totalValue: sql<number>`COALESCE(SUM(${deals.value}::numeric), 0)::float`,
          })
          .from(deals)
          .where(and(eq(deals.orgId, orgId), eq(deals.stage, "LOST")))
          .groupBy(sql`COALESCE(${deals.lostReason}, 'Not specified')`)
          .orderBy(sql`count(*) desc`);

        const won = wonDeals[0] ?? { count: 0, totalValue: 0 };
        const lost = lostDeals[0] ?? { count: 0, totalValue: 0 };
        const total = won.count + lost.count;
        const winRate = total > 0 ? Math.round((won.count / total) * 100) : 0;

        return {
          summary: {
            won: won.count,
            wonValue: won.totalValue,
            lost: lost.count,
            lostValue: lost.totalValue,
            total,
            winRate,
          },
          lostByReason: lostByReason.map((r) => ({
            reason: r.reason,
            count: r.count,
            totalValue: r.totalValue,
          })),
        };
      },
      CACHE_TTL.MEDIUM,
    );
  }
}
