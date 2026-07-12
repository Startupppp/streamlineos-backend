import { Inject, Injectable } from "@nestjs/common";
import { eq, and, inArray, notInArray, sql } from "drizzle-orm";
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

@Injectable()
export class LeadsReportsTeamService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getSalesLeaderboard(orgId: string) {
    const [allLeads, allActivities, statusOptions] = await Promise.all([
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
      this.db.select().from(crmOptions)
        .where(and(eq(crmOptions.orgId, orgId), eq(crmOptions.type, "lead_status"))),
    ]);
    const semantics = resolveLeadStatusSemantics(statusOptions);

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
      if (semantics.convertedKeys.includes(lead.status)) {
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

    const statusOptions = await this.db.select().from(crmOptions)
      .where(and(eq(crmOptions.orgId, orgId), eq(crmOptions.type, "lead_status")));
    const semantics = resolveLeadStatusSemantics(statusOptions);
    const terminalKeys = [...semantics.convertedKeys, ...semantics.lostKeys];

    const activeLeadsList = await this.db.query.leads.findMany({
      where: and(
        eq(leads.orgId, orgId),
        notInArray(leads.status, terminalKeys),
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

    const statusOptions = await this.db.select().from(crmOptions)
      .where(and(eq(crmOptions.orgId, orgId), eq(crmOptions.type, "lead_status")));
    const semantics = resolveLeadStatusSemantics(statusOptions);

    const slaFilters = [
      eq(leads.orgId, orgId),
      inArray(leads.status, semantics.slaOpenKeys),
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
}
