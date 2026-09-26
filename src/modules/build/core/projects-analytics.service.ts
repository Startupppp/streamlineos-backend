import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, gte, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { cycles, organizationMembers, projectStatuses, projectTeamMembers, tickets, timesheets, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import { assertProjectInOrg } from "./project-access";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import {
  resourceAllocationCursorPositionSchema,
  type ProjectAnalyticsQuery,
  type ResourceAllocationQuery,
} from "./dto/analytics.schemas";

@Injectable()
export class ProjectsAnalyticsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async getProjectAnalytics(orgId: string, projectId: number, query?: ProjectAnalyticsQuery) {
    await assertProjectInOrg(this.db, orgId, projectId);
    const cacheKey = `${String(projectId)}:r${query?.range ?? "all"}:o${query?.ownerId ?? ""}:t${query?.teamId ?? ""}`;
    return this.cache.cachedVersioned(
      `build:analytics:${orgId}`,
      cacheKey,
      () => this.computeProjectAnalytics(orgId, projectId, query),
      CACHE_TTL.SHORT,
    );
  }

  private async resolveMembershipIds(orgId: string, query?: ProjectAnalyticsQuery): Promise<number[] | null> {
    if (query?.ownerId) {
      const member = await this.db.query.organizationMembers.findFirst({
        where: and(eq(organizationMembers.userId, query.ownerId), eq(organizationMembers.orgId, orgId)),
        columns: { id: true },
      });
      return member ? [member.id] : [];
    }
    if (query?.teamId) {
      const teamMembers = await this.db
        .select({ membershipId: projectTeamMembers.membershipId })
        .from(projectTeamMembers)
        .where(and(eq(projectTeamMembers.orgId, orgId), eq(projectTeamMembers.teamId, query.teamId)));
      return teamMembers.map((m) => m.membershipId);
    }
    return null;
  }

  private async computeProjectAnalytics(orgId: string, projectId: number, query?: ProjectAnalyticsQuery) {
    const rangeDays = query?.range === "7d" ? 7 : query?.range === "30d" ? 30 : query?.range === "90d" ? 90 : 84;
    const rangeStart = new Date();
    rangeStart.setDate(rangeStart.getDate() - rangeDays);

    const membershipIds = await this.resolveMembershipIds(orgId, query);
    const assigneeFilter: SQL | undefined =
      membershipIds === null
        ? undefined
        : membershipIds.length === 0
          ? sql`1 = 0`
          : inArray(tickets.assigneeMembershipId, membershipIds);

    const orgFilter = and(
      eq(tickets.projectId, projectId),
      eq(tickets.orgId, orgId),
      isNull(tickets.deletedAt),
      ...(assigneeFilter ? [assigneeFilter] : []),
    );

    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);

    const [
      stateDistributionRows,
      priorityBreakdown,
      assigneeCompletion,
      volumeOverTime,
      cycleVelocity,
      estimateVsActual,
      overdueResult,
    ] = await Promise.all([
      this.db
        .select({ status: tickets.status, statusGroup: projectStatuses.type, count: count() })
        .from(tickets)
        .leftJoin(
          projectStatuses,
          and(
            eq(projectStatuses.orgId, tickets.orgId),
            eq(projectStatuses.projectId, tickets.projectId),
            eq(projectStatuses.name, tickets.status),
          ),
        )
        .where(orgFilter)
        .groupBy(tickets.status, projectStatuses.type),
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
          COUNT(DISTINCT combined.ticket_id) FILTER (WHERE combined.status_group = 'completed') AS completed
        FROM (
          SELECT t.assignee_membership_id AS membership_id, t.id AS ticket_id, ps.type AS status_group
          FROM build.tickets t
          LEFT JOIN build.project_statuses ps ON ps.org_id = t.org_id
            AND ps.project_id = t.project_id AND ps.name = t.status
          WHERE t.project_id = ${projectId} AND t.org_id = ${orgId} AND t.deleted_at IS NULL
            AND t.assignee_membership_id IS NOT NULL
            ${membershipIds !== null ? sql`AND t.assignee_membership_id = ANY(${membershipIds.length > 0 ? membershipIds : [-1]})` : sql``}
          UNION
          SELECT ta.membership_id, ta.ticket_id, ps2.type AS status_group
          FROM build.ticket_assignees ta
          JOIN build.tickets t2 ON t2.id = ta.ticket_id
            AND t2.project_id = ${projectId} AND t2.org_id = ${orgId} AND t2.deleted_at IS NULL
          LEFT JOIN build.project_statuses ps2 ON ps2.org_id = t2.org_id
            AND ps2.project_id = t2.project_id AND ps2.name = t2.status
          WHERE ta.org_id = ${orgId}
            ${membershipIds !== null ? sql`AND ta.membership_id = ANY(${membershipIds.length > 0 ? membershipIds : [-1]})` : sql``}
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
        .where(and(orgFilter, gte(tickets.createdAt, rangeStart)))
        .groupBy(sql`DATE_TRUNC('week', ${tickets.createdAt})`)
        .orderBy(sql`DATE_TRUNC('week', ${tickets.createdAt})`),
      this.db
        .select({
          cycleId: cycles.id,
          cycleName: cycles.name,
          completedPoints: sql<number>`COALESCE(SUM(CASE WHEN ${projectStatuses.type} = 'completed' THEN COALESCE(${tickets.storyPoints}, ${tickets.estimate}, 0) ELSE 0 END), 0)`.mapWith(Number),
        })
        .from(cycles)
        .leftJoin(tickets, and(eq(tickets.cycleId, cycles.id), eq(tickets.orgId, orgId), isNull(tickets.deletedAt)))
        .leftJoin(projectStatuses, and(eq(projectStatuses.orgId, tickets.orgId), eq(projectStatuses.projectId, tickets.projectId), eq(projectStatuses.name, tickets.status)))
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
        .leftJoin(projectStatuses, and(eq(projectStatuses.orgId, tickets.orgId), eq(projectStatuses.projectId, tickets.projectId), eq(projectStatuses.name, tickets.status)))
        .where(
          and(
            orgFilter,
            sql`COALESCE(${projectStatuses.type}, 'started') NOT IN ('completed', 'cancelled')`,
            sql`${tickets.dueDate} IS NOT NULL`,
            sql`${tickets.dueDate} < ${todayStr}`,
          ),
        ),
    ]);
    const stateDistribution = stateDistributionRows.map(({ status, count: rowCount }) => ({ status, count: rowCount }));
    const totalTickets = stateDistributionRows.reduce((s, r) => s + Number(r.count), 0);
    const doneTickets = stateDistributionRows
      .filter((r) => r.statusGroup === "completed")
      .reduce((s, r) => s + Number(r.count), 0);
    const completionRate = totalTickets > 0 ? doneTickets / totalTickets : 0;
    const openTickets = stateDistributionRows
      .filter((r) => !["completed", "cancelled"].includes(r.statusGroup ?? "started"))
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
    type OrgHealthSummaryRow = {
      total: number | string | null;
      healthy: number | string | null;
      atRisk: number | string | null;
      critical: number | string | null;
      avgScore: number | string | null;
    };
    const [summary] = await this.db.execute<OrgHealthSummaryRow>(sql`
      WITH project_ticket_stats AS (
        SELECT
          p.id AS project_id,
          COUNT(t.id)::int AS total,
          COUNT(t.id) FILTER (WHERE ps.type = 'completed')::int AS done,
          COUNT(t.id) FILTER (WHERE COALESCE(ps.type, 'started') NOT IN ('completed', 'cancelled'))::int AS open,
          COUNT(t.id) FILTER (
            WHERE COALESCE(ps.type, 'started') NOT IN ('completed', 'cancelled')
              AND t.due_date IS NOT NULL
              AND t.due_date < ${todayStr}
          )::int AS overdue
        FROM build.projects p
        LEFT JOIN build.tickets t
          ON t.project_id = p.id
          AND t.org_id = p.org_id
          AND t.deleted_at IS NULL
        LEFT JOIN build.project_statuses ps
          ON ps.org_id = t.org_id
          AND ps.project_id = t.project_id
          AND ps.name = t.status
        WHERE p.org_id = ${orgId}
          AND p.deleted_at IS NULL
        GROUP BY p.id
      ), cycle_points AS (
        SELECT
          c.project_id,
          c.id AS cycle_id,
          c.start_date,
          COALESCE(SUM(
            CASE WHEN ps.type = 'completed'
              THEN COALESCE(t.story_points, t.estimate, 0)
              ELSE 0
            END
          ), 0) AS completed_points
        FROM build.cycles c
        LEFT JOIN build.tickets t
          ON t.cycle_id = c.id
          AND t.org_id = ${orgId}
          AND t.deleted_at IS NULL
        LEFT JOIN build.project_statuses ps
          ON ps.org_id = t.org_id
          AND ps.project_id = t.project_id
          AND ps.name = t.status
        WHERE c.org_id = ${orgId}
          AND c.deleted_at IS NULL
        GROUP BY c.project_id, c.id, c.start_date
      ), cycle_stats AS (
        SELECT
          project_id,
          COUNT(*)::int AS cycle_count,
          COALESCE(SUM(completed_points), 0) AS total_points,
          (ARRAY_AGG(completed_points ORDER BY start_date))[COUNT(*)] AS latest_points
        FROM cycle_points
        GROUP BY project_id
      ), project_scores AS (
        SELECT
          pts.project_id,
          ROUND(
            CASE WHEN pts.total > 0 THEN pts.done::numeric / pts.total * 50 ELSE 0 END
            + CASE WHEN pts.open > 0 THEN (1 - pts.overdue::numeric / pts.open) * 30 ELSE 30 END
            + CASE
                WHEN cs.cycle_count > 0 AND cs.total_points / cs.cycle_count > 0
                  THEN LEAST(1, cs.latest_points / (cs.total_points / cs.cycle_count)) * 20
                ELSE 20
              END
          )::int AS health_score
        FROM project_ticket_stats pts
        LEFT JOIN cycle_stats cs ON cs.project_id = pts.project_id
      )
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE health_score >= 60)::int AS healthy,
        COUNT(*) FILTER (WHERE health_score >= 40 AND health_score < 60)::int AS "atRisk",
        COUNT(*) FILTER (WHERE health_score < 40)::int AS critical,
        COALESCE(ROUND(AVG(health_score)), 0)::int AS "avgScore"
      FROM project_scores
    `);

    const total = Number(summary?.total ?? 0);
    return {
      total,
      healthy: Number(summary?.healthy ?? 0),
      atRisk: Number(summary?.atRisk ?? 0),
      critical: Number(summary?.critical ?? 0),
      avgScore: Number(summary?.avgScore ?? 0),
    };
  }

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
        limit: pageUserIds.length,
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
