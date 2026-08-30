import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

const CRM_CE_METRICS_LOOKBACK = 36;
import {
  crmCompanies,
  crmActivities,
  crmMonthlyMetrics,
  crmSupportTickets,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";

function computeTrend(current: number, previous: number) {
  if (previous === 0) return { value: 0, isPositive: true };
  const change = ((current - previous) / previous) * 100;
  return {
    value: Math.round(Math.abs(change) * 10) / 10,
    isPositive: change >= 0,
  };
}

const KEY_ACCOUNTS_LIMIT = 5;
const UPCOMING_RENEWALS_LIMIT = 6;
const NEW_CLIENT_YEARS = ["2025", "2026"];

@Injectable()
export class CrmCeDashboardService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  getCustomerExecutiveDashboard(orgId: string) {
    return this.cache.cached(
      CACHE_KEYS.ceDashboard(orgId),
      () => this.buildCe(orgId),
      CACHE_TTL.MEDIUM,
    );
  }

  private async buildCe(orgId: string) {
    const [
      healthAggs,
      newClientAggs,
      keyAccountCompanies,
      renewalCompanies,
      ceMetrics,
      ceActivities,
      supportTicketStats,
      ceResolvedAvg,
    ] = await Promise.all([
      this.db
        .select({ health: crmCompanies.health, cnt: count() })
        .from(crmCompanies)
        .where(eq(crmCompanies.orgId, orgId))
        .groupBy(crmCompanies.health),

      this.db
        .select({ cnt: count() })
        .from(crmCompanies)
        .where(
          and(
            eq(crmCompanies.orgId, orgId),
            inArray(crmCompanies.customerSince, NEW_CLIENT_YEARS),
          ),
        ),

      this.db.query.crmCompanies.findMany({
        where: eq(crmCompanies.orgId, orgId),
        columns: {
          name: true,
          revenue: true,
          health: true,
          customerSince: true,
        },
        with: { csm: { columns: { name: true } } },
        orderBy: [desc(crmCompanies.revenue)],
        limit: KEY_ACCOUNTS_LIMIT,
      }),

      this.db.query.crmCompanies.findMany({
        where: and(
          eq(crmCompanies.orgId, orgId),
          isNotNull(crmCompanies.renewalDate),
        ),
        columns: {
          name: true,
          health: true,
          renewalDate: true,
          renewalValue: true,
        },
        orderBy: [asc(crmCompanies.renewalDate)],
        limit: UPCOMING_RENEWALS_LIMIT,
      }),

      this.db.query.crmMonthlyMetrics.findMany({
        where: eq(crmMonthlyMetrics.orgId, orgId),
        orderBy: [desc(crmMonthlyMetrics.id)],
        limit: CRM_CE_METRICS_LOOKBACK,
      }),

      this.db.query.crmActivities.findMany({
        where: and(
          eq(crmActivities.orgId, orgId),
          eq(crmActivities.category, "customer_success"),
        ),
        orderBy: [desc(crmActivities.createdAt)],
        limit: 6,
      }),

      this.db
        .select({ status: crmSupportTickets.status, cnt: count() })
        .from(crmSupportTickets)
        .where(eq(crmSupportTickets.orgId, orgId))
        .groupBy(crmSupportTickets.status),

      this.db
        .select({
          avgMs: sql<string>`EXTRACT(EPOCH FROM AVG(${crmSupportTickets.resolvedAt} - ${crmSupportTickets.createdAt})) * 1000`,
        })
        .from(crmSupportTickets)
        .where(
          and(
            eq(crmSupportTickets.orgId, orgId),
            isNotNull(crmSupportTickets.resolvedAt),
          ),
        ),
    ]);

    const totalClients = healthAggs.reduce((sum, r) => sum + r.cnt, 0);
    const healthMap = new Map(
      healthAggs.map((r) => [r.health ?? "healthy", r.cnt]),
    );
    const newClients = newClientAggs[0]?.cnt ?? 0;

    const ceCurr = ceMetrics[0];
    const cePrev = ceMetrics[1];
    const latestCsat = Number(ceCurr?.csat ?? 0);
    const latestRetention = Number(ceCurr?.retention ?? 0);
    const latestNps = Math.round(latestCsat * 16);

    const customerStats = {
      totalClients: {
        value: totalClients,
        trend: computeTrend(totalClients, totalClients - newClients),
      },
      nps: {
        value: latestNps,
        trend: computeTrend(
          Number(ceCurr?.csat ?? 0) * 16,
          Number(cePrev?.csat ?? 0) * 16,
        ),
      },
      csat: {
        value: latestCsat,
        trend: computeTrend(
          Number(ceCurr?.csat ?? 0),
          Number(cePrev?.csat ?? 0),
        ),
      },
      retention: {
        value: latestRetention,
        trend: computeTrend(
          Number(ceCurr?.retention ?? 0),
          Number(cePrev?.retention ?? 0),
        ),
      },
    };

    const clientHealth = [
      {
        label: "Healthy",
        value: healthMap.get("healthy") ?? 0,
        color: "#10B981",
      },
      {
        label: "At Risk",
        value: healthMap.get("at_risk") ?? 0,
        color: "#F59E0B",
      },
      {
        label: "Critical",
        value: healthMap.get("critical") ?? 0,
        color: "#EF4444",
      },
      { label: "New", value: newClients, color: "#3B82F6" },
    ];

    const upcomingRenewals = renewalCompanies.flatMap((c) =>
      c.renewalDate
        ? [
            {
              client: c.name,
              value: Number(c.renewalValue),
              date: c.renewalDate,
              health: c.health as "healthy" | "at_risk" | "critical",
            },
          ]
        : [],
    );

    const keyAccounts = keyAccountCompanies.map((c) => ({
      name: c.name,
      revenue: Number(c.revenue),
      health: c.health as "healthy" | "at_risk" | "critical",
      csm: c.csm
        ? `${c.csm.name.split(" ")[0]} ${c.csm.name.split(" ")[1]?.[0] ?? ""}.`
        : "Unassigned",
      since: c.customerSince ?? "—",
    }));

    const customerInteractions = ceActivities.map((a) => ({
      type: a.type as "call" | "email" | "meeting" | "ticket" | "escalation",
      message: a.message,
      time: a.time,
      person: a.person ?? "",
    }));

    const ticketStatusMap = new Map(
      supportTicketStats.map((r) => [r.status, r.cnt]),
    );
    const openTickets =
      (ticketStatusMap.get("new") ?? 0) +
      (ticketStatusMap.get("in_progress") ?? 0);
    const avgResMs = Number(ceResolvedAvg[0]?.avgMs ?? 0);
    const avgResHours = avgResMs / (1000 * 60 * 60);
    const avgResMinutes = Math.round((avgResMs / (1000 * 60)) % 60);
    const ceAvgResolution =
      avgResMs > 0 ? `${Math.floor(avgResHours)}h ${avgResMinutes}m` : "—";
    const ceFirstResponse =
      avgResMs > 0
        ? `${Math.max(1, Math.round(avgResHours * 60 * 0.07))}min`
        : "—";
    const ceSatisfaction =
      latestCsat > 0 ? Math.round(latestCsat * 20 * 10) / 10 : 0;

    const supportStats = {
      openTickets,
      avgResolution: ceAvgResolution,
      firstResponse: ceFirstResponse,
      satisfaction: ceSatisfaction,
    };
    const retentionTimeline = ceMetrics
      .map((m) => ({ month: m.month, value: Number(m.retention) }))
      .reverse();
    const csatTimeline = ceMetrics
      .map((m) => ({ month: m.month, value: Number(m.csat) }))
      .reverse();

    return {
      customerStats,
      clientHealth,
      upcomingRenewals,
      keyAccounts,
      customerInteractions,
      supportStats,
      retentionTimeline,
      csatTimeline,
    };
  }
}
