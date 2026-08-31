import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull, notInArray } from "drizzle-orm";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { keysetBefore } from "../../common/pagination/keyset";
import { deals, crmForecastSnapshots } from "../../db/schema";
import type { ForecastSnapshotData } from "../../db/schema/crm/deals";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { CrmMetadataService } from "../crm/metadata/crm-metadata.service";
import type {
  CreateForecastSnapshotInput,
  CompareForecastSnapshotsInput,
  ForecastSnapshotsQueryInput,
} from "./dto/deals.schemas";

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
export class DealsForecastService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly crmMetadata: CrmMetadataService,
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

  getForecast(orgId: string) {
    return this.cache.cached(
      CACHE_KEYS.dealsForecast(orgId),
      () => this.buildForecast(orgId),
      CACHE_TTL.MEDIUM,
    );
  }

  private async buildForecast(orgId: string): Promise<ForecastSummary> {
    const { wonKeys, lostKeys } = await this.getTerminalStageKeys(orgId);
    const metaRaw = await this.crmMetadata.getAggregate(orgId);
    const stageProbMap = new Map<string, number>(
      metaRaw.stages
        .filter((s) => s.isActive)
        .map((s) => [s.key, s.probability]),
    );

    const allDeals = await this.db
      .select({
        value: deals.value,
        stage: deals.stage,
        probability: deals.probability,
        expectedCloseDate: deals.expectedCloseDate,
        createdAt: deals.createdAt,
      })
      .from(deals)
      .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), notInArray(deals.stage, [...wonKeys, ...lostKeys])))
      .limit(10000);

    const monthMap = new Map<string, ForecastMonth>();
    const stageMap = new Map<string, { count: number; totalValue: number; weightedValue: number; probSum: number }>();

    for (const deal of allDeals) {
      const value = Number(deal.value ?? 0);
      const probability = deal.probability || stageProbMap.get(deal.stage) || 20;
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

  async createForecastSnapshot(orgId: string, userId: string, input: CreateForecastSnapshotInput) {
    const forecast = await this.getForecast(orgId);
    const data: ForecastSnapshotData = {
      byCategory: [],
      byRep: [],
      totalWeighted: forecast.totalWeighted,
      totalBestCase: forecast.totalBestCase,
      totalDeals: forecast.totalDeals,
      period: input.period,
    };
    const [row] = await this.db.insert(crmForecastSnapshots).values({
      orgId, period: input.period, createdById: userId, data,
    }).returning();
    return row;
  }

  async getForecastSnapshots(orgId: string, query: ForecastSnapshotsQueryInput) {
    const limit = query.limit ?? 20;
    const position = decodeCursor(query.cursor);
    const baseConditions = [eq(crmForecastSnapshots.orgId, orgId)];
    if (query.period) baseConditions.push(eq(crmForecastSnapshots.period, query.period));
    const where = position
      ? and(...baseConditions, keysetBefore(crmForecastSnapshots.capturedAt, crmForecastSnapshots.id, position))
      : and(...baseConditions);
    const rows = await this.db
      .select()
      .from(crmForecastSnapshots)
      .where(where)
      .orderBy(desc(crmForecastSnapshots.capturedAt), desc(crmForecastSnapshots.id))
      .limit(limit + 1);
    const cursorPage = buildCursorPage(rows, limit, (row) => ({
      sortValue: row.capturedAt.toISOString(),
      id: row.id,
    }));
    return { snapshots: cursorPage.data, hasMore: cursorPage.pagination.hasMore, nextCursor: cursorPage.pagination.nextCursor };
  }

  async overrideForecastSnapshot(
    orgId: string,
    userId: string,
    snapshotId: string,
    input: { overrideAmount?: number; overrideNote?: string },
  ) {
    const existing = await this.db.query.crmForecastSnapshots.findFirst({
      where: and(eq(crmForecastSnapshots.id, snapshotId), eq(crmForecastSnapshots.orgId, orgId)),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Forecast snapshot not found");

    const [updated] = await this.db
      .update(crmForecastSnapshots)
      .set({
        overrideAmount: input.overrideAmount !== undefined ? String(input.overrideAmount) : undefined,
        overrideNote: input.overrideNote,
        overriddenBy: userId,
      })
      .where(and(eq(crmForecastSnapshots.id, snapshotId), eq(crmForecastSnapshots.orgId, orgId)))
      .returning();
    return updated;
  }

  async compareForecastSnapshots(orgId: string, input: CompareForecastSnapshotsInput) {
    const snapshot = await this.db.query.crmForecastSnapshots.findFirst({
      where: and(eq(crmForecastSnapshots.orgId, orgId), eq(crmForecastSnapshots.period, input.period)),
      orderBy: [desc(crmForecastSnapshots.capturedAt)],
    });
    if (!snapshot) throw new NotFoundException(`No snapshot found for period ${input.period}`);
    const baseline = snapshot.data;
    const current = await this.buildForecast(orgId);
    const currentData: ForecastSnapshotData = {
      byCategory: [],
      byRep: [],
      totalWeighted: current.totalWeighted,
      totalBestCase: current.totalBestCase,
      totalDeals: current.totalDeals,
      period: input.period,
    };
    return {
      period: input.period,
      baseline,
      current: currentData,
      delta: {
        totalWeighted: currentData.totalWeighted - baseline.totalWeighted,
        totalBestCase: currentData.totalBestCase - baseline.totalBestCase,
        totalDeals: currentData.totalDeals - baseline.totalDeals,
        byCategory: [],
      },
    };
  }
}
