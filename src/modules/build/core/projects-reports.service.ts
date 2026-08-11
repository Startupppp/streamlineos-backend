import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { projectDailySnapshots, projectStatuses, projects, sprints, tickets, workItemRelations } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { addDays, differenceInCalendarDays, formatDateOnly } from "../../../common/date";
import type { BurnupQuery, CfdQuery } from "./dto/projects.schemas";
import { buildEdges, computeCriticalPath } from "./projects-critical-path.util";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";

const STATE_GROUPS = ["backlog", "unstarted", "started", "completed", "cancelled"] as const;
type StateGroup = (typeof STATE_GROUPS)[number];

export interface BurnupPoint {
  date: string;
  scope: number;
  completed: number;
}

export interface VelocitySprint {
  sprintId: number;
  name: string;
  startDate: string;
  endDate: string;
  committedPoints: number;
  completedPoints: number;
  committedCount: number;
  completedCount: number;
}

@Injectable()
export class ProjectsReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  private async requireProject(orgId: string, projectId: number): Promise<void> {
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, orgId)),
      columns: { id: true },
    });
    if (!project) throw new NotFoundException("Project not found");
  }

  async burnup(orgId: string, projectId: number, query: BurnupQuery): Promise<BurnupPoint[]> {
    await this.requireProject(orgId, projectId);

    const sprint = query.sprintId
      ? await this.db.query.sprints.findFirst({
          where: and(
            eq(sprints.id, Number(query.sprintId)),
            eq(sprints.projectId, projectId),
            eq(sprints.orgId, orgId),
          ),
          columns: { id: true, startDate: true, endDate: true },
        })
      : await this.db.query.sprints.findFirst({
          where: and(
            eq(sprints.projectId, projectId),
            eq(sprints.orgId, orgId),
            inArray(sprints.status, ["ACTIVE", "COMPLETED"]),
          ),
          orderBy: [desc(sprints.startDate)],
          columns: { id: true, startDate: true, endDate: true },
        });

    if (!sprint) return [];

    const cacheKey = `projects:burnup:${orgId}:${projectId}:${sprint.id}`;
    return this.cache.cached(
      cacheKey,
      async () => {
        const [scopeRow] = await this.db
          .select({
            totalScope: sql<number>`COALESCE(SUM(${tickets.storyPoints}), 0)::int`,
          })
          .from(tickets)
          .where(and(eq(tickets.orgId, orgId), eq(tickets.sprintId, sprint.id), isNull(tickets.deletedAt)));

        const totalScope = scopeRow?.totalScope ?? 0;

        const completedDayRows = await this.db
          .select({
            day: sql<string>`to_char(date_trunc('day', ${tickets.updatedAt}), 'YYYY-MM-DD')`,
            pts: sql<number>`COALESCE(SUM(${tickets.storyPoints}), 0)::int`,
          })
          .from(tickets)
          .leftJoin(
            projectStatuses,
            and(
              eq(tickets.orgId, projectStatuses.orgId),
              eq(tickets.projectId, projectStatuses.projectId),
              eq(tickets.status, projectStatuses.name),
            ),
          )
          .where(
            and(
              eq(tickets.orgId, orgId),
              eq(tickets.sprintId, sprint.id),
              isNull(tickets.deletedAt),
              eq(projectStatuses.type, "completed"),
            ),
          )
          .groupBy(sql`date_trunc('day', ${tickets.updatedAt})`)
          .orderBy(sql`date_trunc('day', ${tickets.updatedAt})`);

        const completedByDate = new Map<string, number>();
        for (const row of completedDayRows) {
          completedByDate.set(row.day, row.pts);
        }

        const startDate = new Date(sprint.startDate);
        const endDate = new Date(sprint.endDate);
        const days = Math.max(differenceInCalendarDays(endDate, startDate) + 1, 1);

        let cumulativeCompleted = 0;
        return Array.from({ length: days }).map((_, i) => {
          const day = addDays(startDate, i);
          const dateKey = formatDateOnly(day);
          cumulativeCompleted += completedByDate.get(dateKey) ?? 0;
          return { date: dateKey, scope: totalScope, completed: Math.min(cumulativeCompleted, totalScope) };
        });
      },
      CACHE_TTL.SHORT,
    );
  }

  async cfd(orgId: string, projectId: number, query: CfdQuery) {
    await this.requireProject(orgId, projectId);

    const fromDate = formatDateOnly(addDays(new Date(), -(query.days - 1)));

    const rows = await this.db
      .select({
        snapshotDate: projectDailySnapshots.snapshotDate,
        stateGroup: projectDailySnapshots.stateGroup,
        count: projectDailySnapshots.count,
      })
      .from(projectDailySnapshots)
      .where(
        and(
          eq(projectDailySnapshots.orgId, orgId),
          eq(projectDailySnapshots.projectId, projectId),
          gte(projectDailySnapshots.snapshotDate, fromDate),
        ),
      )
      .orderBy(asc(projectDailySnapshots.snapshotDate));

    if (rows.length === 0) return { dates: [], groups: [...STATE_GROUPS], series: [] };

    const byDate = new Map<string, Record<string, number>>();
    for (const row of rows) {
      const bucket = byDate.get(row.snapshotDate) ?? {};
      bucket[row.stateGroup] = (bucket[row.stateGroup] ?? 0) + row.count;
      byDate.set(row.snapshotDate, bucket);
    }

    const dates = [...byDate.keys()].sort();
    const series = dates.map((date) => {
      const bucket = byDate.get(date) ?? {};
      const entry: Record<string, string | number> = { date };
      for (const group of STATE_GROUPS) {
        entry[group] = bucket[group] ?? 0;
      }
      return entry;
    });

    return { dates, groups: [...STATE_GROUPS], series };
  }

  async velocity(orgId: string, projectId: number): Promise<VelocitySprint[]> {
    await this.requireProject(orgId, projectId);

    const cacheKey = `projects:velocity:${orgId}:${projectId}`;
    return this.cache.cached(
      cacheKey,
      async () => {
        const projectSprints = await this.db
          .select({
            id: sprints.id,
            name: sprints.name,
            startDate: sprints.startDate,
            endDate: sprints.endDate,
            status: sprints.status,
          })
          .from(sprints)
          .where(
            and(
              eq(sprints.projectId, projectId),
              eq(sprints.orgId, orgId),
              inArray(sprints.status, ["ACTIVE", "COMPLETED"]),
            ),
          )
          .orderBy(asc(sprints.startDate));

        if (projectSprints.length === 0) return [];

        const sprintIds = projectSprints.map((s) => s.id);

        const statsRows = await this.db
          .select({
            sprintId: tickets.sprintId,
            committedCount: sql<number>`COUNT(*)::int`,
            committedPoints: sql<number>`COALESCE(SUM(${tickets.storyPoints}), 0)::int`,
            completedCount: sql<number>`COUNT(*) FILTER (WHERE ${projectStatuses.type} = 'completed')::int`,
            completedPoints: sql<number>`COALESCE(SUM(CASE WHEN ${projectStatuses.type} = 'completed' THEN ${tickets.storyPoints} ELSE 0 END), 0)::int`,
          })
          .from(tickets)
          .leftJoin(
            projectStatuses,
            and(
              eq(tickets.orgId, projectStatuses.orgId),
              eq(tickets.projectId, projectStatuses.projectId),
              eq(tickets.status, projectStatuses.name),
            ),
          )
          .where(and(eq(tickets.orgId, orgId), inArray(tickets.sprintId, sprintIds), isNull(tickets.deletedAt)))
          .groupBy(tickets.sprintId);

        const statsMap = new Map(statsRows.map((r) => [r.sprintId, r]));

        return projectSprints.map((s) => {
          const stats = statsMap.get(s.id);
          return {
            sprintId: s.id,
            name: s.name,
            startDate: s.startDate.toISOString(),
            endDate: s.endDate.toISOString(),
            committedPoints: stats?.committedPoints ?? 0,
            completedPoints: stats?.completedPoints ?? 0,
            committedCount: stats?.committedCount ?? 0,
            completedCount: stats?.completedCount ?? 0,
          };
        });
      },
      CACHE_TTL.SHORT,
    );
  }

  async snapshot(orgId: string, projectId: number) {
    await this.requireProject(orgId, projectId);

    const statsRows = await this.db
      .select({
        group: sql<StateGroup>`${projectStatuses.type}`,
        count: sql<number>`COUNT(*)::int`,
        points: sql<number>`COALESCE(SUM(${tickets.storyPoints}), 0)::int`,
      })
      .from(tickets)
      .innerJoin(
        projectStatuses,
        and(
          eq(tickets.orgId, projectStatuses.orgId),
          eq(tickets.projectId, projectStatuses.projectId),
          eq(tickets.status, projectStatuses.name),
        ),
      )
      .where(and(eq(tickets.orgId, orgId), eq(tickets.projectId, projectId), isNull(tickets.deletedAt)))
      .groupBy(projectStatuses.type);

    const totals = new Map<StateGroup, { count: number; points: number }>();
    for (const group of STATE_GROUPS) {
      totals.set(group, { count: 0, points: 0 });
    }

    for (const row of statsRows) {
      const g = row.group as StateGroup;
      const bucket = totals.get(g);
      if (!bucket) continue;
      bucket.count += row.count;
      bucket.points += row.points;
    }

    const snapshotDate = formatDateOnly(new Date());
    const values = STATE_GROUPS.map((group) => {
      const bucket = totals.get(group) ?? { count: 0, points: 0 };
      return { orgId, projectId, snapshotDate, stateGroup: group, count: bucket.count, points: bucket.points };
    });

    await this.db
      .insert(projectDailySnapshots)
      .values(values)
      .onConflictDoUpdate({
        target: [
          projectDailySnapshots.projectId,
          projectDailySnapshots.snapshotDate,
          projectDailySnapshots.stateGroup,
        ],
        set: {
          count: sql`excluded.${sql.raw(projectDailySnapshots.count.name)}`,
          points: sql`excluded.${sql.raw(projectDailySnapshots.points.name)}`,
        },
      });

    return { captured: values.length };
  }

  async getCycleTimeReport(orgId: string, projectId: number) {
    await this.requireProject(orgId, projectId);

    const cacheKey = `projects:cycle-time:${orgId}:${projectId}`;
    return this.cache.cached(
      cacheKey,
      () =>
        this.db
          .select({
            week: sql<string>`to_char(date_trunc('week', ${tickets.updatedAt}), 'YYYY-MM-DD')`,
            avgDays: sql<number>`ROUND(AVG(EXTRACT(EPOCH FROM (${tickets.updatedAt} - ${tickets.createdAt})) / 86400)::numeric, 1)`,
            count: sql<number>`COUNT(*)::int`,
          })
          .from(tickets)
          .where(
            and(
              eq(tickets.orgId, orgId),
              eq(tickets.projectId, projectId),
              isNull(tickets.deletedAt),
              eq(tickets.status, "DONE"),
              gte(tickets.updatedAt, sql`NOW() - INTERVAL '12 weeks'`),
            ),
          )
          .groupBy(sql`date_trunc('week', ${tickets.updatedAt})`)
          .orderBy(sql`date_trunc('week', ${tickets.updatedAt})`),
      CACHE_TTL.MEDIUM,
    );
  }

  async getLeadTimeReport(orgId: string, projectId: number) {
    await this.requireProject(orgId, projectId);

    const cacheKey = `projects:lead-time:${orgId}:${projectId}`;
    return this.cache.cached(
      cacheKey,
      () =>
        this.db
          .select({
            week: sql<string>`to_char(date_trunc('week', ${tickets.updatedAt}), 'YYYY-MM-DD')`,
            avgDays: sql<number>`ROUND(AVG(EXTRACT(EPOCH FROM (${tickets.updatedAt} - ${tickets.createdAt})) / 86400)::numeric, 1)`,
            p50Days: sql<number>`ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (${tickets.updatedAt} - ${tickets.createdAt})) / 86400)::numeric, 1)`,
            p90Days: sql<number>`ROUND(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (${tickets.updatedAt} - ${tickets.createdAt})) / 86400)::numeric, 1)`,
            count: sql<number>`COUNT(*)::int`,
          })
          .from(tickets)
          .where(
            and(
              eq(tickets.orgId, orgId),
              eq(tickets.projectId, projectId),
              isNull(tickets.deletedAt),
              eq(tickets.status, "DONE"),
              gte(tickets.updatedAt, sql`NOW() - INTERVAL '12 weeks'`),
            ),
          )
          .groupBy(sql`date_trunc('week', ${tickets.updatedAt})`)
          .orderBy(sql`date_trunc('week', ${tickets.updatedAt})`),
      CACHE_TTL.MEDIUM,
    );
  }

  async criticalPath(orgId: string, projectId: number) {
    await this.requireProject(orgId, projectId);

    const cacheKey = `projects:critical-path:${orgId}:${projectId}`;
    return this.cache.cached(
      cacheKey,
      async () => {
        const ticketRows = await this.db
          .select({ id: tickets.id, title: tickets.title, storyPoints: tickets.storyPoints })
          .from(tickets)
          .where(and(eq(tickets.projectId, projectId), eq(tickets.orgId, orgId), isNull(tickets.deletedAt)));

        const ticketIds = ticketRows.map((t) => t.id);
        const validIds = new Set(ticketIds);

        if (ticketIds.length === 0) {
          return { criticalPath: [], totalDuration: 0, nodeCount: 0, edgeCount: 0, hasCycle: false };
        }

        const relations = await this.db
          .select({
            workItemId: workItemRelations.workItemId,
            relatedWorkItemId: workItemRelations.relatedWorkItemId,
            relationType: workItemRelations.relationType,
          })
          .from(workItemRelations)
          .where(
            and(
              inArray(workItemRelations.workItemId, ticketIds),
              inArray(workItemRelations.relatedWorkItemId, ticketIds),
            ),
          );

        const edges = buildEdges(relations, validIds);

        if (edges.length === 0) {
          return { criticalPath: [], totalDuration: 0, nodeCount: ticketIds.length, edgeCount: 0, hasCycle: false };
        }

        const { criticalPath, totalDuration, hasCycle } = computeCriticalPath(ticketRows, edges);

        return {
          criticalPath,
          totalDuration,
          nodeCount: ticketIds.length,
          edgeCount: edges.length,
          hasCycle,
        };
      },
      CACHE_TTL.MEDIUM,
    );
  }
}
