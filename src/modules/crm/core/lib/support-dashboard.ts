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
} from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { subDays } from "../../../../common/date";
import {
  PRIORITY_COLORS,
  PRIORITY_LABELS,
  STATUS_COLORS,
  STATUS_LABELS,
  computeTrend,
} from "./support-dashboard-presentation";

/**
 * Everything the support dashboard shows, assembled in one pass.
 *
 * Moved out of `crm-support-dashboard.service.ts` VERBATIM and deliberately NOT
 * decomposed further. It is one function because the panels share the window
 * arithmetic and the period-over-period comparison — every count is taken twice,
 * once for the current window and once for the one before it, and splitting the
 * panels apart would either duplicate that or thread it through six signatures.
 * Breaking it up is a real refactor of the dashboard, not a line-count exercise.
 *
 * A plain `db` parameter rather than a deps bag: the caching stays on the
 * service, which is the layer that knows the key.
 */

export async function buildSupportDashboard(
  db: Db,
 orgId: string) {
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
    db
      .select({ status: supportTickets.status, cnt: count() })
      .from(supportTickets)
      .where(eq(supportTickets.orgId, orgId))
      .groupBy(supportTickets.status),

    db
      .select({ priority: supportTickets.priority, cnt: count() })
      .from(supportTickets)
      .where(eq(supportTickets.orgId, orgId))
      .groupBy(supportTickets.priority),

    db
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

    db
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

    db
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

    db
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

    db
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

  const ticketStatusBreakdown = (
    ["OPEN", "IN_PROGRESS", "WAITING", "RESOLVED", "CLOSED"] as const
  ).map((status) => ({
    label: STATUS_LABELS[status],
    value: statusMap.get(status) ?? 0,
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
    .filter((assigneeId): assigneeId is NonNullable<typeof assigneeId> => assigneeId !== null);
  let assigneeUsers: {
    id: string;
    name: string | null;
    role: string | null;
  }[] = [];
  if (assigneeIds.length > 0) {
    assigneeUsers = await db
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
  const ticketsByPriority = (["URGENT", "HIGH", "MEDIUM", "LOW"] as const).map(
    (priority) => ({
      label: PRIORITY_LABELS[priority],
      value: priorityMap.get(priority) ?? 0,
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
