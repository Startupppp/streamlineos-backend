import { Inject, Injectable } from "@nestjs/common";
import { eq, and, gte, lte, count, sql, isNotNull, ne, lt } from "drizzle-orm";
import { crmDeals, salesQuotas } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";

export interface DateRange {
  from?: Date;
  to?: Date;
}

export interface SalesDashboardKPIs {
  totalRevenue: number;
  pipelineValue: number;
  closeRate: number;
  avgDealSize: number;
  dealsWon: number;
  totalDeals: number;
  prevRevenue: number;
  prevCloseRate: number;
  prevAvgDealSize: number;
}

export interface SalesFunnelStage {
  stage: string;
  count: number;
  value: number;
  color: string;
  dropOffPct: number | null;
}

export interface SalesLeaderboardEntry {
  repId: number;
  name: string;
  initials: string;
  dealsWon: number;
  totalDeals: number;
  revenue: number;
  winRate: number;
}

export interface RevenueVsGoalEntry {
  month: string;
  actual: number;
  target: number;
}

export interface DealVelocityMetrics {
  avgDaysToClose: number;
  medianDaysToClose: number;
  fastestCloseDays: number;
  slowestCloseDays: number;
  dealCount: number;
}

export interface AgingDeal {
  id: number;
  companyName: string;
  stage: string;
  value: number;
  daysSinceUpdate: number;
  salesRepId: number | null;
}

const STAGE_ORDER = ["Discovery", "Qualified", "Proposal", "Negotiation", "Closed Won"] as const;
const STAGE_COLORS: Record<string, string> = {
  Discovery: "#3B82F6",
  Qualified: "#6366F1",
  Proposal: "#8B5CF6",
  Negotiation: "#A855F7",
  "Closed Won": "#10B981",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shiftRange(range: DateRange): DateRange {
  if (!range.from || !range.to) return {};
  const diff = range.to.getTime() - range.from.getTime();
  return {
    from: new Date(range.from.getTime() - diff),
    to: new Date(range.from.getTime() - 1),
  };
}

@Injectable()
export class SalesDashboardService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  private dealFilter(orgId: string, range: DateRange, repId?: number) {
    const conditions = [eq(crmDeals.orgId, orgId)];
    if (range.from) conditions.push(gte(crmDeals.createdAt, range.from));
    if (range.to) conditions.push(lte(crmDeals.createdAt, range.to));
    if (repId) conditions.push(eq(crmDeals.salesRepId, repId));
    return conditions.length === 1 ? conditions[0] : and(...conditions);
  }

  getKpis(orgId: string, range: DateRange = {}, repId?: number): Promise<SalesDashboardKPIs> {
    return this.cache.cachedVersioned(
      CACHE_KEYS.salesKpisNamespace(orgId),
      CACHE_KEYS.salesKpisSubKey(range.from?.toISOString() ?? "", range.to?.toISOString() ?? "", String(repId ?? "")),
      () => this.computeKpis(orgId, range, repId),
      CACHE_TTL.MEDIUM,
    );
  }

  private async computeKpis(orgId: string, range: DateRange, repId?: number): Promise<SalesDashboardKPIs> {
    const prevRange = shiftRange(range);

    const [stageAggs, prevAggs] = await Promise.all([
      this.db
        .select({
          stage: crmDeals.stage,
          dealCount: count(),
          totalValue: sql<number>`COALESCE(sum(${crmDeals.value}::numeric), 0)::float`,
        })
        .from(crmDeals)
        .where(this.dealFilter(orgId, range, repId))
        .groupBy(crmDeals.stage),

      prevRange.from
        ? this.db
            .select({
              stage: crmDeals.stage,
              dealCount: count(),
              totalValue: sql<number>`COALESCE(sum(${crmDeals.value}::numeric), 0)::float`,
            })
            .from(crmDeals)
            .where(this.dealFilter(orgId, prevRange, repId))
            .groupBy(crmDeals.stage)
        : Promise.resolve([]),
    ]);

    const stageMap = new Map(stageAggs.map((r) => [r.stage, r]));
    const prevMap = new Map(prevAggs.map((r) => [r.stage, r]));

    const closedWon = stageMap.get("Closed Won");
    const totalDeals = stageAggs.reduce((s, r) => s + r.dealCount, 0);
    const dealsWon = closedWon?.dealCount ?? 0;
    const totalRevenue = closedWon?.totalValue ?? 0;
    const pipelineValue = stageAggs.reduce((s, r) => s + r.totalValue, 0);
    const closeRate = totalDeals > 0 ? (dealsWon / totalDeals) * 100 : 0;
    const avgDealSize = dealsWon > 0 ? totalRevenue / dealsWon : 0;

    const prevClosedWon = prevMap.get("Closed Won");
    const prevTotalDeals = prevAggs.reduce((s, r) => s + r.dealCount, 0);
    const prevDealsWon = prevClosedWon?.dealCount ?? 0;
    const prevRevenue = prevClosedWon?.totalValue ?? 0;
    const prevCloseRate = prevTotalDeals > 0 ? (prevDealsWon / prevTotalDeals) * 100 : 0;
    const prevAvgDealSize = prevDealsWon > 0 ? prevRevenue / prevDealsWon : 0;

    return {
      totalRevenue,
      pipelineValue,
      closeRate: Math.round(closeRate * 10) / 10,
      avgDealSize: Math.round(avgDealSize),
      dealsWon,
      totalDeals,
      prevRevenue,
      prevCloseRate: Math.round(prevCloseRate * 10) / 10,
      prevAvgDealSize: Math.round(prevAvgDealSize),
    };
  }

  getFunnel(orgId: string, range: DateRange = {}, repId?: number): Promise<SalesFunnelStage[]> {
    const cacheKey = `sales:funnel:${orgId}:${range.from?.toISOString() ?? ""}:${range.to?.toISOString() ?? ""}:${repId ?? ""}`;
    return this.cache.cached(cacheKey, () => this.computeFunnel(orgId, range, repId), CACHE_TTL.SHORT);
  }

  private async computeFunnel(orgId: string, range: DateRange, repId?: number): Promise<SalesFunnelStage[]> {
    const stageAggs = await this.db
      .select({
        stage: crmDeals.stage,
        dealCount: count(),
        totalValue: sql<number>`COALESCE(sum(${crmDeals.value}::numeric), 0)::float`,
      })
      .from(crmDeals)
      .where(this.dealFilter(orgId, range, repId))
      .groupBy(crmDeals.stage);

    const stageMap = new Map(stageAggs.map((r) => [r.stage, r]));

    return STAGE_ORDER.map((stage, i) => {
      const agg = stageMap.get(stage);
      const prevStage = i > 0 ? stageMap.get(STAGE_ORDER[i - 1]) : null;
      const dropOffPct =
        prevStage && prevStage.dealCount > 0
          ? Math.round(((agg?.dealCount ?? 0) / prevStage.dealCount) * 1000) / 10
          : null;

      return {
        stage,
        count: agg?.dealCount ?? 0,
        value: agg?.totalValue ?? 0,
        color: STAGE_COLORS[stage] ?? "#6B7280",
        dropOffPct,
      };
    });
  }

  getLeaderboard(orgId: string, range: DateRange = {}): Promise<SalesLeaderboardEntry[]> {
    const cacheKey = `sales:leaderboard:${orgId}:${range.from?.toISOString() ?? ""}:${range.to?.toISOString() ?? ""}`;
    return this.cache.cached(cacheKey, () => this.computeLeaderboard(orgId, range), CACHE_TTL.SHORT);
  }

  private async computeLeaderboard(orgId: string, range: DateRange): Promise<SalesLeaderboardEntry[]> {
    const [wonAggs, totalAggs] = await Promise.all([
      this.db
        .select({
          salesRepId: crmDeals.salesRepId,
          deals: count(),
          revenue: sql<number>`COALESCE(sum(${crmDeals.value}::numeric), 0)::float`,
        })
        .from(crmDeals)
        .where(
          and(
            ...[
              eq(crmDeals.orgId, orgId),
              eq(crmDeals.stage, "Closed Won"),
              isNotNull(crmDeals.salesRepId),
              ...(range.from ? [gte(crmDeals.createdAt, range.from)] : []),
              ...(range.to ? [lte(crmDeals.createdAt, range.to)] : []),
            ],
          ),
        )
        .groupBy(crmDeals.salesRepId),

      this.db
        .select({
          salesRepId: crmDeals.salesRepId,
          total: count(),
        })
        .from(crmDeals)
        .where(
          and(
            ...[
              eq(crmDeals.orgId, orgId),
              isNotNull(crmDeals.salesRepId),
              ...(range.from ? [gte(crmDeals.createdAt, range.from)] : []),
              ...(range.to ? [lte(crmDeals.createdAt, range.to)] : []),
            ],
          ),
        )
        .groupBy(crmDeals.salesRepId),
    ]);

    const totalMap = new Map(totalAggs.map((r) => [r.salesRepId, r.total]));

    const repIds = wonAggs.map((r) => r.salesRepId).filter(Boolean) as number[];
    const people = repIds.length
      ? await this.db.query.crmPeople.findMany({
          where: (p, { inArray }) => inArray(p.id, repIds),
          columns: { id: true, name: true, initials: true },
        })
      : [];
    const peopleMap = new Map(people.map((p) => [p.id, p]));

    return wonAggs
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10)
      .map((r) => {
        const person = r.salesRepId ? peopleMap.get(r.salesRepId) : null;
        const totalDeals = r.salesRepId ? totalMap.get(r.salesRepId) ?? 0 : 0;
        const winRate = totalDeals > 0 ? Math.round((r.deals / totalDeals) * 1000) / 10 : 0;
        return {
          repId: r.salesRepId ?? 0,
          name: person?.name ?? "Unknown",
          initials: person?.initials ?? "?",
          dealsWon: r.deals,
          totalDeals,
          revenue: r.revenue,
          winRate,
        };
      });
  }

  getRevenueVsGoal(orgId: string, year: number): Promise<RevenueVsGoalEntry[]> {
    const cacheKey = `sales:revenue-vs-goal:${orgId}:${year}`;
    return this.cache.cached(cacheKey, () => this.computeRevenueVsGoal(orgId, year), CACHE_TTL.MEDIUM);
  }

  private async computeRevenueVsGoal(orgId: string, year: number): Promise<RevenueVsGoalEntry[]> {
    const yearStart = new Date(`${year}-01-01`);
    const yearEnd = new Date(`${year}-12-31T23:59:59`);

    const [dealsByMonth, quotasByMonth] = await Promise.all([
      this.db
        .select({
          month: sql<string>`to_char(${crmDeals.createdAt}, 'Mon')`,
          monthNum: sql<number>`extract(month from ${crmDeals.createdAt})::int`,
          revenue: sql<number>`COALESCE(sum(${crmDeals.value}::numeric), 0)::float`,
        })
        .from(crmDeals)
        .where(
          and(
            eq(crmDeals.orgId, orgId),
            eq(crmDeals.stage, "Closed Won"),
            gte(crmDeals.createdAt, yearStart),
            lte(crmDeals.createdAt, yearEnd),
          ),
        )
        .groupBy(sql`to_char(${crmDeals.createdAt}, 'Mon')`, sql`extract(month from ${crmDeals.createdAt})`),

      this.db
        .select({
          startDate: salesQuotas.startDate,
          targetRevenue: salesQuotas.targetRevenue,
        })
        .from(salesQuotas)
        .where(
          and(
            eq(salesQuotas.orgId, orgId),
            gte(salesQuotas.startDate, `${year}-01-01`),
            lte(salesQuotas.startDate, `${year}-12-31`),
          ),
        ),
    ]);

    const quotaMap = new Map<number, number>();
    for (const q of quotasByMonth) {
      const m = new Date(q.startDate).getMonth() + 1;
      quotaMap.set(m, (quotaMap.get(m) ?? 0) + Number(q.targetRevenue));
    }

    const actualMap = new Map(dealsByMonth.map((r) => [r.monthNum, r.revenue]));

    return MONTHS.map((month, i) => ({
      month,
      actual: actualMap.get(i + 1) ?? 0,
      target: quotaMap.get(i + 1) ?? 0,
    }));
  }

  getVelocity(orgId: string, range: DateRange = {}): Promise<DealVelocityMetrics> {
    const cacheKey = `sales:velocity:${orgId}:${range.from?.toISOString() ?? ""}:${range.to?.toISOString() ?? ""}`;
    return this.cache.cached(cacheKey, () => this.computeVelocity(orgId, range), CACHE_TTL.MEDIUM);
  }

  private async computeVelocity(orgId: string, range: DateRange): Promise<DealVelocityMetrics> {
    const conditions = [
      eq(crmDeals.orgId, orgId),
      eq(crmDeals.stage, "Closed Won"),
      isNotNull(crmDeals.updatedAt),
      isNotNull(crmDeals.createdAt),
    ];
    if (range.from) conditions.push(gte(crmDeals.createdAt, range.from));
    if (range.to) conditions.push(lte(crmDeals.createdAt, range.to));

    const rows = await this.db
      .select({
        daysToClose: sql<number>`GREATEST(1, EXTRACT(EPOCH FROM (${crmDeals.updatedAt} - ${crmDeals.createdAt})) / 86400)::float`,
      })
      .from(crmDeals)
      .where(and(...conditions));

    if (rows.length === 0) {
      return { avgDaysToClose: 0, medianDaysToClose: 0, fastestCloseDays: 0, slowestCloseDays: 0, dealCount: 0 };
    }

    const days = rows.map((r) => r.daysToClose).sort((a, b) => a - b);
    const avg = days.reduce((s, d) => s + d, 0) / days.length;
    const mid = Math.floor(days.length / 2);
    const median = days.length % 2 !== 0 ? days[mid]! : (days[mid - 1]! + days[mid]!) / 2;

    return {
      avgDaysToClose: Math.round(avg * 10) / 10,
      medianDaysToClose: Math.round(median * 10) / 10,
      fastestCloseDays: Math.round(days[0]! * 10) / 10,
      slowestCloseDays: Math.round(days[days.length - 1]! * 10) / 10,
      dealCount: days.length,
    };
  }

  getAging(orgId: string, thresholdDays = 14): Promise<AgingDeal[]> {
    const cacheKey = `sales:aging:${orgId}:${thresholdDays}`;
    return this.cache.cached(cacheKey, () => this.computeAging(orgId, thresholdDays), CACHE_TTL.SHORT);
  }

  private async computeAging(orgId: string, thresholdDays: number): Promise<AgingDeal[]> {
    const cutoff = new Date(Date.now() - thresholdDays * 24 * 60 * 60 * 1000);

    const rows = await this.db
      .select({
        id: crmDeals.id,
        companyName: crmDeals.companyName,
        stage: crmDeals.stage,
        value: sql<number>`${crmDeals.value}::float`,
        daysSinceUpdate: sql<number>`GREATEST(0, EXTRACT(EPOCH FROM (now() - ${crmDeals.updatedAt})) / 86400)::int`,
        salesRepId: crmDeals.salesRepId,
      })
      .from(crmDeals)
      .where(
        and(
          eq(crmDeals.orgId, orgId),
          ne(crmDeals.stage, "Closed Won"),
          lt(crmDeals.updatedAt, cutoff),
        ),
      )
      .orderBy(sql`${crmDeals.updatedAt} ASC`)
      .limit(50);

    return rows;
  }
}
