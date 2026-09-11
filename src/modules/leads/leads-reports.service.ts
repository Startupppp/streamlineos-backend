import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, lte, notInArray, sql } from "drizzle-orm";
import { AccessService } from "../access/access.service";
import { leadActivities, users, crmOptions } from "../../db/schema";
import { businessParties, leadPartyMap } from "../../db/schema/party";
import {
  LEAD_PARTY_COLUMNS,
  LEAD_PARTY_JOIN,
  leadPartyScope,
  pushLeadPartyViewScope,
} from "./lead-party-reader";
import { applyScope } from "../access/apply-scope";
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

/**
 * Who a lead report is about.
 *
 * The same shape `getLeadAnalytics` has always taken, named because four more
 * reports now take it. It is not optional on those four: every one of them is
 * reached from a route gated on `crm:leads:view`, the controller resolves the
 * scope for all of them, and a parameter that can be left off is a parameter
 * that gets left off.
 */
export interface LeadsViewScope {
  scope: DataScope;
  userId: string;
}

/**
 * The cache entry belongs to whoever may read it.
 *
 * `cachedVersioned` keys on `${namespace}:v${version}:${key}` and the namespace
 * is the organisation, so a narrowed report reusing the org-wide key would serve
 * one rep's numbers to the next rep AND to the manager who asked for the org's
 * — a worse leak than the one being fixed, and a wrong number besides. `all` and
 * `none` answer the same thing for everyone holding them, so they stay a single
 * shared entry; `own` and `team` fan out per caller, because that is what they
 * mean. Nothing changes for an organisation that grants nobody a narrowed scope:
 * every read still lands on the one `:all` entry.
 */
function scopedCacheKey(key: string, view: LeadsViewScope): string {
  if (view.scope === "all" || view.scope === "none") return `${key}:${view.scope}`;
  return `${key}:${view.scope}:${view.userId}`;
}

/**
 * WHAT A NARROWED LEAD REPORT MEANS, decided once so the screens agree.
 *
 * `crm:leads:view` is declared `scopable: true`, so an organisation may grant a
 * rep `own`. For a list that is unambiguous — you see the leads assigned to you.
 * For a REPORT it is a decision, because narrowing changes what the number is:
 * "conversion rate" becomes MY conversion rate, not the organisation's.
 *
 * The decision is taken, not invented: `getLeadAnalytics` on this same
 * controller, behind this same key, has always narrowed. So a rep at `own`
 * already sees a conversion rate that is theirs. Leaving `dashboard-metrics` and
 * `source-report` org-wide meant the same person read two different conversion
 * rates on two tiles of one screen and had no way to tell which was which — and
 * the org-wide one disclosed exactly the totals the grant was meant to withhold.
 *
 * So: every figure on these reports is over THE LEADS THE CALLER MAY SEE. At
 * `all` — every manager, every org owner, and every organisation that has not
 * granted a narrowed scope to anybody — the predicate is `true` and each number
 * is byte-for-byte what it was.
 *
 * `follow-ups` and `unverified` are not aggregates at all. They are lead lists,
 * carrying name, email, phone, company and free-text follow-up notes, and they
 * were returning every lead in the organisation to a rep restricted to their
 * own. Those are the two that leaked records rather than totals.
 */
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

  /**
   * The dashboard tiles, over the leads the caller may see.
   *
   * This took no caller id at all, so every tile was the organisation's while
   * the analytics screen behind the same `crm:leads:view` key was the rep's. A
   * rep granted `own` read their own conversion rate on one screen and the
   * organisation's on the next, and the organisation believed it had restricted
   * them.
   *
   * The activity counts narrow on who LOGGED the call or meeting rather than on
   * who owns the lead. That is deliberate: `lead_activities` has no owner column
   * and reaching one would mean joining through `lead_party_map`, which would
   * drop activities whose lead has since been deleted — changing the org-wide
   * number for everybody in order to narrow it for one rep. `user_id` is the
   * person who did the work, it is indexed, and at `all` the predicate is `true`
   * so the tile is unchanged.
   */
  getDashboardMetrics(orgId: string, view: LeadsViewScope) {
    return this.cache.cachedVersioned(
      `leads:${orgId}`,
      scopedCacheKey("dashboard-metrics", view),
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

        const byStatusWhere = leadPartyScope(orgId);
        pushLeadPartyViewScope(byStatusWhere, orgId, view.scope, view.userId);

        const followUpWhere = leadPartyScope(orgId);
        pushLeadPartyViewScope(followUpWhere, orgId, view.scope, view.userId);
        followUpWhere.push(
          notInArray(LEAD_PARTY_COLUMNS.status, terminalKeys),
          lt(LEAD_PARTY_COLUMNS.updatedAt, threeDaysAgo),
        );

        const [leadCounts, activityCounts, followUpCount] = await Promise.all([
          this.db
            .select({ status: LEAD_PARTY_COLUMNS.status, cnt: count() })
            .from(leadPartyMap)
            .innerJoin(businessParties, LEAD_PARTY_JOIN)
            .where(and(...byStatusWhere))
            .groupBy(LEAD_PARTY_COLUMNS.status),
          this.db
            .select({ type: leadActivities.type, cnt: count() })
            .from(leadActivities)
            .where(
              and(
                eq(leadActivities.orgId, orgId),
                inArray(leadActivities.type, ["call", "meeting", "site_visit"]),
                applyScope(view.scope, orgId, view.userId, {
                  ownerColumn: leadActivities.userId,
                }),
              ),
            )
            .groupBy(leadActivities.type),
          this.db
            .select({ cnt: count() })
            .from(leadPartyMap)
            .innerJoin(businessParties, LEAD_PARTY_JOIN)
            .where(and(...followUpWhere))
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

  /**
   * The source breakdown, over the leads the caller may see.
   *
   * `getLeadAnalytics` returns this exact breakdown as `conversionBySource` and
   * has always narrowed it. This one did not, so the same person could read
   * "Referral: 40 leads, 12 converted" narrowed on one screen and the
   * organisation's figure on the other, with nothing on either saying which.
   * `totalValue` sums `expected_value` across those leads, so the org-wide
   * version also handed a restricted rep the size of the whole pipeline by
   * channel.
   */
  getSourceReport(orgId: string, view: LeadsViewScope) {
    return this.cache.cachedVersioned(
      `leads:${orgId}`,
      scopedCacheKey("source-report", view),
      async () => {
        const statusOptions = await this.db.select().from(crmOptions)
          .where(and(eq(crmOptions.orgId, orgId), eq(crmOptions.type, "lead_status")));
        const semantics = resolveLeadStatusSemantics(statusOptions);
        const convertedExpr = sql.join(
          semantics.convertedKeys.map((k) => sql`${k}`),
          sql`, `,
        );

        const where = leadPartyScope(orgId);
        pushLeadPartyViewScope(where, orgId, view.scope, view.userId);

        const rows = await this.db
          .select({
            source: LEAD_PARTY_COLUMNS.source,
            count: sql<number>`count(*)::int`,
            converted: sql<number>`count(*) FILTER (WHERE ${LEAD_PARTY_COLUMNS.status} IN (${convertedExpr}))::int`,
            totalValue: sql<number>`COALESCE(SUM(${LEAD_PARTY_COLUMNS.potentialValue}::numeric), 0)::float`,
          })
          .from(leadPartyMap)
          .innerJoin(businessParties, LEAD_PARTY_JOIN)
          .where(and(...where))
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

  /**
   * The follow-ups due, out of the leads the caller may see.
   *
   * Not an aggregate: this returns lead ROWS — name, email, phone, company and
   * the free-text follow-up notes somebody typed about a person. It took no
   * caller id, so a rep granted `own` got up to a hundred of the organisation's
   * leads with contact details attached, from a route gated on the very key that
   * was supposed to be narrowing them.
   */
  async getFollowUps(orgId: string, query: FollowUpsQuery, view: LeadsViewScope) {
    const maxResults = Math.min(query.limit ?? 20, 100);

    const conditions = leadPartyScope(orgId);
    pushLeadPartyViewScope(conditions, orgId, view.scope, view.userId);
    conditions.push(isNotNull(LEAD_PARTY_COLUMNS.followUpDate));
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

  /**
   * The unverified leads, out of the ones the caller may see.
   *
   * The projection is `LEAD_PARTY_COLUMNS` — the WHOLE lead, every column the
   * detail screen shows, up to a hundred of them, plus the assignee. Same defect
   * as `getFollowUps` and the same cost: a rep restricted to their own leads was
   * reading the organisation's book, contact details and notes included.
   */
  async getUnverifiedLeads(orgId: string, view: LeadsViewScope) {
    const statusOptions = await this.db.select().from(crmOptions)
      .where(and(eq(crmOptions.orgId, orgId), eq(crmOptions.type, "lead_status")));
    const semantics = resolveLeadStatusSemantics(statusOptions);
    const activeKeys = semantics.activeKeys.length > 0 ? semantics.activeKeys : ["NEW"];

    const where = leadPartyScope(orgId);
    pushLeadPartyViewScope(where, orgId, view.scope, view.userId);
    where.push(
      inArray(LEAD_PARTY_COLUMNS.status, activeKeys),
      isNull(LEAD_PARTY_COLUMNS.verifiedById),
    );

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
      .where(and(...where))
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
