import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, lte, notInArray, sql } from "drizzle-orm";
import { AccessService } from "../access/access.service";
import { leadActivities, users, crmOptions } from "../../db/schema";
import { businessParties, leadPartyMap } from "../../db/schema/party";
import {
  LEAD_PARTY_COLUMNS,
  LEAD_PARTY_JOIN,
  leadPartyScope,
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
import { getLeadAnalytics, type LeadAnalyticsDeps } from "./lib/lead-analytics-report";

@Injectable()
export class LeadsReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly teamReports: LeadsReportsTeamService,
    private readonly access: AccessService,
  ) {}

  /** Bound once so the extracted report sees the same injected instances. */
  private get analyticsDeps(): LeadAnalyticsDeps {
    return { db: this.db, access: this.access };
  }

  getLeadAnalytics(
    orgId: string,
    filters: AnalyticsQuery,
    viewScope?: { scope: DataScope; userId: string },
  ) {
    return getLeadAnalytics(this.analyticsDeps, orgId, filters, viewScope);
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

    const results = await this.db
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
        _total: sql<string>`count(*) OVER ()`,
      })
      .from(leadPartyMap)
      .innerJoin(businessParties, LEAD_PARTY_JOIN)
      .leftJoin(users, eq(LEAD_PARTY_COLUMNS.assignedToId, users.id))
      .where(and(...conditions))
      .orderBy(asc(LEAD_PARTY_COLUMNS.followUpDate), asc(LEAD_PARTY_COLUMNS.id))
      .limit(maxResults);

    const total = results.length > 0 ? Number(results[0]._total) : 0;

    return { items: results.map(({ _total, ...r }) => r), total };
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
