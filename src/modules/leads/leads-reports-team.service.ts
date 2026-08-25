import { Inject, Injectable } from "@nestjs/common";
import { eq, and, asc, inArray, isNull, notInArray, sql, lte, isNotNull } from "drizzle-orm";
import { AccessService } from "../access/access.service";
import {
  leadActivities,
  users,
  crmOptions,
} from "../../db/schema";
import { businessParties, leadPartyMap } from "../../db/schema/party";
import {
  LEAD_PARTY_COLUMNS,
  LEAD_PARTY_JOIN,
  leadPartyScope,
} from "./lead-party-reader";
import { resolveLeadStatusSemantics } from "./lead-status-semantics";
import { type Db } from "../../db/drizzle.module";
import { DRIZZLE } from "../../db/drizzle.constants";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";

@Injectable()
export class LeadsReportsTeamService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly access: AccessService,
  ) {}

  async getSalesLeaderboard(orgId: string) {
    return this.cache.cachedVersioned(
      `leads:${orgId}`,
      "leaderboard",
      async () => {
        const statusOptions = await this.db
          .select()
          .from(crmOptions)
          .where(
            and(
              eq(crmOptions.orgId, orgId),
              eq(crmOptions.type, "lead_status"),
            ),
          );
        const semantics = resolveLeadStatusSemantics(statusOptions);

        const convertedKeysArr = semantics.convertedKeys;
        const activityTypes = ["call", "meeting", "site_visit", "email"] as const;

        const convertedExpr =
          convertedKeysArr.length > 0
            ? sql`${LEAD_PARTY_COLUMNS.status} = ANY(ARRAY[${sql.join(
                convertedKeysArr.map((k) => sql`${k}`),
                sql`, `,
              )}])`
            : sql`false`;

        const [leadAggs, activityAggs] = await Promise.all([
          this.db
            .select({
              assignedToId: LEAD_PARTY_COLUMNS.assignedToId,
              leadsAssigned: sql<number>`COUNT(*)::int`,
              leadsConverted: sql<number>`COUNT(*) FILTER (WHERE ${convertedExpr})::int`,
              totalRevenue: sql<number>`COALESCE(SUM(${LEAD_PARTY_COLUMNS.potentialValue}::numeric) FILTER (WHERE ${convertedExpr}), 0)::float`,
            })
            .from(leadPartyMap)
            .innerJoin(businessParties, LEAD_PARTY_JOIN)
            .where(
              and(...leadPartyScope(orgId), isNotNull(LEAD_PARTY_COLUMNS.assignedToId)),
            )
            .groupBy(LEAD_PARTY_COLUMNS.assignedToId),
          this.db
            .select({
              userId: leadActivities.userId,
              type: leadActivities.type,
              cnt: sql<number>`COUNT(*)::int`,
            })
            .from(leadActivities)
            .where(
              and(
                eq(leadActivities.orgId, orgId),
                inArray(leadActivities.type, [...activityTypes]),
              ),
            )
            .groupBy(leadActivities.userId, leadActivities.type),
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

        for (const row of leadAggs) {
          if (!row.assignedToId) continue;
          const entry = userMap.get(row.assignedToId) ?? emptyStats();
          entry.leadsAssigned = row.leadsAssigned;
          entry.leadsConverted = row.leadsConverted;
          entry.totalRevenue = row.totalRevenue;
          userMap.set(row.assignedToId, entry);
        }

        for (const row of activityAggs) {
          const entry = userMap.get(row.userId) ?? emptyStats();
          if (row.type === "call") entry.totalCalls = row.cnt;
          if (row.type === "meeting" || row.type === "site_visit")
            entry.totalMeetings += row.cnt;
          if (row.type === "email") entry.totalEmails = row.cnt;
          userMap.set(row.userId, entry);
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
      },
      CACHE_TTL.MEDIUM,
    );
  }

  async getSalesTeamCapacity(orgId: string) {
    return this.cache.cachedVersioned(
      `leads:${orgId}`,
      "team-capacity",
      async () => {
        const [permittedMembers, statusOptions] = await Promise.all([
          this.access.membersWithPermission(orgId, "crm:leads:view"),
          this.db
            .select()
            .from(crmOptions)
            .where(
              and(
                eq(crmOptions.orgId, orgId),
                eq(crmOptions.type, "lead_status"),
              ),
            ),
        ]);

        const permittedUserIds = new Set(permittedMembers.map((m) => m.userId));
        const salesUsersData = permittedUserIds.size > 0
          ? await this.db.query.users.findMany({
              where: inArray(users.id, [...permittedUserIds]),
              columns: { id: true, name: true, image: true },
            })
          : [];
        const salesUsers = salesUsersData;

        const semantics = resolveLeadStatusSemantics(statusOptions);
        const terminalKeys = [...semantics.convertedKeys, ...semantics.lostKeys];

        const countRows =
          terminalKeys.length > 0
            ? await this.db
                .select({
                  assignedToId: LEAD_PARTY_COLUMNS.assignedToId,
                  cnt: sql<number>`COUNT(*)::int`,
                })
                .from(leadPartyMap)
                .innerJoin(businessParties, LEAD_PARTY_JOIN)
                .where(
                  and(
                    ...leadPartyScope(orgId),
                    notInArray(LEAD_PARTY_COLUMNS.status, terminalKeys),
                    isNotNull(LEAD_PARTY_COLUMNS.assignedToId),
                  ),
                )
                .groupBy(LEAD_PARTY_COLUMNS.assignedToId)
            : [];

        const countMap = new Map<string, number>();
        for (const row of countRows) {
          if (row.assignedToId) countMap.set(row.assignedToId, row.cnt);
        }

        return salesUsers.map((u) => ({
          id: u.id,
          name: u.name,
          image: u.image,
          activeLeads: countMap.get(u.id) ?? 0,
        }));
      },
      CACHE_TTL.SHORT,
    );
  }

  async getLeadSlaAlerts(
    orgId: string,
    opts: { ownScope?: boolean; userId?: string },
  ) {
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const statusOptions = await this.db
      .select()
      .from(crmOptions)
      .where(
        and(eq(crmOptions.orgId, orgId), eq(crmOptions.type, "lead_status")),
      );
    const semantics = resolveLeadStatusSemantics(statusOptions);

    const slaFilters = [
      ...leadPartyScope(orgId),
      inArray(LEAD_PARTY_COLUMNS.status, semantics.slaOpenKeys),
      lte(LEAD_PARTY_COLUMNS.updatedAt, twentyFourHoursAgo),
    ];
    if (opts.ownScope && opts.userId) {
      slaFilters.push(eq(LEAD_PARTY_COLUMNS.assignedToId, opts.userId));
    }

    const slaLeads = await this.db
      .select({
        id: LEAD_PARTY_COLUMNS.id,
        name: LEAD_PARTY_COLUMNS.name,
        status: LEAD_PARTY_COLUMNS.status,
        priority: LEAD_PARTY_COLUMNS.priority,
        updatedAt: LEAD_PARTY_COLUMNS.updatedAt,
        createdAt: LEAD_PARTY_COLUMNS.createdAt,
        assigneeName: users.name,
      })
      .from(leadPartyMap)
      .innerJoin(businessParties, LEAD_PARTY_JOIN)
      .leftJoin(users, eq(LEAD_PARTY_COLUMNS.assignedToId, users.id))
      .where(and(...slaFilters))
      // Oldest first, where the query this replaces had no order at all: with a
      // cap of 100 and no ORDER BY, an org with more breaches than that showed an
      // arbitrary hundred of them and called the worst ones missing.
      .orderBy(asc(LEAD_PARTY_COLUMNS.updatedAt), asc(LEAD_PARTY_COLUMNS.id))
      .limit(100);

    const slaBreached = slaLeads.map((lead) => {
      const updatedAt = lead.updatedAt
        ? new Date(lead.updatedAt)
        : lead.createdAt
          ? new Date(lead.createdAt)
          : now;
      const hoursSince = Math.round(
        (now.getTime() - updatedAt.getTime()) / (1000 * 60 * 60),
      );
      return {
        leadId: lead.id,
        leadName: lead.name,
        status: lead.status,
        assignedTo: lead.assigneeName ?? null,
        hoursSinceUpdate: hoursSince,
        priority: lead.priority,
      };
    });

    slaBreached.sort((a, b) => b.hoursSinceUpdate - a.hoursSinceUpdate);
    return { total: slaBreached.length, leads: slaBreached };
  }
}
