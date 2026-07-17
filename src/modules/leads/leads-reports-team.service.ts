import { Inject, Injectable } from "@nestjs/common";
import { eq, and, inArray, notInArray, sql, lte, isNotNull } from "drizzle-orm";
import {
  leads,
  leadActivities,
  users,
  organizationMembers,
  crmOptions,
} from "../../db/schema";
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
  ) {}

  async getSalesLeaderboard(orgId: string) {
    return this.cache.cached(
      `leads:leaderboard:${orgId}`,
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
            ? sql`${leads.status} = ANY(ARRAY[${sql.join(
                convertedKeysArr.map((k) => sql`${k}`),
                sql`, `,
              )}])`
            : sql`false`;

        const [leadAggs, activityAggs] = await Promise.all([
          this.db
            .select({
              assignedToId: leads.assignedToId,
              leadsAssigned: sql<number>`COUNT(*)::int`,
              leadsConverted: sql<number>`COUNT(*) FILTER (WHERE ${convertedExpr})::int`,
              totalRevenue: sql<number>`COALESCE(SUM(${leads.potentialValue}::numeric) FILTER (WHERE ${convertedExpr}), 0)::float`,
            })
            .from(leads)
            .where(
              and(
                eq(leads.orgId, orgId),
                isNotNull(leads.assignedToId),
              ),
            )
            .groupBy(leads.assignedToId),
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
    return this.cache.cached(
      `leads:team-capacity:${orgId}`,
      async () => {
        const [salesMembers, statusOptions] = await Promise.all([
          this.db.query.organizationMembers.findMany({
            where: eq(organizationMembers.orgId, orgId),
            with: {
              user: { columns: { id: true, name: true, image: true, role: true } },
            },
          }),
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

        const salesUsers = salesMembers
          .filter((m) => m.user.role === "SALES")
          .map((m) => m.user);

        const semantics = resolveLeadStatusSemantics(statusOptions);
        const terminalKeys = [...semantics.convertedKeys, ...semantics.lostKeys];

        const countRows =
          terminalKeys.length > 0
            ? await this.db
                .select({
                  assignedToId: leads.assignedToId,
                  cnt: sql<number>`COUNT(*)::int`,
                })
                .from(leads)
                .where(
                  and(
                    eq(leads.orgId, orgId),
                    notInArray(leads.status, terminalKeys),
                    isNotNull(leads.assignedToId),
                  ),
                )
                .groupBy(leads.assignedToId)
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
    opts: { role?: string; userId?: string },
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
      eq(leads.orgId, orgId),
      inArray(leads.status, semantics.slaOpenKeys),
      lte(leads.updatedAt, twentyFourHoursAgo),
    ];
    if (opts.role === "SALES" && opts.userId) {
      slaFilters.push(eq(leads.assignedToId, opts.userId));
    }

    const slaLeads = await this.db.query.leads.findMany({
      where: and(...slaFilters),
      columns: {
        id: true,
        name: true,
        status: true,
        priority: true,
        updatedAt: true,
        createdAt: true,
        assignedToId: true,
      },
      with: { assignedTo: { columns: { id: true, name: true } } },
      limit: 100,
    });

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
        assignedTo: lead.assignedTo?.name ?? null,
        hoursSinceUpdate: hoursSince,
        priority: lead.priority,
      };
    });

    slaBreached.sort((a, b) => b.hoursSinceUpdate - a.hoursSinceUpdate);
    return { total: slaBreached.length, leads: slaBreached };
  }
}
