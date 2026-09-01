import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  sql,
} from "drizzle-orm";
import {
  supportTickets,
  supportTicketMessages,
  users,
  organizationMembers,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { subDays } from "../../../common/date";

function computeTrend(current: number, previous: number) {
  if (previous === 0) return { value: 0, isPositive: true };
  const change = ((current - previous) / previous) * 100;
  return {
    value: Math.round(Math.abs(change) * 10) / 10,
    isPositive: change >= 0,
  };
}

@Injectable()
export class CrmSupportDashboardService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  getSupportDashboard(orgId: string) {
    return this.cache.cached(
      CACHE_KEYS.supportDashboard(orgId),
      () => this.buildSupport(orgId),
      CACHE_TTL.MEDIUM,
    );
  }

  private async buildSupport(orgId: string) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevMonthEnd = new Date(
      now.getFullYear(),
      now.getMonth(),
      0,
      23,
      59,
      59,
    );
    const sixMonthsAgo = subDays(now, 180);

    const [
      statusAggs,
      priorityAggs,
      resolvedAvgMs,
      prevMonthResolved,
      recentMessages,
      assigneeAggs,
      monthlyVolumes,
    ] = await Promise.all([
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
        .select({
          avgMs: sql<string>`EXTRACT(EPOCH FROM AVG(${supportTickets.resolvedAt} - ${supportTickets.createdAt})) * 1000`,
        })
        .from(supportTickets)
        .where(
          and(
            eq(supportTickets.orgId, orgId),
            isNotNull(supportTickets.resolvedAt),
            gte(supportTickets.createdAt, monthStart),
          ),
        ),

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
        .innerJoin(
          supportTickets,
          eq(supportTicketMessages.ticketId, supportTickets.id),
        )
        .leftJoin(users, eq(supportTicketMessages.authorId, users.id))
        .where(eq(supportTickets.orgId, orgId))
        .orderBy(desc(supportTicketMessages.createdAt))
        .limit(8),

      this.db
        .select({ assigneeId: organizationMembers.userId, cnt: count() })
        .from(supportTickets)
        .innerJoin(
          organizationMembers,
          and(
            eq(organizationMembers.orgId, supportTickets.orgId),
            eq(organizationMembers.id, supportTickets.assigneeMembershipId),
          ),
        )
        .where(
          and(
            eq(supportTickets.orgId, orgId),
            isNotNull(supportTickets.assigneeMembershipId),
          ),
        )
        .groupBy(organizationMembers.userId)
        .orderBy(desc(count()))
        .limit(10),

      this.db
        .select({
          month: sql<string>`to_char(${supportTickets.createdAt}, 'YYYY-MM')`,
          value: count(),
        })
        .from(supportTickets)
        .where(
          and(
            eq(supportTickets.orgId, orgId),
            gte(supportTickets.createdAt, sixMonthsAgo),
          ),
        )
        .groupBy(sql`to_char(${supportTickets.createdAt}, 'YYYY-MM')`)
        .orderBy(sql`to_char(${supportTickets.createdAt}, 'YYYY-MM')`),
    ]);

    const statusMap = new Map(statusAggs.map((r) => [r.status, Number(r.cnt)]));
    const totalTickets = statusAggs.reduce((s, r) => s + Number(r.cnt), 0);
    const openTickets =
      (statusMap.get("OPEN") ?? 0) +
      (statusMap.get("IN_PROGRESS") ?? 0) +
      (statusMap.get("WAITING") ?? 0);
    const closedOrResolved =
      (statusMap.get("RESOLVED") ?? 0) + (statusMap.get("CLOSED") ?? 0);
    const responseRateVal =
      totalTickets > 0
        ? Math.round((closedOrResolved / totalTickets) * 1000) / 10
        : 0;

    const avgResolveMs = Number(resolvedAvgMs[0]?.avgMs ?? 0);
    const avgResolveH = Math.floor(avgResolveMs / (1000 * 60 * 60));
    const avgResolveM = Math.round((avgResolveMs / (1000 * 60)) % 60);
    const avgResolutionStr =
      avgResolveMs > 0 ? `${avgResolveH}h ${avgResolveM}m` : "—";

    const prevResolved = Number(prevMonthResolved[0]?.cnt ?? 0);

    const supportDashboardStats = {
      openTickets: {
        value: openTickets,
        trend: computeTrend(openTickets, Math.max(openTickets - 1, 0)),
      },
      avgResolution: {
        value: avgResolutionStr,
        trend: computeTrend(avgResolveH > 0 ? avgResolveH + 1 : 0, avgResolveH),
      },
      csatScore: { value: "—", trend: { value: 0, isPositive: true } },
      responseRate: {
        value: `${responseRateVal}%`,
        trend: computeTrend(
          responseRateVal,
          prevResolved > 0
            ? Math.round((prevResolved / Math.max(totalTickets, 1)) * 100)
            : 0,
        ),
      },
    };

    const STATUS_LABELS: Record<string, string> = {
      OPEN: "Open",
      IN_PROGRESS: "In Progress",
      WAITING: "Waiting",
      RESOLVED: "Resolved",
      CLOSED: "Closed",
    };
    const STATUS_COLORS: Record<string, string> = {
      OPEN: "#3B82F6",
      IN_PROGRESS: "#F59E0B",
      WAITING: "#8B5CF6",
      RESOLVED: "#10B981",
      CLOSED: "#6366F1",
    };
    const ticketStatusBreakdown = [
      "OPEN",
      "IN_PROGRESS",
      "WAITING",
      "RESOLVED",
      "CLOSED",
    ].map((status) => ({
      label: STATUS_LABELS[status],
      value:
        statusMap.get(
          status as "OPEN" | "IN_PROGRESS" | "WAITING" | "RESOLVED" | "CLOSED",
        ) ?? 0,
      color: STATUS_COLORS[status],
    }));

    const ticketVolumeTimeline = monthlyVolumes.map((m) => ({
      month: m.month,
      value: Number(m.value),
    }));

    const supportActivityFeed = recentMessages.map((m) => ({
      type: "ticket" as const,
      message: m.body.length > 80 ? `${m.body.slice(0, 80)}…` : m.body,
      time: m.createdAt.toISOString(),
      person: m.authorName ?? "User",
    }));

    const assigneeIds = assigneeAggs
      .map((a) => a.assigneeId)
      .filter(Boolean) as string[];
    let assigneeUsers: {
      id: string;
      name: string | null;
      role: string | null;
    }[] = [];
    if (assigneeIds.length > 0) {
      assigneeUsers = await this.db
        .select({
          id: users.id,
          name: users.name,
          role: organizationMembers.role,
        })
        .from(users)
        .innerJoin(
          organizationMembers,
          and(
            eq(organizationMembers.userId, users.id),
            eq(organizationMembers.orgId, orgId),
          ),
        )
        .where(inArray(users.id, assigneeIds));
    }
    const assigneeMap = new Map(assigneeUsers.map((u) => [u.id, u]));

    const supportTeamMembers = assigneeAggs.map((a) => {
      const u = assigneeMap.get(a.assigneeId ?? "");
      const initials = u?.name ? u.name.slice(0, 2).toUpperCase() : "??";
      return {
        name: u?.name ?? "Unknown",
        role: u?.role ?? "Support",
        access: `${a.cnt} tickets`,
        avatar: initials,
        status: "online" as const,
      };
    });

    const priorityMap = new Map(
      priorityAggs.map((r) => [r.priority, Number(r.cnt)]),
    );
    const PRIORITY_LABELS: Record<string, string> = {
      URGENT: "Urgent",
      HIGH: "High",
      MEDIUM: "Medium",
      LOW: "Low",
    };
    const PRIORITY_COLORS: Record<string, string> = {
      URGENT: "#EF4444",
      HIGH: "#F59E0B",
      MEDIUM: "#3B82F6",
      LOW: "#10B981",
    };
    const ticketsByPriority = ["URGENT", "HIGH", "MEDIUM", "LOW"].map(
      (priority) => ({
        label: PRIORITY_LABELS[priority],
        value:
          priorityMap.get(priority as "URGENT" | "HIGH" | "MEDIUM" | "LOW") ??
          0,
        color: PRIORITY_COLORS[priority],
      }),
    );

    return {
      supportDashboardStats,
      ticketStatusBreakdown,
      ticketVolumeTimeline,
      supportActivityFeed,
      supportTeamMembers,
      ticketsByPriority,
    };
  }
}
