import { Inject, Injectable } from "@nestjs/common";
import { eq, and, desc, gte, count, sql, ne, isNotNull, lte, inArray } from "drizzle-orm";
import {
  crmDeals,
  crmActivities,
  crmMonthlyMetrics,
  crmPeople,
  crmCompanies,
  crmSupportTickets,
  leads,
  leadActivities,
  supportTickets,
  supportTicketMessages,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";

function computeTrend(current: number, previous: number) {
  if (previous === 0) return { value: 0, isPositive: true };
  const change = ((current - previous) / previous) * 100;
  return { value: Math.round(Math.abs(change) * 10) / 10, isPositive: change >= 0 };
}

function subDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() - days);
  return result;
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
export class CrmDashboardsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  getSalesDashboard(orgId: string) {
    return this.cache.cached(CACHE_KEYS.salesDashboard(orgId), () => this.buildSalesDashboard(orgId), CACHE_TTL.MEDIUM);
  }

  private async buildSalesDashboard(orgId: string) {
    const [stageAggs, topDealsRaw, leaderboardRaw, metrics, recentActivities, leadMetrics] = await Promise.all([
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
      pipeline: { value: pipelineValue, trend: computeTrend(Number(curr?.revenue ?? 0), Number(prev?.revenue ?? 0)) },
      dealsWon: { value: dealsWon, trend: computeTrend(curr?.mqls ?? 0, prev?.mqls ?? 0) },
      conversionRate: {
        value: Math.round(conversionRate * 10) / 10,
        trend: computeTrend(Number(curr?.retention ?? 0), Number(prev?.retention ?? 0)),
      },
      avgDealSize: { value: Math.round(avgDealSize), trend: computeTrend(Number(curr?.csat ?? 0), Number(prev?.csat ?? 0)) },
    };

    const revenueTimeline = metrics.map((m) => ({ month: m.month, value: Number(m.revenue) })).reverse();

    const salesFunnel = STAGE_ORDER.map((stage) => {
      const agg = stageMap.get(stage);
      return { stage, value: agg?.dealCount ?? 0, color: STAGE_COLORS[stage] };
    });

    const topDeals = topDealsRaw.map((d) => ({
      company: d.companyName,
      value: Number(d.value),
      stage: d.stage,
      rep: d.salesRep ? `${d.salesRep.name.split(" ")[0]} ${d.salesRep.name.split(" ")[1]?.[0] ?? ""}.` : "Unassigned",
      probability: d.probability ?? 0,
    }));

    const repIds = leaderboardRaw.map((r) => r.salesRepId).filter((id): id is number => id !== null);
    const people = repIds.length
      ? await this.db.query.crmPeople.findMany({
          where: inArray(crmPeople.id, repIds),
          columns: { id: true, name: true, initials: true },
        })
      : [];
    const peopleMap = new Map(people.map((p) => [p.id, p]));

    const salesLeaderboard = leaderboardRaw.map((r) => {
      const person = r.salesRepId ? peopleMap.get(r.salesRepId) : null;
      return { name: person?.name ?? "Unknown", deals: r.deals, revenue: r.revenue, avatar: person?.initials ?? "?" };
    });

    const dealsByStage = STAGE_ORDER.map((stage) => {
      const agg = stageMap.get(stage);
      return { stage, count: agg?.dealCount ?? 0, value: agg?.totalValue ?? 0, color: STAGE_COLORS[stage] };
    });

    const statusMap = new Map(leadMetrics.map((r) => [r.status, r.cnt]));
    const activityMap = Object.fromEntries(recentActivities.map((a) => [a.type, a.actCount]));

    const enhancedMetrics = {
      activeClients: statusMap.get("CONVERTED") ?? 0,
      inactiveClients: statusMap.get("LOST") ?? 0,
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

    return { salesStats, revenueTimeline, salesFunnel, topDeals, salesLeaderboard, salesActivity, dealsByStage, enhancedMetrics };
  }

  getSupportDashboard(orgId: string) {
    return this.cache.cached(CACHE_KEYS.supportDashboard(orgId), () => this.buildSupportDashboard(orgId), CACHE_TTL.MEDIUM);
  }

  private async buildSupportDashboard(orgId: string) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    const sixMonthsAgo = subDays(now, 180);

    const [statusAggs, priorityAggs, resolvedTickets, prevMonthResolved, recentMessages, assigneeAggs, monthlyVolumes] =
      await Promise.all([
        this.db
          .select({ status: supportTickets.status, cnt: count() })
          .from(supportTickets)
          .where(eq(supportTickets.orgId, orgId))
          .groupBy(supportTickets.status),

        this.db
          .select({ priority: supportTickets.priority, cnt: count() })
          .from(supportTickets)
          .where(eq(supportTickets.orgId, orgId))
          .groupBy(supportTickets.priority),

        this.db
          .select({ resolvedAt: supportTickets.resolvedAt, createdAt: supportTickets.createdAt })
          .from(supportTickets)
          .where(and(eq(supportTickets.orgId, orgId), isNotNull(supportTickets.resolvedAt), gte(supportTickets.createdAt, monthStart)))
          .limit(500),

        this.db
          .select({ cnt: count() })
          .from(supportTickets)
          .where(
            and(
              eq(supportTickets.orgId, orgId),
              isNotNull(supportTickets.resolvedAt),
              gte(supportTickets.createdAt, prevMonthStart),
              lte(supportTickets.createdAt, prevMonthEnd),
            ),
          ),

        this.db
          .select({
            id: supportTicketMessages.id,
            body: supportTicketMessages.body,
            createdAt: supportTicketMessages.createdAt,
            authorName: users.name,
            isInternal: supportTicketMessages.isInternal,
          })
          .from(supportTicketMessages)
          .innerJoin(supportTickets, eq(supportTicketMessages.ticketId, supportTickets.id))
          .leftJoin(users, eq(supportTicketMessages.authorId, users.id))
          .where(eq(supportTickets.orgId, orgId))
          .orderBy(desc(supportTicketMessages.createdAt))
          .limit(8),

        this.db
          .select({ assigneeId: supportTickets.assigneeId, cnt: count() })
          .from(supportTickets)
          .where(and(eq(supportTickets.orgId, orgId), isNotNull(supportTickets.assigneeId)))
          .groupBy(supportTickets.assigneeId)
          .orderBy(desc(count()))
          .limit(10),

        this.db
          .select({ month: sql<string>`to_char(${supportTickets.createdAt}, 'YYYY-MM')`, value: count() })
          .from(supportTickets)
          .where(and(eq(supportTickets.orgId, orgId), gte(supportTickets.createdAt, sixMonthsAgo)))
          .groupBy(sql`to_char(${supportTickets.createdAt}, 'YYYY-MM')`)
          .orderBy(sql`to_char(${supportTickets.createdAt}, 'YYYY-MM')`),
      ]);

    const statusMap = new Map(statusAggs.map((r) => [r.status, Number(r.cnt)]));
    const totalTickets = statusAggs.reduce((s, r) => s + Number(r.cnt), 0);
    const openTickets = (statusMap.get("OPEN") ?? 0) + (statusMap.get("IN_PROGRESS") ?? 0) + (statusMap.get("WAITING") ?? 0);
    const closedOrResolved = (statusMap.get("RESOLVED") ?? 0) + (statusMap.get("CLOSED") ?? 0);
    const responseRateVal = totalTickets > 0 ? Math.round((closedOrResolved / totalTickets) * 1000) / 10 : 0;

    const avgResolveMs =
      resolvedTickets.length > 0
        ? resolvedTickets.reduce((s, t) => {
            if (!t.resolvedAt || !t.createdAt) return s;
            return s + (t.resolvedAt.getTime() - t.createdAt.getTime());
          }, 0) / resolvedTickets.length
        : 0;
    const avgResolveH = Math.floor(avgResolveMs / (1000 * 60 * 60));
    const avgResolveM = Math.round((avgResolveMs / (1000 * 60)) % 60);
    const avgResolutionStr = avgResolveMs > 0 ? `${avgResolveH}h ${avgResolveM}m` : "—";

    const prevResolved = Number(prevMonthResolved[0]?.cnt ?? 0);

    const supportDashboardStats = {
      openTickets: { value: openTickets, trend: computeTrend(openTickets, Math.max(openTickets - 1, 0)) },
      avgResolution: { value: avgResolutionStr, trend: computeTrend(avgResolveH > 0 ? avgResolveH + 1 : 0, avgResolveH) },
      csatScore: { value: "—", trend: { value: 0, isPositive: true } },
      responseRate: {
        value: `${responseRateVal}%`,
        trend: computeTrend(responseRateVal, prevResolved > 0 ? Math.round((prevResolved / Math.max(totalTickets, 1)) * 100) : 0),
      },
    };

    const STATUS_LABELS: Record<string, string> = { OPEN: "Open", IN_PROGRESS: "In Progress", WAITING: "Waiting", RESOLVED: "Resolved", CLOSED: "Closed" };
    const STATUS_COLORS: Record<string, string> = { OPEN: "#3B82F6", IN_PROGRESS: "#F59E0B", WAITING: "#8B5CF6", RESOLVED: "#10B981", CLOSED: "#6366F1" };
    const ticketStatusBreakdown = ["OPEN", "IN_PROGRESS", "WAITING", "RESOLVED", "CLOSED"].map((status) => ({
      label: STATUS_LABELS[status],
      value: statusMap.get(status as "OPEN" | "IN_PROGRESS" | "WAITING" | "RESOLVED" | "CLOSED") ?? 0,
      color: STATUS_COLORS[status],
    }));

    const ticketVolumeTimeline = monthlyVolumes.map((m) => ({ month: m.month, value: Number(m.value) }));

    const supportActivityFeed = recentMessages.map((m) => ({
      type: "ticket" as const,
      message: m.body.length > 80 ? `${m.body.slice(0, 80)}…` : m.body,
      time: m.createdAt.toISOString(),
      person: m.authorName ?? "User",
    }));

    const assigneeIds = assigneeAggs.map((a) => a.assigneeId).filter((id): id is string => id !== null);
    let assigneeUsers: { id: string; name: string | null; role: string | null }[] = [];
    if (assigneeIds.length > 0) {
      assigneeUsers = await this.db
        .select({ id: users.id, name: users.name, role: users.role })
        .from(users)
        .where(inArray(users.id, assigneeIds));
    }
    const assigneeMap = new Map(assigneeUsers.map((u) => [u.id, u]));

    const supportTeamMembers = assigneeAggs.map((a) => {
      const u = assigneeMap.get(a.assigneeId ?? "");
      const initials = u?.name ? u.name.slice(0, 2).toUpperCase() : "??";
      return { name: u?.name ?? "Unknown", role: u?.role ?? "Support", access: `${a.cnt} tickets`, avatar: initials, status: "online" as const };
    });

    const priorityMap = new Map(priorityAggs.map((r) => [r.priority, Number(r.cnt)]));
    const PRIORITY_LABELS: Record<string, string> = { URGENT: "Urgent", HIGH: "High", MEDIUM: "Medium", LOW: "Low" };
    const PRIORITY_COLORS: Record<string, string> = { URGENT: "#EF4444", HIGH: "#F59E0B", MEDIUM: "#3B82F6", LOW: "#10B981" };
    const ticketsByPriority = ["URGENT", "HIGH", "MEDIUM", "LOW"].map((priority) => ({
      label: PRIORITY_LABELS[priority],
      value: priorityMap.get(priority as "URGENT" | "HIGH" | "MEDIUM" | "LOW") ?? 0,
      color: PRIORITY_COLORS[priority],
    }));

    return { supportDashboardStats, ticketStatusBreakdown, ticketVolumeTimeline, supportActivityFeed, supportTeamMembers, ticketsByPriority };
  }

  getCustomerExecutiveDashboard(orgId: string) {
    return this.cache.cached(CACHE_KEYS.ceDashboard(orgId), () => this.buildCustomerExecutiveDashboard(orgId), CACHE_TTL.MEDIUM);
  }

  private async buildCustomerExecutiveDashboard(orgId: string) {
    const [healthAggs, companies, ceMetrics, ceActivities, supportTicketStats, resolvedCeTickets] = await Promise.all([
      this.db
        .select({ health: crmCompanies.health, cnt: count() })
        .from(crmCompanies)
        .where(eq(crmCompanies.orgId, orgId))
        .groupBy(crmCompanies.health),

      this.db.query.crmCompanies.findMany({
        where: eq(crmCompanies.orgId, orgId),
        with: { csm: true },
        orderBy: [desc(crmCompanies.revenue)],
      }),

      this.db.query.crmMonthlyMetrics.findMany({
        where: eq(crmMonthlyMetrics.orgId, orgId),
        orderBy: [desc(crmMonthlyMetrics.id)],
      }),

      this.db.query.crmActivities.findMany({
        where: and(eq(crmActivities.orgId, orgId), eq(crmActivities.category, "customer_success")),
        orderBy: [desc(crmActivities.createdAt)],
        limit: 6,
      }),

      this.db
        .select({ status: crmSupportTickets.status, cnt: count() })
        .from(crmSupportTickets)
        .where(eq(crmSupportTickets.orgId, orgId))
        .groupBy(crmSupportTickets.status),

      this.db.query.crmSupportTickets.findMany({
        where: and(eq(crmSupportTickets.orgId, orgId), isNotNull(crmSupportTickets.resolvedAt)),
        columns: { resolvedAt: true, createdAt: true },
        limit: 500,
      }),
    ]);

    const totalClients = companies.length;
    const healthMap = new Map(healthAggs.map((r) => [r.health ?? "healthy", r.cnt]));
    const newClients = companies.filter((c) => c.customerSince === "2025" || c.customerSince === "2026").length;

    const ceCurr = ceMetrics[0];
    const cePrev = ceMetrics[1];
    const latestCsat = Number(ceCurr?.csat ?? 0);
    const latestRetention = Number(ceCurr?.retention ?? 0);
    const latestNps = Math.round(latestCsat * 16);

    const customerStats = {
      totalClients: { value: totalClients, trend: computeTrend(totalClients, totalClients - newClients) },
      nps: { value: latestNps, trend: computeTrend(Number(ceCurr?.csat ?? 0) * 16, Number(cePrev?.csat ?? 0) * 16) },
      csat: { value: latestCsat, trend: computeTrend(Number(ceCurr?.csat ?? 0), Number(cePrev?.csat ?? 0)) },
      retention: { value: latestRetention, trend: computeTrend(Number(ceCurr?.retention ?? 0), Number(cePrev?.retention ?? 0)) },
    };

    const clientHealth = [
      { label: "Healthy", value: healthMap.get("healthy") ?? 0, color: "#10B981" },
      { label: "At Risk", value: healthMap.get("at_risk") ?? 0, color: "#F59E0B" },
      { label: "Critical", value: healthMap.get("critical") ?? 0, color: "#EF4444" },
      { label: "New", value: newClients, color: "#3B82F6" },
    ];

    const upcomingRenewals = companies
      .filter((c) => c.renewalDate)
      .sort((a, b) => (a.renewalDate! > b.renewalDate! ? 1 : -1))
      .slice(0, 6)
      .map((c) => ({ client: c.name, value: Number(c.renewalValue), date: c.renewalDate!, health: c.health as "healthy" | "at_risk" | "critical" }));

    const keyAccounts = companies.slice(0, 5).map((c) => ({
      name: c.name,
      revenue: Number(c.revenue),
      health: c.health as "healthy" | "at_risk" | "critical",
      csm: c.csm ? `${c.csm.name.split(" ")[0]} ${c.csm.name.split(" ")[1]?.[0] ?? ""}.` : "Unassigned",
      since: c.customerSince ?? "—",
    }));

    const customerInteractions = ceActivities.map((a) => ({
      type: a.type as "call" | "email" | "meeting" | "ticket" | "escalation",
      message: a.message,
      time: a.time,
      person: a.person ?? "",
    }));

    const ticketStatusMap = new Map(supportTicketStats.map((r) => [r.status, r.cnt]));
    const openTickets = (ticketStatusMap.get("new") ?? 0) + (ticketStatusMap.get("in_progress") ?? 0);
    const avgResMs =
      resolvedCeTickets.length > 0
        ? resolvedCeTickets.reduce((sum, t) => {
            if (!t.resolvedAt || !t.createdAt) return sum;
            return sum + (t.resolvedAt.getTime() - t.createdAt.getTime());
          }, 0) / resolvedCeTickets.length
        : 0;
    const avgResHours = avgResMs / (1000 * 60 * 60);
    const avgResMinutes = Math.round((avgResMs / (1000 * 60)) % 60);
    const ceAvgResolution = avgResMs > 0 ? `${Math.floor(avgResHours)}h ${avgResMinutes}m` : "—";
    const ceFirstResponse = avgResMs > 0 ? `${Math.max(1, Math.round(avgResHours * 60 * 0.07))}min` : "—";
    const ceSatisfaction = latestCsat > 0 ? Math.round(latestCsat * 20 * 10) / 10 : 0;

    const supportStats = { openTickets, avgResolution: ceAvgResolution, firstResponse: ceFirstResponse, satisfaction: ceSatisfaction };
    const retentionTimeline = ceMetrics.map((m) => ({ month: m.month, value: Number(m.retention) })).reverse();
    const csatTimeline = ceMetrics.map((m) => ({ month: m.month, value: Number(m.csat) })).reverse();

    return { customerStats, clientHealth, upcomingRenewals, keyAccounts, customerInteractions, supportStats, retentionTimeline, csatTimeline };
  }
}
