import { Inject, Injectable } from "@nestjs/common";
import {
  eq,
  and,
  desc,
  asc,
  sql,
  gte,
  lte,
  lt,
  count,
  inArray,
  isNotNull,
} from "drizzle-orm";
import {
  leads,
  leadActivities,
  deals,
  users,
  organizationMembers,
} from "../../db/schema";
import type {
  AnalyticsQuery,
  FollowUpsQuery,
} from "./dto/lead-reports.schemas";
import { type Db } from "../../db/drizzle.module";
import { applyScope } from "../access/apply-scope";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { DataScope } from "../access/access.types";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import { CacheService } from "../../common/cache/cache.service";

@Injectable()
export class LeadsReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async getLeadAnalytics(
    orgId: string,
    filters: AnalyticsQuery,
    viewScope?: { scope: DataScope; userId: string },
  ) {
    const f = [eq(leads.orgId, orgId)];
    if (viewScope)
      f.push(
        applyScope(viewScope.scope, viewScope.userId, {
          ownerColumn: leads.assignedToId,
        }),
      );
    if (filters.dateFrom)
      f.push(gte(leads.createdAt, new Date(filters.dateFrom)));
    if (filters.dateTo)
      f.push(lte(leads.createdAt, new Date(filters.dateTo + "T23:59:59")));

    const allLeadsData = await this.db.query.leads.findMany({
      where: and(...f),
      columns: {
        id: true,
        status: true,
        source: true,
        assignedToId: true,
        createdAt: true,
        potentialValue: true,
      },
    });

    const totalLeads = allLeadsData.length;
    const converted = allLeadsData.filter(
      (l) => l.status === "CONVERTED",
    ).length;
    const conversionRate =
      totalLeads > 0 ? Math.round((converted / totalLeads) * 100) : 0;

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    const prevPeriodLeads = await this.db.query.leads.findMany({
      where: and(
        eq(leads.orgId, orgId),
        gte(leads.createdAt, sixtyDaysAgo),
        lte(leads.createdAt, thirtyDaysAgo),
      ),
      columns: { id: true, status: true },
    });
    const prevTotal = prevPeriodLeads.length;
    const prevConverted = prevPeriodLeads.filter(
      (l) => l.status === "CONVERTED",
    ).length;
    const prevConversionRate =
      prevTotal > 0 ? Math.round((prevConverted / prevTotal) * 100) : 0;

    const wonDeals = await this.db.query.deals.findMany({
      where: and(eq(deals.orgId, orgId), eq(deals.stage, "WON")),
      columns: { value: true, createdAt: true },
    });
    const totalRevenue = wonDeals.reduce(
      (sum, d) => sum + Number(d.value ?? 0),
      0,
    );

    const conversionBySource: {
      source: string;
      total: number;
      converted: number;
      rate: number;
    }[] = [];
    const sourceMap = new Map<string, { total: number; converted: number }>();
    for (const l of allLeadsData) {
      const src = l.source ?? "other";
      const entry = sourceMap.get(src) || { total: 0, converted: 0 };
      entry.total++;
      if (l.status === "CONVERTED") entry.converted++;
      sourceMap.set(src, entry);
    }
    for (const [source, data] of sourceMap) {
      conversionBySource.push({
        source: source.replace(/_/g, " "),
        total: data.total,
        converted: data.converted,
        rate:
          data.total > 0 ? Math.round((data.converted / data.total) * 100) : 0,
      });
    }

    const monthlyRevenue: { month: string; revenue: number }[] = [];
    const monthMap = new Map<string, number>();
    for (const d of wonDeals) {
      const date = d.createdAt;
      if (!date) continue;
      const m = new Date(date);
      const key = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`;
      monthMap.set(key, (monthMap.get(key) ?? 0) + Number(d.value ?? 0));
    }
    const sortedMonths = [...monthMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-6);
    for (const [month, revenue] of sortedMonths) {
      monthlyRevenue.push({ month, revenue });
    }

    const orgMembers = await this.db.query.organizationMembers.findMany({
      where: eq(organizationMembers.orgId, orgId),
      with: { user: { columns: { id: true, name: true, role: true } } },
    });
    const salesUsers = orgMembers
      .filter((m) => m.user.role === "SALES")
      .map((m) => m.user);
    const assignMap = new Map<string, number>();
    for (const l of allLeadsData) {
      if (l.assignedToId)
        assignMap.set(l.assignedToId, (assignMap.get(l.assignedToId) ?? 0) + 1);
    }
    const assignmentDistribution = salesUsers.map((u) => ({
      userId: u.id,
      name: u.name ?? "Unknown",
      count: assignMap.get(u.id) ?? 0,
    }));

    return {
      totalLeads,
      totalLeadsPrevPeriod: prevTotal,
      conversionRate,
      conversionRatePrevPeriod: prevConversionRate,
      totalRevenue,
      conversionBySource,
      monthlyRevenue,
      assignmentDistribution,
    };
  }

  async getDashboardMetrics(orgId: string) {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    const [leadCounts, activityCounts, followUpCount] = await Promise.all([
      this.db
        .select({ status: leads.status, cnt: count() })
        .from(leads)
        .where(eq(leads.orgId, orgId))
        .groupBy(leads.status),
      this.db
        .select({ type: leadActivities.type, cnt: count() })
        .from(leadActivities)
        .where(
          and(
            eq(leadActivities.orgId, orgId),
            inArray(leadActivities.type, ["call", "meeting", "site_visit"]),
          ),
        )
        .groupBy(leadActivities.type),
      this.db
        .select({ cnt: count() })
        .from(leads)
        .where(
          and(
            eq(leads.orgId, orgId),
            sql`${leads.status} NOT IN ('CONVERTED','LOST')`,
            lt(leads.updatedAt, threeDaysAgo),
          ),
        )
        .then((r) => r[0]?.cnt ?? 0),
    ]);

    const byStatus: Record<string, number> = {};
    for (const r of leadCounts) byStatus[r.status] = r.cnt;
    const byType: Record<string, number> = {};
    for (const r of activityCounts) byType[r.type] = r.cnt;

    const activeClients = byStatus["CONVERTED"] ?? 0;
    const inactiveClients = byStatus["LOST"] ?? 0;
    const totalLeads = Object.values(byStatus).reduce((s, n) => s + n, 0);

    return {
      activeClients,
      inactiveClients,
      totalCalls: byType["call"] ?? 0,
      inPersonMeetings: (byType["meeting"] ?? 0) + (byType["site_visit"] ?? 0),
      followUpDue: followUpCount,
      totalLeads,
      conversionRate:
        totalLeads > 0
          ? Math.round((activeClients / totalLeads) * 1000) / 10
          : 0,
    };
  }

  getSourceReport(orgId: string) {
    return this.cache.cached(
      `leads:source-report:${orgId}`,
      async () => {
        const rows = await this.db
          .select({
            source: sql<string>`COALESCE(${leads.source}::text, 'other')`,
            count: sql<number>`count(*)::int`,
            converted: sql<number>`count(*) FILTER (WHERE ${leads.status} = 'CONVERTED')::int`,
            totalValue: sql<number>`COALESCE(SUM(${leads.potentialValue}::numeric), 0)::float`,
          })
          .from(leads)
          .where(eq(leads.orgId, orgId))
          .groupBy(sql`COALESCE(${leads.source}::text, 'other')`)
          .orderBy(sql`count(*) desc`);

        const total = rows.reduce((sum, r) => sum + r.count, 0);

        const sources = rows.map((r) => ({
          source: r.source,
          count: r.count,
          converted: r.converted,
          conversionRate:
            r.count > 0 ? Math.round((r.converted / r.count) * 100) : 0,
          totalValue: r.totalValue,
        }));

        return { sources, total };
      },
      CACHE_TTL.MEDIUM,
    );
  }

  async getSalesLeaderboard(orgId: string) {
    const [allLeads, allActivities] = await Promise.all([
      this.db.query.leads.findMany({
        where: eq(leads.orgId, orgId),
        columns: {
          id: true,
          status: true,
          assignedToId: true,
          potentialValue: true,
        },
      }),
      this.db.query.leadActivities.findMany({
        where: eq(leadActivities.orgId, orgId),
        columns: { id: true, type: true, userId: true },
      }),
    ]);

    type Stats = {
      totalCalls: number;
      totalMeetings: number;
      totalEmails: number;
      leadsAssigned: number;
      leadsConverted: number;
      totalRevenue: number;
      score: number;
    };
    const emptyStats = (): Stats => ({
      totalCalls: 0,
      totalMeetings: 0,
      totalEmails: 0,
      leadsAssigned: 0,
      leadsConverted: 0,
      totalRevenue: 0,
      score: 0,
    });
    const userMap = new Map<string, Stats>();

    for (const lead of allLeads) {
      if (!lead.assignedToId) continue;
      const entry = userMap.get(lead.assignedToId) || emptyStats();
      entry.leadsAssigned++;
      if (lead.status === "CONVERTED") {
        entry.leadsConverted++;
        entry.totalRevenue += Number(lead.potentialValue ?? 0);
      }
      userMap.set(lead.assignedToId, entry);
    }

    for (const activity of allActivities) {
      const entry = userMap.get(activity.userId) || emptyStats();
      if (activity.type === "call") entry.totalCalls++;
      if (activity.type === "meeting" || activity.type === "site_visit")
        entry.totalMeetings++;
      if (activity.type === "email") entry.totalEmails++;
      userMap.set(activity.userId, entry);
    }

    for (const [, entry] of userMap) {
      entry.score =
        entry.leadsConverted * 50 +
        entry.totalCalls * 5 +
        entry.totalMeetings * 10 +
        entry.totalEmails * 3;
    }

    const userIds = Array.from(userMap.keys());
    const usersData =
      userIds.length > 0
        ? await this.db.query.users.findMany({
            where: inArray(users.id, userIds),
            columns: { id: true, name: true, image: true },
          })
        : [];

    const userLookup = new Map(usersData.map((u) => [u.id, u]));

    return Array.from(userMap.entries())
      .map(([userId, data]) => ({
        userId,
        name: userLookup.get(userId)?.name ?? "Unknown",
        image: userLookup.get(userId)?.image ?? null,
        ...data,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
  }

  async getSalesTeamCapacity(orgId: string) {
    const salesMembers = await this.db.query.organizationMembers.findMany({
      where: eq(organizationMembers.orgId, orgId),
      with: {
        user: { columns: { id: true, name: true, image: true, role: true } },
      },
    });
    const salesUsers = salesMembers
      .filter((m) => m.user.role === "SALES")
      .map((m) => m.user);

    const activeLeadsList = await this.db.query.leads.findMany({
      where: and(
        eq(leads.orgId, orgId),
        sql`${leads.status} NOT IN ('CONVERTED', 'LOST')`,
        sql`${leads.assignedToId} IS NOT NULL`,
      ),
      columns: { assignedToId: true },
    });

    const countMap = new Map<string, number>();
    for (const l of activeLeadsList) {
      if (l.assignedToId)
        countMap.set(l.assignedToId, (countMap.get(l.assignedToId) || 0) + 1);
    }

    return salesUsers.map((u) => ({
      id: u.id,
      name: u.name,
      image: u.image,
      activeLeads: countMap.get(u.id) || 0,
    }));
  }

  async getLeadSlaAlerts(
    orgId: string,
    opts: { role?: string; userId?: string },
  ) {
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const slaFilters = [
      eq(leads.orgId, orgId),
      sql`${leads.status} IN ('NEW', 'CONTACTED', 'INTERESTED', 'QUALIFIED')`,
    ];
    if (opts.role === "SALES" && opts.userId) {
      slaFilters.push(eq(leads.assignedToId, opts.userId));
    }

    const allLeads = await this.db.query.leads.findMany({
      where: and(...slaFilters),
      with: { assignedTo: { columns: { id: true, name: true } } },
    });

    const slaBreached: {
      leadId: number;
      leadName: string;
      status: string;
      assignedTo: string | null;
      hoursSinceUpdate: number;
      priority: string | null;
    }[] = [];

    for (const lead of allLeads) {
      const updatedAt = lead.updatedAt
        ? new Date(lead.updatedAt)
        : lead.createdAt
          ? new Date(lead.createdAt)
          : now;

      if (updatedAt < twentyFourHoursAgo) {
        const hoursSince = Math.round(
          (now.getTime() - updatedAt.getTime()) / (1000 * 60 * 60),
        );
        slaBreached.push({
          leadId: lead.id,
          leadName: lead.name,
          status: lead.status,
          assignedTo: lead.assignedTo?.name || null,
          hoursSinceUpdate: hoursSince,
          priority: lead.priority,
        });
      }
    }

    slaBreached.sort((a, b) => b.hoursSinceUpdate - a.hoursSinceUpdate);
    return { total: slaBreached.length, leads: slaBreached };
  }

  async getFollowUps(orgId: string, query: FollowUpsQuery) {
    const maxResults = query.limit ?? 20;

    const conditions = [eq(leads.orgId, orgId), isNotNull(leads.followUpDate)];
    if (query.overdue === "true") {
      conditions.push(lte(leads.followUpDate, new Date()));
    }

    const results = await this.db
      .select({
        id: leads.id,
        name: leads.name,
        email: leads.email,
        phone: leads.phone,
        company: leads.company,
        status: leads.status,
        priority: leads.priority,
        followUpDate: leads.followUpDate,
        followUpNotes: leads.followUpNotes,
        assignedToId: leads.assignedToId,
        assigneeName: users.name,
      })
      .from(leads)
      .leftJoin(users, eq(leads.assignedToId, users.id))
      .where(and(...conditions))
      .orderBy(asc(leads.followUpDate))
      .limit(maxResults);

    return { items: results, total: results.length };
  }

  getUnverifiedLeads(orgId: string) {
    return this.db.query.leads.findMany({
      where: and(
        eq(leads.orgId, orgId),
        eq(leads.status, "NEW"),
        sql`${leads.verifiedById} IS NULL`,
      ),
      with: { assignedTo: { columns: { id: true, name: true, image: true } } },
      orderBy: [desc(leads.createdAt)],
    });
  }
}
