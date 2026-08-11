import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { cycles, projects, ticketAssignees, tickets, timesheets, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";

@Injectable()
export class ProjectsAnalyticsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async getProjectAnalytics(orgId: string, projectId: number) {
    const key = `projects:analytics:${orgId}:${projectId}`;
    return this.cache.cached(key, () => this.computeProjectAnalytics(orgId, projectId), CACHE_TTL.MEDIUM);
  }

  private async computeProjectAnalytics(orgId: string, projectId: number) {
    const orgFilter = and(eq(tickets.projectId, projectId), eq(tickets.orgId, orgId), isNull(tickets.deletedAt));

    const today = new Date();
    const twelveWeeksAgo = new Date();
    twelveWeeksAgo.setDate(twelveWeeksAgo.getDate() - 84);
    const todayStr = today.toISOString().slice(0, 10);

    const [
      stateDistribution,
      priorityBreakdown,
      assigneeCompletion,
      volumeOverTime,
      cycleVelocity,
      estimateVsActual,
      overdueResult,
    ] = await Promise.all([
      this.db.select({ status: tickets.status, count: count() }).from(tickets).where(orgFilter).groupBy(tickets.status),
      this.db
        .select({ priority: tickets.priority, count: count() })
        .from(tickets)
        .where(orgFilter)
        .groupBy(tickets.priority),
      this.db
        .select({
          assigneeId: tickets.assigneeId,
          assigneeName: sql<string | null>`COALESCE(NULLIF(TRIM(CONCAT(${users.firstName}, ' ', ${users.lastName})), ''), ${users.name})`,
          total: count(),
          completed: count(sql`CASE WHEN ${tickets.status} = 'DONE' THEN 1 END`),
        })
        .from(tickets)
        .leftJoin(users, eq(users.id, tickets.assigneeId))
        .where(and(orgFilter, sql`${tickets.assigneeId} IS NOT NULL`))
        .groupBy(tickets.assigneeId, users.firstName, users.lastName, users.name),
      this.db
        .select({
          week: sql<string>`TO_CHAR(DATE_TRUNC('week', ${tickets.createdAt}), 'YYYY-MM-DD')`,
          count: count(),
        })
        .from(tickets)
        .where(and(orgFilter, gte(tickets.createdAt, twelveWeeksAgo)))
        .groupBy(sql`DATE_TRUNC('week', ${tickets.createdAt})`)
        .orderBy(sql`DATE_TRUNC('week', ${tickets.createdAt})`),
      this.db
        .select({
          cycleId: cycles.id,
          cycleName: cycles.name,
          completedPoints: sql<number>`COALESCE(SUM(CASE WHEN ${tickets.status} = 'DONE' THEN COALESCE(${tickets.storyPoints}, ${tickets.estimate}, 0) ELSE 0 END), 0)`,
        })
        .from(cycles)
        .leftJoin(tickets, and(eq(tickets.cycleId, cycles.id), isNull(tickets.deletedAt)))
        .where(and(eq(cycles.projectId, projectId), eq(cycles.orgId, orgId)))
        .groupBy(cycles.id, cycles.name)
        .orderBy(cycles.startDate),
      this.db
        .select({
          ticketId: tickets.id,
          title: tickets.title,
          estimated: tickets.originalEstimate,
          actual: sql<number>`COALESCE(SUM(${timesheets.hours}), 0)`,
        })
        .from(tickets)
        .leftJoin(timesheets, eq(timesheets.ticketId, tickets.id))
        .where(and(orgFilter, sql`${tickets.originalEstimate} IS NOT NULL`))
        .groupBy(tickets.id, tickets.title, tickets.originalEstimate)
        .limit(50),
      this.db
        .select({ count: count() })
        .from(tickets)
        .where(
          and(
            orgFilter,
            sql`${tickets.status} NOT IN ('DONE', 'CANCELLED')`,
            sql`${tickets.dueDate} IS NOT NULL`,
            sql`${tickets.dueDate} < ${todayStr}`,
          ),
        ),
    ]);
    const totalTickets = stateDistribution.reduce((s, r) => s + Number(r.count), 0);
    const doneTickets = stateDistribution
      .filter((r) => r.status === "DONE")
      .reduce((s, r) => s + Number(r.count), 0);
    const completionRate = totalTickets > 0 ? doneTickets / totalTickets : 0;
    const openTickets = stateDistribution
      .filter((r) => !["DONE", "CANCELLED"].includes(r.status))
      .reduce((s, r) => s + Number(r.count), 0);
    const overdueCount = Number(overdueResult[0]?.count ?? 0);
    const onTimeRate = openTickets > 0 ? 1 - overdueCount / openTickets : 1;

    const velocities = cycleVelocity.map((c) => Number(c.completedPoints));
    const avgVelocity = velocities.length > 0 ? velocities.reduce((a, b) => a + b, 0) / velocities.length : 0;
    const latestVelocity = velocities.length > 0 ? velocities[velocities.length - 1] : 0;
    const velocityScore = avgVelocity > 0 ? Math.min(1, latestVelocity / avgVelocity) : 1;

    const healthScore = Math.round(completionRate * 50 + onTimeRate * 30 + velocityScore * 20);

    const healthStatus =
      healthScore >= 80
        ? "EXCELLENT"
        : healthScore >= 60
          ? "GOOD"
          : healthScore >= 40
            ? "AT_RISK"
            : "CRITICAL";

    return {
      stateDistribution,
      priorityBreakdown,
      assigneeCompletion,
      volumeOverTime,
      cycleVelocity,
      estimateVsActual,
      healthScore,
      healthStatus,
      healthBreakdown: {
        completionPct: Math.round(completionRate * 100),
        onTimePct: Math.round(onTimeRate * 100),
        velocityScore: Math.round(velocityScore * 100),
        overdueTickets: overdueCount,
        totalTickets,
      },
    };
  }

  async getOrgProjectHealthSummary(orgId: string): Promise<{
    total: number;
    healthy: number;
    atRisk: number;
    critical: number;
    avgScore: number;
  }> {
    const todayStr = new Date().toISOString().slice(0, 10);

    const [ticketStats, cycleStats] = await Promise.all([
      this.db
        .select({
          projectId: tickets.projectId,
          total: sql<number>`COUNT(*)::int`,
          done: sql<number>`COUNT(*) FILTER (WHERE ${tickets.status} = 'DONE')::int`,
          open: sql<number>`COUNT(*) FILTER (WHERE ${tickets.status} NOT IN ('DONE', 'CANCELLED'))::int`,
          overdue: sql<number>`COUNT(*) FILTER (WHERE ${tickets.status} NOT IN ('DONE', 'CANCELLED') AND ${tickets.dueDate} IS NOT NULL AND ${tickets.dueDate} < ${todayStr})::int`,
        })
        .from(tickets)
        .where(and(eq(tickets.orgId, orgId), isNull(tickets.deletedAt)))
        .groupBy(tickets.projectId),
      this.db
        .select({
          projectId: cycles.projectId,
          completedPoints: sql<number>`COALESCE(SUM(CASE WHEN ${tickets.status} = 'DONE' THEN COALESCE(${tickets.storyPoints}, ${tickets.estimate}, 0) ELSE 0 END), 0)`,
        })
        .from(cycles)
        .leftJoin(tickets, eq(tickets.cycleId, cycles.id))
        .where(eq(cycles.orgId, orgId))
        .groupBy(cycles.projectId, cycles.id, cycles.startDate)
        .orderBy(cycles.startDate),
    ]);

    const orgProjects = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.orgId, orgId));

    const ticketMap = new Map<number, (typeof ticketStats)[number]>();
    for (const row of ticketStats) {
      if (row.projectId !== null) ticketMap.set(row.projectId, row);
    }

    const cyclesByProject = new Map<number, number[]>();
    for (const row of cycleStats) {
      if (row.projectId === null) continue;
      const pts = cyclesByProject.get(row.projectId) ?? [];
      pts.push(Number(row.completedPoints));
      cyclesByProject.set(row.projectId, pts);
    }

    let healthy = 0;
    let atRisk = 0;
    let critical = 0;
    let totalScore = 0;

    for (const p of orgProjects) {
      const t = ticketMap.get(p.id);
      const total = t ? Number(t.total) : 0;
      const done = t ? Number(t.done) : 0;
      const open = t ? Number(t.open) : 0;
      const overdue = t ? Number(t.overdue) : 0;

      const completionRate = total > 0 ? done / total : 0;
      const onTimeRate = open > 0 ? 1 - overdue / open : 1;

      const velocities = cyclesByProject.get(p.id) ?? [];
      const avgVelocity = velocities.length > 0 ? velocities.reduce((a, b) => a + b, 0) / velocities.length : 0;
      const latestVelocity = velocities.length > 0 ? velocities[velocities.length - 1] : 0;
      const velocityScore = avgVelocity > 0 ? Math.min(1, latestVelocity / avgVelocity) : 1;

      const healthScore = Math.round(completionRate * 50 + onTimeRate * 30 + velocityScore * 20);

      totalScore += healthScore;
      if (healthScore >= 60) healthy++;
      else if (healthScore >= 40) atRisk++;
      else critical++;
    }

    const total = orgProjects.length;
    return {
      total,
      healthy,
      atRisk,
      critical,
      avgScore: total > 0 ? Math.round(totalScore / total) : 0,
    };
  }

  async resourceAllocation(orgId: string) {
    const key = `projects:resource-allocation:${orgId}`;
    return this.cache.cached(
      key,
      async () => {
        const activeProjects = await this.db.query.projects.findMany({
          where: and(eq(projects.orgId, orgId), eq(projects.status, "ACTIVE")),
          columns: { id: true, name: true, key: true },
        });

        if (activeProjects.length === 0) return [];

        const projectIds = activeProjects.map((p) => p.id);

        const [primaryAllocation, multiAllocation] = await Promise.all([
          this.db
            .select({
              assigneeId: tickets.assigneeId,
              projectId: tickets.projectId,
              open: count(tickets.id),
            })
            .from(tickets)
            .where(
              and(
                eq(tickets.orgId, orgId),
                inArray(tickets.projectId, projectIds),
                isNull(tickets.deletedAt),
                sql`${tickets.status} NOT IN ('DONE', 'CANCELLED', 'CLOSED')`,
              ),
            )
            .groupBy(tickets.assigneeId, tickets.projectId),
          this.db
            .select({
              assigneeId: ticketAssignees.userId,
              projectId: tickets.projectId,
              open: count(tickets.id),
            })
            .from(ticketAssignees)
            .innerJoin(tickets, eq(ticketAssignees.ticketId, tickets.id))
            .where(
              and(
                eq(tickets.orgId, orgId),
                inArray(tickets.projectId, projectIds),
                isNull(tickets.deletedAt),
                sql`${tickets.status} NOT IN ('DONE', 'CANCELLED', 'CLOSED')`,
              ),
            )
            .groupBy(ticketAssignees.userId, tickets.projectId),
        ]);

        const allAssigneeIds = new Set<string>();
        for (const r of primaryAllocation) {
          if (r.assigneeId) allAssigneeIds.add(r.assigneeId);
        }
        for (const r of multiAllocation) {
          if (r.assigneeId) allAssigneeIds.add(r.assigneeId);
        }

        if (allAssigneeIds.size === 0) return [];

        const members = await this.db.query.users.findMany({
          where: inArray(users.id, [...allAssigneeIds]),
          columns: { id: true, name: true, email: true, image: true },
        });

        const memberMap = new Map(members.map((m) => [m.id, m]));
        const projectMap = new Map(activeProjects.map((p) => [p.id, p]));

        const byMember = new Map<
          string,
          {
            user: { id: string; name: string | null; email: string; image: string | null };
            totalOpen: number;
            byProject: { projectId: number; projectName: string; projectKey: string; open: number }[];
          }
        >();

        const addAllocation = (assigneeId: string | null, projectId: number | null, openCount: number) => {
          if (!assigneeId) return;
          const user = memberMap.get(assigneeId);
          if (!user) return;
          const project = projectId ? projectMap.get(projectId) : undefined;
          if (!project) return;

          if (!byMember.has(assigneeId)) {
            byMember.set(assigneeId, { user, totalOpen: 0, byProject: [] });
          }
          const entry = byMember.get(assigneeId);
          if (!entry) return;
          const existing = entry.byProject.find((p) => p.projectId === project.id);
          if (existing) {
            existing.open = Math.max(existing.open, openCount);
          } else {
            entry.byProject.push({
              projectId: project.id,
              projectName: project.name,
              projectKey: project.key,
              open: openCount,
            });
          }
          entry.totalOpen = entry.byProject.reduce((s, p) => s + p.open, 0);
        };

        for (const row of primaryAllocation) {
          addAllocation(row.assigneeId, row.projectId, Number(row.open));
        }
        for (const row of multiAllocation) {
          addAllocation(row.assigneeId, row.projectId, Number(row.open));
        }

        return [...byMember.values()].sort((a, b) => b.totalOpen - a.totalOpen);
      },
      CACHE_TTL.SHORT,
    );
  }
}
