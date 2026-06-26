import { Inject, Injectable } from "@nestjs/common";
import { eq, and, gte, lte, sql, count, isNotNull, sum } from "drizzle-orm";
import { crmDeals, crmPeople, deals, leads } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import { subMonths, startOfMonth, endOfMonth } from "./date.helpers";

export interface CohortRow {
  cohortMonth: string;
  created: number;
  converted: number;
  conversionRate: number;
  avgDaysToConvert: number | null;
}

interface RepMonthStat {
  month: string;
  dealsWon: number;
  revenue: number;
}

export interface RepComparisonData {
  repId: number;
  name: string;
  initials: string;
  dealsWon: number;
  totalDeals: number;
  revenue: number;
  winRate: number;
  avgDealSize: number;
  monthly: RepMonthStat[];
}

export type RepNotFound = { error: "rep_not_found" };

export function isRepNotFound(value: unknown): value is RepNotFound {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    (value as { error: unknown }).error === "rep_not_found"
  );
}

@Injectable()
export class SalesAnalyticsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  getCohort(orgId: string, months?: number): Promise<CohortRow[]> {
    const numMonths = Math.min(months ?? 6, 12);
    const cacheKey = `cohort:${orgId}:${numMonths}`;
    return this.cache.cached(cacheKey, () => this.computeCohort(orgId, numMonths), CACHE_TTL.MEDIUM);
  }

  private async computeCohort(orgId: string, numMonths: number): Promise<CohortRow[]> {
    const rows: CohortRow[] = [];

    for (let i = numMonths - 1; i >= 0; i--) {
      const monthStart = startOfMonth(subMonths(new Date(), i));
      const monthEnd = endOfMonth(subMonths(new Date(), i));
      const label = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, "0")}`;

      const [stats] = await this.db
        .select({
          created: count(leads.id),
          converted: sql<number>`count(*) filter (where ${leads.convertedAt} is not null)`,
          avgDays: sql<number | null>`
            round(avg(
              extract(epoch from ${leads.convertedAt} - ${leads.createdAt}) / 86400.0
            ) filter (where ${leads.convertedAt} is not null))
          `,
        })
        .from(leads)
        .where(
          and(
            eq(leads.orgId, orgId),
            gte(leads.createdAt, monthStart),
            lte(leads.createdAt, monthEnd),
            sql`${leads.deletedAt} IS NULL`,
          ),
        );

      const created = Number(stats?.created ?? 0);
      const converted = Number(stats?.converted ?? 0);

      rows.push({
        cohortMonth: label,
        created,
        converted,
        conversionRate: created > 0 ? Math.round((converted / created) * 100) : 0,
        avgDaysToConvert: stats?.avgDays ? Number(stats.avgDays) : null,
      });
    }

    return rows;
  }

  getCycleLength(orgId: string, repId?: string) {
    const cacheKey = `sales:cycle-length:${orgId}:${repId ?? "all"}`;
    return this.cache.cached(cacheKey, () => this.computeCycleLength(orgId, repId), CACHE_TTL.MEDIUM);
  }

  private async computeCycleLength(orgId: string, repId?: string) {
    const conditions = [
      eq(deals.orgId, orgId),
      eq(deals.stage, "WON"),
      isNotNull(deals.actualCloseDate),
      isNotNull(deals.createdAt),
    ];

    if (repId) conditions.push(eq(deals.assignedToId, repId));

    const wonDeals = await this.db
      .select({
        createdAt: deals.createdAt,
        actualCloseDate: deals.actualCloseDate,
        value: deals.value,
      })
      .from(deals)
      .where(and(...conditions));

    if (!wonDeals.length) {
      return {
        avgDays: null,
        medianDays: null,
        histogram: [],
        totalDeals: 0,
      };
    }

    const daysList: number[] = wonDeals
      .map((d) => {
        if (!d.createdAt || !d.actualCloseDate) return null;
        const diff = Math.max(
          0,
          Math.round(
            (new Date(d.actualCloseDate).getTime() - new Date(d.createdAt).getTime()) /
              (1000 * 60 * 60 * 24),
          ),
        );
        return diff;
      })
      .filter((d): d is number => d !== null);

    const sorted = [...daysList].sort((a, b) => a - b);
    const avg = Math.round(daysList.reduce((s, d) => s + d, 0) / daysList.length);
    const median =
      sorted.length % 2 === 0
        ? Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
        : sorted[Math.floor(sorted.length / 2)];

    const buckets = [
      { label: "0–7d", min: 0, max: 7, count: 0 },
      { label: "8–14d", min: 8, max: 14, count: 0 },
      { label: "15–30d", min: 15, max: 30, count: 0 },
      { label: "31–60d", min: 31, max: 60, count: 0 },
      { label: "61–90d", min: 61, max: 90, count: 0 },
      { label: "90d+", min: 91, max: Infinity, count: 0 },
    ];

    for (const days of daysList) {
      const bucket = buckets.find((b) => days >= b.min && days <= b.max);
      if (bucket) bucket.count++;
    }

    return {
      avgDays: avg,
      medianDays: median,
      minDays: sorted[0],
      maxDays: sorted[sorted.length - 1],
      histogram: buckets.map(({ label, count: c }) => ({ label, count: c })),
      totalDeals: daysList.length,
    };
  }

  getLostAnalysis(orgId: string, repId?: string) {
    const cacheKey = `sales:lost-analysis:${orgId}:${repId ?? "all"}`;
    return this.cache.cached(cacheKey, () => this.computeLostAnalysis(orgId, repId), CACHE_TTL.MEDIUM);
  }

  private async computeLostAnalysis(orgId: string, repId?: string) {
    const conditions = [eq(deals.orgId, orgId), eq(deals.stage, "LOST")];

    if (repId) conditions.push(eq(deals.assignedToId, repId));

    const [lostDeals, lostByReason] = await Promise.all([
      this.db
        .select({ count: count(), totalValue: sum(deals.value) })
        .from(deals)
        .where(and(...conditions)),

      this.db
        .select({
          reason: deals.lostReason,
          count: count(),
          totalValue: sum(deals.value),
        })
        .from(deals)
        .where(and(...conditions))
        .groupBy(deals.lostReason),
    ]);

    const total = Number(lostDeals[0]?.count ?? 0);
    const totalValue = Number(lostDeals[0]?.totalValue ?? 0);

    const reasons = lostByReason
      .map((r) => ({
        reason: r.reason ?? "No reason given",
        count: Number(r.count),
        totalValue: Number(r.totalValue ?? 0),
        pct: total > 0 ? Math.round((Number(r.count) / total) * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return { total, totalValue, reasons };
  }

  async getRepComparison(
    orgId: string,
    rep1Id: number,
    rep2Id: number,
    from: Date,
    to: Date,
  ): Promise<{ rep1: RepComparisonData; rep2: RepComparisonData } | RepNotFound> {
    const [rep1Data, rep2Data] = await Promise.all([
      this.getRepStats(orgId, rep1Id, from, to),
      this.getRepStats(orgId, rep2Id, from, to),
    ]);
    if (!rep1Data || !rep2Data) return { error: "rep_not_found" };
    return { rep1: rep1Data, rep2: rep2Data };
  }

  private async getRepStats(
    orgId: string,
    repId: number,
    from: Date,
    to: Date,
  ): Promise<RepComparisonData | null> {
    const person = await this.db.query.crmPeople.findFirst({
      where: and(eq(crmPeople.id, repId), eq(crmPeople.orgId, orgId)),
      columns: { id: true, name: true, initials: true },
    });
    if (!person) return null;

    const baseWhere = and(
      eq(crmDeals.orgId, orgId),
      eq(crmDeals.salesRepId, repId),
      gte(crmDeals.createdAt, from),
      lte(crmDeals.createdAt, to),
    );

    const [wonStats] = await this.db
      .select({
        deals: count(),
        revenue: sql<number>`COALESCE(sum(${crmDeals.value}::numeric), 0)::float`,
      })
      .from(crmDeals)
      .where(and(baseWhere, eq(crmDeals.stage, "Closed Won")));

    const [totalStats] = await this.db
      .select({ total: count() })
      .from(crmDeals)
      .where(baseWhere);

    const dealsWon = wonStats?.deals ?? 0;
    const totalDeals = totalStats?.total ?? 0;
    const revenue = Number(wonStats?.revenue ?? 0);

    const monthly: RepMonthStat[] = [];
    for (let i = 5; i >= 0; i--) {
      const mStart = startOfMonth(subMonths(new Date(), i));
      const mEnd = endOfMonth(subMonths(new Date(), i));
      const label = `${mStart.toLocaleString("en", { month: "short" })} '${String(mStart.getFullYear()).slice(2)}`;

      const [mStats] = await this.db
        .select({
          deals: count(),
          revenue: sql<number>`COALESCE(sum(${crmDeals.value}::numeric), 0)::float`,
        })
        .from(crmDeals)
        .where(
          and(
            eq(crmDeals.orgId, orgId),
            eq(crmDeals.salesRepId, repId),
            eq(crmDeals.stage, "Closed Won"),
            gte(crmDeals.createdAt, mStart),
            lte(crmDeals.createdAt, mEnd),
          ),
        );

      monthly.push({ month: label, dealsWon: mStats?.deals ?? 0, revenue: Number(mStats?.revenue ?? 0) });
    }

    return {
      repId: person.id,
      name: person.name ?? "Unknown",
      initials: person.initials ?? "?",
      dealsWon,
      totalDeals,
      revenue,
      winRate: totalDeals > 0 ? Math.round((dealsWon / totalDeals) * 1000) / 10 : 0,
      avgDealSize: dealsWon > 0 ? Math.round(revenue / dealsWon) : 0,
      monthly,
    };
  }
}
