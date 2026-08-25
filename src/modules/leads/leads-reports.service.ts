import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, notInArray, sql } from "drizzle-orm";
import { AccessService } from "../access/access.service";
import {
  leadActivities,
  deals,
  users,
  crmOptions,
  crmPipelineStages,
} from "../../db/schema";
import { businessParties, leadPartyMap } from "../../db/schema/party";
import {
  LEAD_PARTY_COLUMNS,
  LEAD_PARTY_JOIN,
  leadPartyScope,
  pushLeadPartyViewScope,
} from "./lead-party-reader";
import { resolveLeadStatusSemantics } from "./lead-status-semantics";
import type {
  AnalyticsQuery,
  FollowUpsQuery,
} from "./dto/lead-reports.schemas";
import { type Db } from "../../db/drizzle.module";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { DataScope } from "../access/access.types";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import { CacheService } from "../../common/cache/cache.service";
import { LeadsReportsTeamService } from "./leads-reports-team.service";

@Injectable()
export class LeadsReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly teamReports: LeadsReportsTeamService,
    private readonly access: AccessService,
  ) {}

  async getLeadAnalytics(
    orgId: string,
    filters: AnalyticsQuery,
    viewScope?: { scope: DataScope; userId: string },
  ) {
    const f = leadPartyScope(orgId);
    pushLeadPartyViewScope(f, orgId, viewScope?.scope, viewScope?.userId);
    if (filters.dateFrom)
      f.push(gte(LEAD_PARTY_COLUMNS.createdAt, new Date(filters.dateFrom)));
    if (filters.dateTo)
      f.push(lte(LEAD_PARTY_COLUMNS.createdAt, new Date(filters.dateTo + "T23:59:59")));

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    const statusOptions = await this.db
      .select()
      .from(crmOptions)
      .where(and(eq(crmOptions.orgId, orgId), eq(crmOptions.type, "lead_status")));
    const semantics = resolveLeadStatusSemantics(statusOptions);

    const convertedExpr =
      semantics.convertedKeys.length > 0
        ? sql`${LEAD_PARTY_COLUMNS.status} = ANY(ARRAY[${sql.join(
            semantics.convertedKeys.map((k) => sql`${k}`),
            sql`, `,
          )}])`
        : sql`false`;

    const [totalsRows, prevPeriodRows, wonStages, sourceRows, assignRows, permittedMembers] =
      await Promise.all([
        this.db
          .select({
            total: sql<number>`COUNT(*)::int`,
            converted: sql<number>`COUNT(*) FILTER (WHERE ${convertedExpr})::int`,
          })
          .from(leadPartyMap)
          .innerJoin(businessParties, LEAD_PARTY_JOIN)
          .where(and(...f)),
        this.db
          .select({
            total: sql<number>`COUNT(*)::int`,
            converted: sql<number>`COUNT(*) FILTER (WHERE ${convertedExpr})::int`,
          })
          .from(leadPartyMap)
          .innerJoin(businessParties, LEAD_PARTY_JOIN)
          .where(
            and(
              ...leadPartyScope(orgId),
              gte(LEAD_PARTY_COLUMNS.createdAt, sixtyDaysAgo),
              lte(LEAD_PARTY_COLUMNS.createdAt, thirtyDaysAgo),
            ),
          ),
        this.db
          .select({ key: crmPipelineStages.key })
          .from(crmPipelineStages)
          .where(
            and(
              eq(crmPipelineStages.orgId, orgId),
              eq(crmPipelineStages.stageType, "won"),
            ),
          ),
        this.db
          .select({
            source: LEAD_PARTY_COLUMNS.source,
            total: sql<number>`COUNT(*)::int`,
            converted: sql<number>`COUNT(*) FILTER (WHERE ${convertedExpr})::int`,
          })
          .from(leadPartyMap)
          .innerJoin(businessParties, LEAD_PARTY_JOIN)
          .where(and(...f))
          .groupBy(LEAD_PARTY_COLUMNS.source),
        this.db
          .select({
            assignedToId: LEAD_PARTY_COLUMNS.assignedToId,
            cnt: sql<number>`COUNT(*)::int`,
          })
          .from(leadPartyMap)
          .innerJoin(businessParties, LEAD_PARTY_JOIN)
          .where(and(...f, isNotNull(LEAD_PARTY_COLUMNS.assignedToId)))
          .groupBy(LEAD_PARTY_COLUMNS.assignedToId),
        this.access.membersWithPermission(orgId, "crm:leads:view"),
      ]);

    const permittedUserIds = permittedMembers.map((m) => m.userId);
    const salesUsers = permittedUserIds.length > 0
      ? await this.db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, permittedUserIds))
      : [];

    const totalLeads = totalsRows[0]?.total ?? 0;
    const converted = totalsRows[0]?.converted ?? 0;
    const conversionRate =
      totalLeads > 0 ? Math.round((converted / totalLeads) * 100) : 0;

    const prevTotal = prevPeriodRows[0]?.total ?? 0;
    const prevConverted = prevPeriodRows[0]?.converted ?? 0;
    const prevConversionRate =
      prevTotal > 0 ? Math.round((prevConverted / prevTotal) * 100) : 0;

    const wonStageKeys = wonStages.length ? wonStages.map((s) => s.key) : ["WON"];

    const [revenueRow, wonDeals] = await Promise.all([
      this.db
        .select({
          totalRevenue: sql<number>`COALESCE(SUM(${deals.value}::numeric), 0)::float`,
        })
        .from(deals)
        .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), inArray(deals.stage, wonStageKeys)))
        .then((r) => r[0]),
      this.db
        .select({ value: deals.value, createdAt: deals.createdAt })
        .from(deals)
        .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), inArray(deals.stage, wonStageKeys))),
    ]);

    const totalRevenue = revenueRow?.totalRevenue ?? 0;

    const conversionBySource: {
      source: string;
      total: number;
      converted: number;
      rate: number;
    }[] = sourceRows.map((r) => ({
      source: r.source.replace(/_/g, " "),
      total: r.total,
      converted: r.converted,
      rate: r.total > 0 ? Math.round((r.converted / r.total) * 100) : 0,
    }));

    const monthMap = new Map<string, number>();
    for (const d of wonDeals) {
      const date = d.createdAt;
      if (!date) continue;
      const m = new Date(date);
      const key = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`;
      monthMap.set(key, (monthMap.get(key) ?? 0) + Number(d.value ?? 0));
    }
    const monthlyRevenue = [...monthMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-6)
      .map(([month, revenue]) => ({ month, revenue }));

    const assignMap = new Map<string, number>();
    for (const row of assignRows) {
      if (row.assignedToId) assignMap.set(row.assignedToId, row.cnt);
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

  getDashboardMetrics(orgId: string) {
    return this.cache.cachedVersioned(
      `leads:${orgId}`,
      "dashboard-metrics",
      async () => {
        const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

        const statusOptions = await this.db
          .select()
          .from(crmOptions)
          .where(
            and(eq(crmOptions.orgId, orgId), eq(crmOptions.type, "lead_status")),
          );
        const semantics = resolveLeadStatusSemantics(statusOptions);
        const terminalKeys = [...semantics.convertedKeys, ...semantics.lostKeys];

        const [leadCounts, activityCounts, followUpCount] = await Promise.all([
          this.db
            .select({ status: LEAD_PARTY_COLUMNS.status, cnt: count() })
            .from(leadPartyMap)
            .innerJoin(businessParties, LEAD_PARTY_JOIN)
            .where(and(...leadPartyScope(orgId)))
            .groupBy(LEAD_PARTY_COLUMNS.status),
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
            .from(leadPartyMap)
            .innerJoin(businessParties, LEAD_PARTY_JOIN)
            .where(
              and(
                ...leadPartyScope(orgId),
                notInArray(LEAD_PARTY_COLUMNS.status, terminalKeys),
                lt(LEAD_PARTY_COLUMNS.updatedAt, threeDaysAgo),
              ),
            )
            .then((r) => r[0]?.cnt ?? 0),
        ]);

        const byStatus: Record<string, number> = {};
        for (const r of leadCounts) byStatus[r.status] = r.cnt;
        const byType: Record<string, number> = {};
        for (const r of activityCounts) byType[r.type] = r.cnt;

        const activeClients = semantics.convertedKeys.reduce(
          (s, k) => s + (byStatus[k] ?? 0),
          0,
        );
        const inactiveClients = semantics.lostKeys.reduce(
          (s, k) => s + (byStatus[k] ?? 0),
          0,
        );
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
      },
      CACHE_TTL.SHORT,
    );
  }

  getSourceReport(orgId: string) {
    return this.cache.cachedVersioned(
      `leads:${orgId}`,
      "source-report",
      async () => {
        const statusOptions = await this.db.select().from(crmOptions)
          .where(and(eq(crmOptions.orgId, orgId), eq(crmOptions.type, "lead_status")));
        const semantics = resolveLeadStatusSemantics(statusOptions);
        const convertedExpr = sql.join(
          semantics.convertedKeys.map((k) => sql`${k}`),
          sql`, `,
        );

        const rows = await this.db
          .select({
            source: LEAD_PARTY_COLUMNS.source,
            count: sql<number>`count(*)::int`,
            converted: sql<number>`count(*) FILTER (WHERE ${LEAD_PARTY_COLUMNS.status} IN (${convertedExpr}))::int`,
            totalValue: sql<number>`COALESCE(SUM(${LEAD_PARTY_COLUMNS.potentialValue}::numeric), 0)::float`,
          })
          .from(leadPartyMap)
          .innerJoin(businessParties, LEAD_PARTY_JOIN)
          .where(and(...leadPartyScope(orgId)))
          .groupBy(LEAD_PARTY_COLUMNS.source)
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

  getSalesLeaderboard(orgId: string) {
    return this.teamReports.getSalesLeaderboard(orgId);
  }

  getSalesTeamCapacity(orgId: string) {
    return this.teamReports.getSalesTeamCapacity(orgId);
  }

  getLeadSlaAlerts(orgId: string, opts: { ownScope?: boolean; userId?: string }) {
    return this.teamReports.getLeadSlaAlerts(orgId, opts);
  }

  async getFollowUps(orgId: string, query: FollowUpsQuery) {
    const maxResults = Math.min(query.limit ?? 20, 100);

    const conditions = [
      ...leadPartyScope(orgId),
      isNotNull(LEAD_PARTY_COLUMNS.followUpDate),
    ];
    if (query.overdue === "true") {
      conditions.push(lte(LEAD_PARTY_COLUMNS.followUpDate, new Date()));
    }

    const [results, totalRow] = await Promise.all([
      this.db
        .select({
          id: LEAD_PARTY_COLUMNS.id,
          name: LEAD_PARTY_COLUMNS.name,
          email: LEAD_PARTY_COLUMNS.email,
          phone: LEAD_PARTY_COLUMNS.phone,
          company: LEAD_PARTY_COLUMNS.company,
          status: LEAD_PARTY_COLUMNS.status,
          priority: LEAD_PARTY_COLUMNS.priority,
          followUpDate: LEAD_PARTY_COLUMNS.followUpDate,
          followUpNotes: LEAD_PARTY_COLUMNS.followUpNotes,
          assignedToId: LEAD_PARTY_COLUMNS.assignedToId,
          assigneeName: users.name,
        })
        .from(leadPartyMap)
        .innerJoin(businessParties, LEAD_PARTY_JOIN)
        .leftJoin(users, eq(LEAD_PARTY_COLUMNS.assignedToId, users.id))
        .where(and(...conditions))
        .orderBy(asc(LEAD_PARTY_COLUMNS.followUpDate), asc(LEAD_PARTY_COLUMNS.id))
        .limit(maxResults),
      this.db
        .select({ cnt: count() })
        .from(leadPartyMap)
        .innerJoin(businessParties, LEAD_PARTY_JOIN)
        .where(and(...conditions))
        .then((r) => r[0]?.cnt ?? 0),
    ]);

    return { items: results, total: totalRow };
  }

  async getUnverifiedLeads(orgId: string) {
    const statusOptions = await this.db.select().from(crmOptions)
      .where(and(eq(crmOptions.orgId, orgId), eq(crmOptions.type, "lead_status")));
    const semantics = resolveLeadStatusSemantics(statusOptions);
    const activeKeys = semantics.activeKeys.length > 0 ? semantics.activeKeys : ["NEW"];

    const rows = await this.db
      .select({
        lead: LEAD_PARTY_COLUMNS,
        assigneeId: users.id,
        assigneeName: users.name,
        assigneeImage: users.image,
      })
      .from(leadPartyMap)
      .innerJoin(businessParties, LEAD_PARTY_JOIN)
      .leftJoin(users, eq(LEAD_PARTY_COLUMNS.assignedToId, users.id))
      .where(
        and(
          ...leadPartyScope(orgId),
          inArray(LEAD_PARTY_COLUMNS.status, activeKeys),
          isNull(LEAD_PARTY_COLUMNS.verifiedById),
        ),
      )
      .orderBy(desc(LEAD_PARTY_COLUMNS.createdAt), desc(LEAD_PARTY_COLUMNS.id))
      .limit(100);

    return rows.map((row) => ({
      ...row.lead,
      assignedTo: row.assigneeId
        ? { id: row.assigneeId, name: row.assigneeName, image: row.assigneeImage }
        : null,
    }));
  }
}
