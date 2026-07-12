import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, gte, isNotNull, ne, sql } from "drizzle-orm";
import {
  crmDeals,
  crmActivities,
  crmMonthlyMetrics,
  crmOptions,
  leads,
  leadActivities,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { subDays } from "./date.helpers";
import { resolveLeadStatusSemantics } from "../leads/lead-status-semantics";

function computeTrend(current: number, previous: number) {
  if (previous === 0) return { value: 0, isPositive: true };
  const change = ((current - previous) / previous) * 100;
  return { value: Math.round(Math.abs(change) * 10) / 10, isPositive: change >= 0 };
}

const STAGE_ORDER = ["Discovery", "Qualified", "Proposal", "Negotiation", "Closed Won"] as const;
const STAGE_COLORS: Record<string, string> = {
  Discovery: "#3B82F6",
  Qualified: "#6366F1",
  Proposal: "#8B5CF6",
  Negotiation: "#A855F7",
  "Closed Won": "#10B981",
};

@Injectable()
export class CrmSalesDashboardService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  getSalesDashboard(orgId: string) {
    return this.cache.cached(CACHE_KEYS.salesDashboard(orgId), () => this.build(orgId), CACHE_TTL.MEDIUM);
  }

  private async build(orgId: string) {
    const [stageAggs, topDealsRaw, leaderboardRaw, metrics, recentActivities, leadMetrics, statusOptions] =
      await Promise.all([
        this.db
          .select({
            stage: crmDeals.stage,
            dealCount: count(),
            totalValue: sql<number>`COALESCE(sum(${crmDeals.value}::numeric), 0)::float`,
          })
          .from(crmDeals)
          .where(eq(crmDeals.orgId, orgId))
          .groupBy(crmDeals.stage),

        this.db.query.crmDeals.findMany({
          where: and(eq(crmDeals.orgId, orgId), ne(crmDeals.stage, "Closed Won")),
          with: { salesRep: true },
          orderBy: [desc(crmDeals.value)],
          limit: 5,
        }),

        this.db
          .select({
            salesRepId: crmDeals.salesRepId,
            deals: count(),
            revenue: sql<number>`COALESCE(sum(${crmDeals.value}::numeric), 0)::float`,
          })
          .from(crmDeals)
          .where(and(eq(crmDeals.orgId, orgId), eq(crmDeals.stage, "Closed Won"), isNotNull(crmDeals.salesRepId)))
          .groupBy(crmDeals.salesRepId)
          .orderBy(desc(sql`sum(${crmDeals.value}::numeric)`))
          .limit(5),

        this.db.query.crmMonthlyMetrics.findMany({
          where: eq(crmMonthlyMetrics.orgId, orgId),
          orderBy: [desc(crmMonthlyMetrics.id)],
        }),

        this.db
          .select({ type: leadActivities.type, actCount: count() })
          .from(leadActivities)
          .innerJoin(leads, eq(leads.id, leadActivities.leadId))
          .where(and(eq(leads.orgId, orgId), gte(leadActivities.createdAt, subDays(new Date(), 7))))
          .groupBy(leadActivities.type),

        this.db
          .select({ status: leads.status, cnt: count() })
          .from(leads)
          .where(eq(leads.orgId, orgId))
          .groupBy(leads.status),

        this.db.select().from(crmOptions)
          .where(and(eq(crmOptions.orgId, orgId), eq(crmOptions.type, "lead_status"))),
      ]);

    const stageMap = new Map(stageAggs.map((r) => [r.stage, r]));
    const pipelineValue = stageAggs.reduce((s, r) => s + r.totalValue, 0);
    const closedWonAgg = stageMap.get("Closed Won");
    const dealsWon = closedWonAgg?.dealCount ?? 0;
    const totalDeals = stageAggs.reduce((s, r) => s + r.dealCount, 0);
    const conversionRate = totalDeals > 0 ? (dealsWon / totalDeals) * 100 : 0;
    const avgDealSize = dealsWon > 0 ? (closedWonAgg?.totalValue ?? 0) / dealsWon : 0;

    const curr = metrics[0];
    const prev = metrics[1];

    const salesStats = {
      pipeline: {
        value: pipelineValue,
        trend: computeTrend(Number(curr?.revenue ?? 0), Number(prev?.revenue ?? 0)),
      },
      dealsWon: {
        value: dealsWon,
        trend: computeTrend(curr?.mqls ?? 0, prev?.mqls ?? 0),
      },
      conversionRate: {
        value: Math.round(conversionRate * 10) / 10,
        trend: computeTrend(Number(curr?.retention ?? 0), Number(prev?.retention ?? 0)),
      },
      avgDealSize: {
        value: Math.round(avgDealSize),
        trend: computeTrend(Number(curr?.csat ?? 0), Number(prev?.csat ?? 0)),
      },
    };

    const revenueTimeline = metrics
      .map((m) => ({ month: m.month, value: Number(m.revenue) }))
      .reverse();

    const salesFunnel = STAGE_ORDER.map((stage) => {
      const agg = stageMap.get(stage);
      return { stage, value: agg?.dealCount ?? 0, color: STAGE_COLORS[stage] };
    });

    const topDeals = topDealsRaw.map((d) => ({
      company: d.companyName,
      value: Number(d.value),
      stage: d.stage,
      rep: d.salesRep
        ? `${d.salesRep.name.split(" ")[0]} ${d.salesRep.name.split(" ")[1]?.[0] ?? ""}.`
        : "Unassigned",
      probability: d.probability ?? 0,
    }));

    const repIds = leaderboardRaw.map((r) => r.salesRepId).filter(Boolean) as number[];
    const people = repIds.length
      ? await this.db.query.crmPeople.findMany({
          where: (p, { inArray }) => inArray(p.id, repIds),
          columns: { id: true, name: true, initials: true },
        })
      : [];
    const peopleMap = new Map(people.map((p) => [p.id, p]));

    const salesLeaderboard = leaderboardRaw.map((r) => {
      const person = r.salesRepId ? peopleMap.get(r.salesRepId) : null;
      return {
        name: person?.name ?? "Unknown",
        deals: r.deals,
        revenue: r.revenue,
        avatar: person?.initials ?? "?",
      };
    });

    const dealsByStage = STAGE_ORDER.map((stage) => {
      const agg = stageMap.get(stage);
      return {
        stage,
        count: agg?.dealCount ?? 0,
        value: agg?.totalValue ?? 0,
        color: STAGE_COLORS[stage],
      };
    });

    const statusMap = new Map(leadMetrics.map((r) => [r.status, r.cnt]));
    const activityMap: Record<string, number> = Object.fromEntries(
      recentActivities.map((a) => [a.type, a.actCount]),
    );
    const semantics = resolveLeadStatusSemantics(statusOptions);

    const enhancedMetrics = {
      activeClients: semantics.convertedKeys.reduce((s, k) => s + (statusMap.get(k) ?? 0), 0),
      inactiveClients: semantics.lostKeys.reduce((s, k) => s + (statusMap.get(k) ?? 0), 0),
      totalCalls: activityMap["call"] ?? 0,
      totalMeetings: activityMap["meeting"] ?? 0,
      totalEmails: activityMap["email"] ?? 0,
      totalSiteVisits: activityMap["site_visit"] ?? 0,
      followUpNeeded: 0,
    };

    const salesActivities = await this.db.query.crmActivities.findMany({
      where: and(eq(crmActivities.orgId, orgId), eq(crmActivities.category, "sales")),
      orderBy: [desc(crmActivities.createdAt)],
      limit: 7,
    });
    const salesActivity = salesActivities.map((a) => ({
      type: a.type as "deal_won" | "meeting" | "proposal" | "call" | "email",
      message: a.message,
      time: a.time,
      person: a.person ?? "",
    }));

    return {
      salesStats,
      revenueTimeline,
      salesFunnel,
      topDeals,
      salesLeaderboard,
      salesActivity,
      dealsByStage,
      enhancedMetrics,
    };
  }
}
