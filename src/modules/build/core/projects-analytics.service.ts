import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { cycles, projects, tickets, timesheets, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import { assertProjectInOrg } from "./project-access";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import {
  resourceAllocationCursorPositionSchema,
  type ResourceAllocationQuery,
} from "./dto/analytics.schemas";

@Injectable()
export class ProjectsAnalyticsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async getProjectAnalytics(orgId: string, projectId: number) {
    await assertProjectInOrg(this.db, orgId, projectId);
    return this.cache.cachedVersioned(
      `build:analytics:${orgId}`,
      String(projectId),
      () => this.computeProjectAnalytics(orgId, projectId),
      CACHE_TTL.SHORT,
    );
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
      this.db.execute(sql`
        SELECT
          om.user_id AS "assigneeId",
          COALESCE(NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), u.name) AS "assigneeName",
          COUNT(DISTINCT combined.ticket_id) AS total,
          COUNT(DISTINCT combined.ticket_id) FILTER (WHERE combined.status = 'DONE') AS completed
        FROM (
          SELECT t.assignee_membership_id AS membership_id, t.id AS ticket_id, t.status
          FROM build.tickets t
          WHERE t.project_id = ${projectId} AND t.org_id = ${orgId} AND t.deleted_at IS NULL
            AND t.assignee_membership_id IS NOT NULL
          UNION
          SELECT ta.membership_id, ta.ticket_id, t2.status
          FROM build.ticket_assignees ta
          JOIN build.tickets t2 ON t2.id = ta.ticket_id
            AND t2.project_id = ${projectId} AND t2.org_id = ${orgId} AND t2.deleted_at IS NULL
          WHERE ta.org_id = ${orgId}
        ) combined
        JOIN organization_members om ON om.id = combined.membership_id AND om.org_id = ${orgId}
        JOIN users u ON u.id = om.user_id
        GROUP BY om.user_id, u.first_name, u.last_name, u.name
      `).then(rows => {
        const result: { assigneeId: string | null; assigneeName: string | null; total: number; completed: number }[] = [];
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          if (!row) continue;
          result.push({
            assigneeId: typeof row["assigneeId"] === "string" ? row["assigneeId"] : null,
            assigneeName: typeof row["assigneeName"] === "string" ? row["assigneeName"] : null,
            total: Number(row["total"]),
            completed: Number(row["completed"]),
          });
        }
        return result;
      }),
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
          completedPoints: sql<number>`COALESCE(SUM(CASE WHEN ${tickets.status} = 'DONE' THEN COALESCE(${tickets.storyPoints}, ${tickets.estimate}, 0) ELSE 0 END), 0)`.mapWith(Number),
        })
        .from(cycles)
        .leftJoin(tickets, and(eq(tickets.cycleId, cycles.id), eq(tickets.orgId, orgId), isNull(tickets.deletedAt)))
        .where(and(eq(cycles.projectId, projectId), eq(cycles.orgId, orgId), isNull(cycles.deletedAt)))
        .groupBy(cycles.id, cycles.name)
        .orderBy(cycles.startDate),
      this.db
        .select({
          ticketId: tickets.id,
          title: tickets.title,
          estimated: tickets.originalEstimate,
          actual: sql<number>`COALESCE(SUM(${timesheets.hours}), 0)`.mapWith(Number),
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
          completedPoints: sql<number>`COALESCE(SUM(CASE WHEN ${tickets.status} = 'DONE' THEN COALESCE(${tickets.storyPoints}, ${tickets.estimate}, 0) ELSE 0 END), 0)`.mapWith(Number),
        })
        .from(cycles)
        .leftJoin(tickets, and(eq(tickets.cycleId, cycles.id), eq(tickets.orgId, orgId), isNull(tickets.deletedAt)))
        .where(and(eq(cycles.orgId, orgId), isNull(cycles.deletedAt)))
        .groupBy(cycles.projectId, cycles.id, cycles.startDate)
        .orderBy(cycles.startDate),
    ]);

    const orgProjects = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.orgId, orgId), isNull(projects.deletedAt)));

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

  /**
   * The org-wide open work, one page of assignees at a time.
   *
   * The read this replaced had no bound anywhere: every ACTIVE project in the
   * org, interpolated as an IN list into the statement, then every open ticket
   * in all of them, then a `users` lookup over every assignee the union found,
   * then the whole result. Cost was O(organisation) on a route any member with
   * org-wide ticket access can call.
   *
   * Paging assignees rather than rows is what keeps a member's project
   * breakdown whole: the totals are aggregated in SQL so `ORDER BY` can see
   * them, and the breakdown query is then restricted to the ids the page
   * actually returned. The active-project filter moved into the statement as a
   * join, which is what removed the unbounded id list with it.
   */
  async resourceAllocation(orgId: string, query: ResourceAllocationQuery) {
    const { limit } = query;
    const decoded = decodeCursor(query.cursor);
    const position = decoded === null ? null : resourceAllocationCursorPositionSchema.parse(decoded);

    const openAssignments = sql`
      SELECT t.assignee_membership_id AS membership_id, t.id AS ticket_id, t.project_id
      FROM build.tickets t
      JOIN build.projects p ON p.id = t.project_id AND p.org_id = t.org_id
        AND p.status = 'ACTIVE' AND p.deleted_at IS NULL
      WHERE t.org_id = ${orgId}
        AND t.deleted_at IS NULL
        AND t.status NOT IN ('DONE', 'CANCELLED', 'CLOSED')
        AND t.assignee_membership_id IS NOT NULL
      UNION
      SELECT ta.membership_id, ta.ticket_id, t2.project_id
      FROM build.ticket_assignees ta
      JOIN build.tickets t2 ON t2.id = ta.ticket_id AND t2.org_id = ta.org_id
      JOIN build.projects p2 ON p2.id = t2.project_id AND p2.org_id = t2.org_id
        AND p2.status = 'ACTIVE' AND p2.deleted_at IS NULL
      WHERE ta.org_id = ${orgId}
        AND t2.deleted_at IS NULL
        AND t2.status NOT IN ('DONE', 'CANCELLED', 'CLOSED')
    `;

    const openTickets = sql`COUNT(DISTINCT combined.ticket_id)`;
    const cursorPredicate = position
      ? sql`HAVING ${openTickets} < ${position.totalOpen}
             OR (${openTickets} = ${position.totalOpen} AND om.user_id > ${position.id})`
      : sql``;

    const assigneeRows = await this.db.execute(sql`
      SELECT om.user_id AS "assigneeId", ${openTickets}::int AS "totalOpen"
      FROM (${openAssignments}) combined
      JOIN organization_members om
        ON om.id = combined.membership_id AND om.org_id = ${orgId}
      GROUP BY om.user_id
      ${cursorPredicate}
      ORDER BY ${openTickets} DESC, om.user_id ASC
      LIMIT ${limit + 1}
    `);

    const page = buildCursorPage(
      assigneeRows
        .map((row) => ({ id: String(row["assigneeId"]), totalOpen: Number(row["totalOpen"]) }))
        .filter((row) => row.id !== "null"),
      limit,
      (row) => ({ sortValue: String(row.totalOpen), id: row.id }),
    );

    if (page.data.length === 0) return { data: [], pagination: page.pagination };

    const pageUserIds = page.data.map((row) => row.id);
    const pageUserIdList = sql.join(
      pageUserIds.map((id) => sql`${id}`),
      sql`, `,
    );

    const [breakdownRows, members] = await Promise.all([
      this.db.execute(sql`
        SELECT
          om.user_id AS "assigneeId",
          combined.project_id AS "projectId",
          p.name AS "projectName",
          p."key" AS "projectKey",
          COUNT(DISTINCT combined.ticket_id)::int AS open
        FROM (${openAssignments}) combined
        JOIN organization_members om
          ON om.id = combined.membership_id AND om.org_id = ${orgId}
        JOIN build.projects p ON p.id = combined.project_id AND p.org_id = ${orgId}
        WHERE om.user_id IN (${pageUserIdList})
        GROUP BY om.user_id, combined.project_id, p.name, p."key"
        ORDER BY COUNT(DISTINCT combined.ticket_id) DESC, combined.project_id ASC
      `),
      this.db.query.users.findMany({
        where: inArray(users.id, pageUserIds),
        columns: { id: true, name: true, email: true, image: true },
      }),
    ]);

    const memberMap = new Map(members.map((m) => [m.id, m]));
    const breakdownByUser = new Map<
      string,
      { projectId: number; projectName: string; projectKey: string; open: number }[]
    >();
    for (const row of breakdownRows) {
      const assigneeId = row["assigneeId"];
      if (typeof assigneeId !== "string") continue;
      const entries = breakdownByUser.get(assigneeId) ?? [];
      entries.push({
        projectId: Number(row["projectId"]),
        projectName: String(row["projectName"]),
        projectKey: String(row["projectKey"]),
        open: Number(row["open"]),
      });
      breakdownByUser.set(assigneeId, entries);
    }

    const data = page.data.flatMap((row) => {
      const user = memberMap.get(row.id);
      if (!user) return [];
      return [
        {
          user,
          totalOpen: row.totalOpen,
          byProject: breakdownByUser.get(row.id) ?? [],
        },
      ];
    });

    return { data, pagination: page.pagination };
  }
}
