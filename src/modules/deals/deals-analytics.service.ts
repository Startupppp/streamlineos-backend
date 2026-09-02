import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, inArray, isNull, notInArray, sql, sum } from "drizzle-orm";
import { deals, dealActivities, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import { applyScope } from "../access/apply-scope";
import type { DataScope } from "../access/access.types";
import { CrmMetadataService } from "../crm/metadata/crm-metadata.service";
import { DealsForecastService } from "./deals-forecast.service";
import type {
  CreateForecastSnapshotInput,
  CompareForecastSnapshotsInput,
  ForecastSnapshotsQueryInput,
} from "./dto/deals.schemas";

@Injectable()
export class DealsAnalyticsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly crmMetadata: CrmMetadataService,
    private readonly forecast: DealsForecastService,
  ) {}

  private async getTerminalStageKeys(orgId: string): Promise<{ wonKeys: string[]; lostKeys: string[] }> {
    const metadata = await this.crmMetadata.getAggregate(orgId);
    const wonKeys = metadata.stages
      .filter((s) => s.stageType === "won" && s.isActive)
      .map((s) => s.key);
    const lostKeys = metadata.stages
      .filter((s) => s.stageType === "lost" && s.isActive)
      .map((s) => s.key);
    return { wonKeys: wonKeys.length ? wonKeys : ["WON"], lostKeys: lostKeys.length ? lostKeys : ["LOST"] };
  }

  async getStats(orgId: string) {
    const { wonKeys, lostKeys } = await this.getTerminalStageKeys(orgId);
    const [activeRow, wonRow] = await Promise.all([
      this.db
        .select({ cnt: count(), total: sum(deals.value) })
        .from(deals)
        .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), notInArray(deals.stage, [...wonKeys, ...lostKeys]))),
      this.db
        .select({ total: sum(deals.value) })
        .from(deals)
        .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), inArray(deals.stage, wonKeys))),
    ]);
    return {
      active: activeRow[0]?.cnt ?? 0,
      pipelineValue: Number(activeRow[0]?.total ?? 0),
      wonValue: Number(wonRow[0]?.total ?? 0),
    };
  }

  async getAging(orgId: string, userId: string, scope: DataScope) {
    if (scope === "none") return { summary: { total: 0, stale: 0, critical: 0 }, deals: [] };
    return this.cache.cached(
      `deals:aging:${orgId}:${scope}:${scope === "all" ? "org" : userId}`,
      async () => {
        const { wonKeys, lostKeys } = await this.getTerminalStageKeys(orgId);
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
          .where(
            and(
              eq(deals.orgId, orgId),
              isNull(deals.deletedAt),
              notInArray(deals.stage, [...wonKeys, ...lostKeys]),
              applyScope(scope, orgId, userId, { ownerColumn: deals.assignedToId }),
            ),
          )
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
    return this.forecast.getForecast(orgId);
  }

  createForecastSnapshot(orgId: string, userId: string, input: CreateForecastSnapshotInput) {
    return this.forecast.createForecastSnapshot(orgId, userId, input);
  }

  getForecastSnapshots(orgId: string, query: ForecastSnapshotsQueryInput) {
    return this.forecast.getForecastSnapshots(orgId, query);
  }

  overrideForecastSnapshot(orgId: string, userId: string, snapshotId: string, input: { overrideAmount?: number; overrideNote?: string }) {
    return this.forecast.overrideForecastSnapshot(orgId, userId, snapshotId, input);
  }

  compareForecastSnapshots(orgId: string, input: CompareForecastSnapshotsInput) {
    return this.forecast.compareForecastSnapshots(orgId, input);
  }

  async getWinLoss(orgId: string) {
    return this.cache.cached(
      `deals:win-loss:${orgId}`,
      async () => {
        const { wonKeys, lostKeys } = await this.getTerminalStageKeys(orgId);

        const bucketTotals = (stageKeys: string[]) =>
          this.db
            .select({
              count: sql<number>`count(*)::int`,
              totalValue: sql<number>`COALESCE(SUM(${deals.value}::numeric), 0)::float`,
            })
            .from(deals)
            .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), inArray(deals.stage, stageKeys)));

        const [wonRows, lostRows, lostByReason] = await Promise.all([
          bucketTotals(wonKeys),
          bucketTotals(lostKeys),
          this.db
            .select({
              reason: sql<string>`COALESCE(${deals.lostReason}, 'Not specified')`,
              count: sql<number>`count(*)::int`,
              totalValue: sql<number>`COALESCE(SUM(${deals.value}::numeric), 0)::float`,
            })
            .from(deals)
            .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), inArray(deals.stage, lostKeys)))
            .groupBy(sql`1`)
            .orderBy(sql`2 desc`),
        ]);

        const wonRow = wonRows[0] ?? { count: 0, totalValue: 0 };
        const lostRow = lostRows[0] ?? { count: 0, totalValue: 0 };
        const total = wonRow.count + lostRow.count;
        const winRate = total > 0 ? Math.round((wonRow.count / total) * 100) : 0;

        return {
          summary: {
            won: wonRow.count,
            wonValue: wonRow.totalValue,
            lost: lostRow.count,
            lostValue: lostRow.totalValue,
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

  async getDealHealth(orgId: string, dealId: number) {
    const deal = await this.db.query.deals.findFirst({
      where: and(eq(deals.id, dealId), eq(deals.orgId, orgId), isNull(deals.deletedAt)),
      columns: { stage: true, updatedAt: true, expectedCloseDate: true, value: true, lastContactDate: true, probability: true },
      with: { activities: { columns: { createdAt: true }, orderBy: [desc(dealActivities.createdAt)], limit: 1 } },
    });
    if (!deal) throw new NotFoundException("Deal not found");

    const factors: Array<{ key: string; label: string; impact: "positive" | "negative" | "neutral"; weight: number }> = [];
    let score = 100;
    const now = Date.now();
    const daysSinceUpdate = Math.floor((now - new Date(deal.updatedAt).getTime()) / 86400000);
    const lastActivity = deal.activities[0];
    const daysSinceActivity = lastActivity
      ? Math.floor((now - new Date(lastActivity.createdAt).getTime()) / 86400000)
      : 999;

    if (daysSinceUpdate > 30) { score -= 30; factors.push({ key: "stale_30d", label: "No updates in 30+ days", impact: "negative", weight: 30 }); }
    else if (daysSinceUpdate > 14) { score -= 15; factors.push({ key: "stale_14d", label: "No updates in 14+ days", impact: "negative", weight: 15 }); }

    if (daysSinceActivity > 14) { score -= 20; factors.push({ key: "no_activity", label: "No recent activity", impact: "negative", weight: 20 }); }

    if (deal.expectedCloseDate) {
      const daysToClose = Math.floor((new Date(deal.expectedCloseDate).getTime() - now) / 86400000);
      if (daysToClose < 0) { score -= 25; factors.push({ key: "overdue", label: "Past expected close date", impact: "negative", weight: 25 }); }
      else if (daysToClose < 7) { score -= 10; factors.push({ key: "closing_soon", label: "Close date within 7 days", impact: "neutral", weight: 10 }); }
    }

    if (!deal.value || Number(deal.value) === 0) { score -= 10; factors.push({ key: "no_value", label: "No deal value set", impact: "negative", weight: 10 }); }

    const finalScore = Math.max(0, score);
    const level = finalScore >= 70 ? "healthy" : finalScore >= 40 ? "at_risk" : "critical";

    return {
      dealId,
      score: finalScore,
      level,
      factors,
      computedAt: new Date().toISOString(),
    };
  }
}
