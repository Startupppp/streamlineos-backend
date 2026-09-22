import { ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { cycles, projectDailySnapshots, projectStatuses, projects, sprintScopeEvents, sprints, tickets, workItemRelations } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { addDays, differenceInCalendarDays, formatDateOnly } from "../../../common/date";
import type { BurnupQuery, CfdQuery } from "./dto/projects.schemas";
import type { VelocityQuery } from "./dto/analytics.schemas";
import { queryVelocityReport } from "./projects-velocity-report";
import { MAX_BURNUP_DAYS, MAX_BURNUP_EVENTS, MAX_CRITICAL_PATH_EDGES, MAX_CRITICAL_PATH_TICKETS } from "./projects-report-limits";
import { buildEdges, computeCriticalPath } from "./projects-critical-path.util";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { assertProjectAggregateAccess } from "./build-project-aggregate-access";
import { ticketsScopeIsUnrestricted } from "./tickets-scope";
import {
  computeBurnupFromEvents,
  type BurnupPoint,
} from "./projects-burnup.util";

export type { BurnupPoint } from "./projects-burnup.util";

const STATE_GROUPS = ["backlog", "unstarted", "started", "completed", "cancelled"] as const;
type StateGroup = (typeof STATE_GROUPS)[number];

@Injectable()
export class ProjectsReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly access: AccessService,
  ) {}

  async authorizeProject(actor: CurrentUserContext, projectId: number): Promise<void> {
    await assertProjectAggregateAccess(this.db, this.access, actor, projectId);
  }

  async authorizeOrganization(actor: CurrentUserContext): Promise<void> {
    if (!(await ticketsScopeIsUnrestricted(this.access, actor)))
      throw new ForbiddenException("Organization-wide reports require access to all tickets");
  }

  private async requireProject(actor: CurrentUserContext, projectId: number): Promise<number> {
    await this.authorizeProject(actor, projectId);
    const orgId = actor.orgId;
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, orgId), isNull(projects.deletedAt)),
      columns: { id: true, reportRevision: true },
    });
    if (!project) throw new NotFoundException("Project not found");
    return project.reportRevision;
  }

  async burnup(actor: CurrentUserContext, projectId: number, query: BurnupQuery): Promise<BurnupPoint[]> {
    const orgId = actor.orgId;
    const revision = await this.requireProject(actor, projectId);

    const sprint = query.sprintId
      ? await this.db.query.sprints.findFirst({
          where: and(
            eq(sprints.id, Number(query.sprintId)),
            eq(sprints.projectId, projectId),
            eq(sprints.orgId, orgId),
            isNull(sprints.deletedAt),
          ),
          columns: { id: true, startDate: true, endDate: true },
        })
      : await this.db.query.sprints.findFirst({
          where: and(
            eq(sprints.projectId, projectId),
            eq(sprints.orgId, orgId),
            inArray(sprints.status, ["ACTIVE", "COMPLETED"]),
            isNull(sprints.deletedAt),
          ),
          orderBy: [desc(sprints.startDate)],
          columns: { id: true, startDate: true, endDate: true },
        });

    if (!sprint) {
      if (query.sprintId) throw new NotFoundException("Sprint not found");
      return [];
    }
    const startDate = new Date(sprint.startDate);
    const endDate = new Date(sprint.endDate);
    const days = differenceInCalendarDays(endDate, startDate) + 1;
    if (!Number.isSafeInteger(days) || days < 1 || days > MAX_BURNUP_DAYS)
      throw new UnprocessableEntityException(`Burnup reports support sprint ranges of 1 to ${MAX_BURNUP_DAYS} days`);

    const [cycleRow] = await this.db
      .select({ id: cycles.id })
      .from(cycles)
      .where(and(eq(cycles.orgId, orgId), eq(cycles.legacySprintId, sprint.id)))
      .limit(1);
    if (!cycleRow) return [];

    const cycleId = cycleRow.id;
    const cacheKey = `projects:burnup:${orgId}:${projectId}:${sprint.id}:bounded:r${revision}`;
    return this.cache.cached(
      cacheKey,
      async () => {
        const events = await this.db
          .select({
            ticketId: sprintScopeEvents.ticketId,
            eventType: sprintScopeEvents.eventType,
            newPoints: sprintScopeEvents.newPoints,
            createdAt: sprintScopeEvents.createdAt,
          })
          .from(sprintScopeEvents)
          .where(
            and(
              eq(sprintScopeEvents.orgId, orgId),
              eq(sprintScopeEvents.cycleId, cycleId),
            ),
          )
          .orderBy(asc(sprintScopeEvents.createdAt), asc(sprintScopeEvents.id))
          .limit(MAX_BURNUP_EVENTS + 1);
        if (events.length > MAX_BURNUP_EVENTS)
          throw new UnprocessableEntityException(`Burnup reports support at most ${MAX_BURNUP_EVENTS} sprint events; choose a smaller sprint`);

        if (events.length > 0)
          return computeBurnupFromEvents(events, startDate, days);

        return this.burnupFromCurrentMembership(orgId, projectId, cycleId, startDate, days);
      },
      CACHE_TTL.SHORT,
    );
  }

  private async burnupFromCurrentMembership(
    orgId: string,
    projectId: number,
    cycleId: number,
    startDate: Date,
    days: number,
  ): Promise<BurnupPoint[]> {
    const [scopeRow] = await this.db
      .select({
        totalScope: sql<number>`COALESCE(SUM(${tickets.storyPoints}), 0)::int`,
      })
      .from(tickets)
      .where(and(eq(tickets.orgId, orgId), eq(tickets.cycleId, cycleId), isNull(tickets.deletedAt)));

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
          eq(tickets.cycleId, cycleId),
          isNull(tickets.deletedAt),
          eq(projectStatuses.type, "completed"),
        ),
      )
      .groupBy(sql`date_trunc('day', ${tickets.updatedAt})`)
      .orderBy(sql`date_trunc('day', ${tickets.updatedAt})`);

    const completedByDate = new Map<string, number>();
    for (const row of completedDayRows)
      completedByDate.set(row.day, row.pts);

    let cumulativeCompleted = 0;
    return Array.from({ length: days }).map((_, i) => {
      const day = addDays(startDate, i);
      const dateKey = formatDateOnly(day);
      cumulativeCompleted += completedByDate.get(dateKey) ?? 0;
      return { date: dateKey, scope: totalScope, completed: Math.min(cumulativeCompleted, totalScope) };
    });
  }

  async cfd(actor: CurrentUserContext, projectId: number, query: CfdQuery) {
    const orgId = actor.orgId;
    await this.requireProject(actor, projectId);

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

  async velocity(actor: CurrentUserContext, projectId: number, query: VelocityQuery) {
    const orgId = actor.orgId;
    const revision = await this.requireProject(actor, projectId);
    const cacheKey = `projects:velocity:${orgId}:${projectId}:r${revision}:${query.limit}:${query.cursor ?? "first"}`;
    return this.cache.cached(
      cacheKey,
      () => queryVelocityReport(this.db, orgId, projectId, query),
      CACHE_TTL.SHORT,
    );
  }

  async snapshot(actor: CurrentUserContext, projectId: number) {
    const orgId = actor.orgId;
    await this.requireProject(actor, projectId);

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
      const g = row.group;
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

  async getCycleTimeReport(actor: CurrentUserContext, projectId: number) {
    const orgId = actor.orgId;
    const revision = await this.requireProject(actor, projectId);

    const cacheKey = `projects:cycle-time:${orgId}:${projectId}:r${revision}`;
    return this.cache.cached(
      cacheKey,
      () =>
        this.db
          .select({
            week: sql<string>`to_char(date_trunc('week', ${tickets.updatedAt}), 'YYYY-MM-DD')`,
            avgDays: sql<number>`ROUND(AVG(EXTRACT(EPOCH FROM (${tickets.updatedAt} - ${tickets.createdAt})) / 86400)::numeric, 1)`.mapWith(Number),
            count: sql<number>`COUNT(*)::int`,
          })
          .from(tickets)
          .innerJoin(projectStatuses, and(
            eq(projectStatuses.orgId, tickets.orgId), eq(projectStatuses.projectId, tickets.projectId),
            eq(projectStatuses.name, tickets.status),
          ))
          .where(
            and(
              eq(tickets.orgId, orgId),
              eq(tickets.projectId, projectId),
              isNull(tickets.deletedAt),
              eq(projectStatuses.type, "completed"),
              gte(tickets.updatedAt, sql`NOW() - INTERVAL '12 weeks'`),
            ),
          )
          .groupBy(sql`date_trunc('week', ${tickets.updatedAt})`)
          .orderBy(sql`date_trunc('week', ${tickets.updatedAt})`),
      CACHE_TTL.MEDIUM,
    );
  }

  async getLeadTimeReport(actor: CurrentUserContext, projectId: number) {
    const orgId = actor.orgId;
    const revision = await this.requireProject(actor, projectId);

    const cacheKey = `projects:lead-time:${orgId}:${projectId}:r${revision}`;
    return this.cache.cached(
      cacheKey,
      () =>
        this.db
          .select({
            week: sql<string>`to_char(date_trunc('week', ${tickets.updatedAt}), 'YYYY-MM-DD')`,
            avgDays: sql<number>`ROUND(AVG(EXTRACT(EPOCH FROM (${tickets.updatedAt} - ${tickets.createdAt})) / 86400)::numeric, 1)`.mapWith(Number),
            p50Days: sql<number>`ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (${tickets.updatedAt} - ${tickets.createdAt}))) / 86400)::numeric, 1)`.mapWith(Number),
            p90Days: sql<number>`ROUND((PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (${tickets.updatedAt} - ${tickets.createdAt}))) / 86400)::numeric, 1)`.mapWith(Number),
            count: sql<number>`COUNT(*)::int`,
          })
          .from(tickets)
          .innerJoin(projectStatuses, and(
            eq(projectStatuses.orgId, tickets.orgId), eq(projectStatuses.projectId, tickets.projectId),
            eq(projectStatuses.name, tickets.status),
          ))
          .where(
            and(
              eq(tickets.orgId, orgId),
              eq(tickets.projectId, projectId),
              isNull(tickets.deletedAt),
              eq(projectStatuses.type, "completed"),
              gte(tickets.updatedAt, sql`NOW() - INTERVAL '12 weeks'`),
            ),
          )
          .groupBy(sql`date_trunc('week', ${tickets.updatedAt})`)
          .orderBy(sql`date_trunc('week', ${tickets.updatedAt})`),
      CACHE_TTL.MEDIUM,
    );
  }

  async criticalPath(actor: CurrentUserContext, projectId: number) {
    const orgId = actor.orgId;
    const revision = await this.requireProject(actor, projectId);

    const cacheKey = `projects:critical-path:${orgId}:${projectId}:bounded:r${revision}`;
    return this.cache.cached(
      cacheKey,
      async () => {
        const ticketRows = await this.db
          .select({ id: tickets.id, title: tickets.title, storyPoints: tickets.storyPoints })
          .from(tickets)
          .limit(MAX_CRITICAL_PATH_TICKETS + 1)
          .where(and(eq(tickets.projectId, projectId), eq(tickets.orgId, orgId), isNull(tickets.deletedAt)));
        if (ticketRows.length > MAX_CRITICAL_PATH_TICKETS)
          throw new UnprocessableEntityException(`Critical-path reports support at most ${MAX_CRITICAL_PATH_TICKETS} tickets per project`);

        const ticketIds = ticketRows.map((t) => t.id);
        const validIds = new Set(ticketIds);

        if (ticketIds.length === 0) {
          return { criticalPath: [], totalDuration: 0, nodeCount: 0, edgeCount: 0, hasCycle: false };
        }

        const relatedTicket = alias(tickets, "critical_path_related_ticket");
        const relations = await this.db
          .select({
            workItemId: workItemRelations.workItemId,
            relatedWorkItemId: workItemRelations.relatedWorkItemId,
            relationType: workItemRelations.relationType,
          })
          .from(workItemRelations)
          .innerJoin(tickets, and(
            eq(tickets.orgId, workItemRelations.orgId), eq(tickets.id, workItemRelations.workItemId),
            eq(tickets.projectId, projectId), isNull(tickets.deletedAt),
          ))
          .innerJoin(relatedTicket, and(
            eq(relatedTicket.orgId, workItemRelations.orgId), eq(relatedTicket.id, workItemRelations.relatedWorkItemId),
            eq(relatedTicket.projectId, projectId), isNull(relatedTicket.deletedAt),
          ))
          .limit(MAX_CRITICAL_PATH_EDGES + 1)
          .where(
            and(
              eq(workItemRelations.orgId, orgId),
              inArray(workItemRelations.relationType, ["blocks", "blocked_by"]),
              ne(workItemRelations.workItemId, workItemRelations.relatedWorkItemId),
            ),
          );
        if (relations.length > MAX_CRITICAL_PATH_EDGES)
          throw new UnprocessableEntityException(`Critical-path reports support at most ${MAX_CRITICAL_PATH_EDGES} dependencies per project`);

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
