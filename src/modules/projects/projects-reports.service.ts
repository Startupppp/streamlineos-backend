import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { customStates, projectDailySnapshots, projects, sprints, tickets, workItemRelations } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { addDays, differenceInCalendarDays, formatDateOnly } from "./projects.date-utils";
import type { BurnupQuery, CfdQuery } from "./dto/projects.schemas";

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

export interface CriticalPathNode {
  ticketId: number;
  title: string;
  estimate: number;
  earliestStart: number;
  earliestFinish: number;
}

interface TicketRow {
  id: number;
  title: string;
  storyPoints: number | null;
}

interface DagEdge {
  from: number;
  to: number;
}

function buildEdges(
  relations: { workItemId: number; relatedWorkItemId: number; relationType: string }[],
  validIds: Set<number>,
): DagEdge[] {
  const seen = new Set<string>();
  const edges: DagEdge[] = [];
  for (const rel of relations) {
    let from: number | null = null;
    let to: number | null = null;
    if (rel.relationType === "blocks") {
      from = rel.workItemId;
      to = rel.relatedWorkItemId;
    } else if (rel.relationType === "blocked_by") {
      from = rel.relatedWorkItemId;
      to = rel.workItemId;
    }
    if (from === null || to === null) continue;
    if (from === to) continue;
    if (!validIds.has(from) || !validIds.has(to)) continue;
    const key = `${from}->${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to });
  }
  return edges;
}

function computeCriticalPath(ticketRows: TicketRow[], edges: DagEdge[]) {
  const estimateById = new Map<number, number>();
  const titleById = new Map<number, string>();
  for (const t of ticketRows) {
    const estimate = t.storyPoints ?? 1;
    estimateById.set(t.id, estimate > 0 ? estimate : 1);
    titleById.set(t.id, t.title);
  }

  const adjacency = new Map<number, number[]>();
  const indegree = new Map<number, number>();
  for (const id of estimateById.keys()) {
    adjacency.set(id, []);
    indegree.set(id, 0);
  }
  for (const edge of edges) {
    adjacency.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const queue: number[] = [];
  for (const [id, deg] of indegree) {
    if (deg === 0) queue.push(id);
  }

  const order: number[] = [];
  const workingIndegree = new Map(indegree);
  let head = 0;
  while (head < queue.length) {
    const node = queue[head];
    head += 1;
    order.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const deg = (workingIndegree.get(next) ?? 0) - 1;
      workingIndegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }

  const hasCycle = order.length !== estimateById.size;

  const earliestFinish = new Map<number, number>();
  const earliestStart = new Map<number, number>();
  const predecessor = new Map<number, number | null>();
  for (const id of estimateById.keys()) {
    earliestStart.set(id, 0);
    earliestFinish.set(id, estimateById.get(id) ?? 1);
    predecessor.set(id, null);
  }

  for (const node of order) {
    const finish = earliestFinish.get(node) ?? 0;
    for (const next of adjacency.get(node) ?? []) {
      const candidateStart = finish;
      if (candidateStart > (earliestStart.get(next) ?? 0)) {
        earliestStart.set(next, candidateStart);
        earliestFinish.set(next, candidateStart + (estimateById.get(next) ?? 1));
        predecessor.set(next, node);
      }
    }
  }

  let endNode: number | null = null;
  let maxFinish = -1;
  for (const node of order) {
    const finish = earliestFinish.get(node) ?? 0;
    if (finish > maxFinish) {
      maxFinish = finish;
      endNode = node;
    }
  }

  const chain: number[] = [];
  let cursor = endNode;
  const guard = new Set<number>();
  while (cursor !== null && cursor !== undefined && !guard.has(cursor)) {
    guard.add(cursor);
    chain.push(cursor);
    cursor = predecessor.get(cursor) ?? null;
  }
  chain.reverse();

  const criticalPath: CriticalPathNode[] = chain.map((id) => ({
    ticketId: id,
    title: titleById.get(id) ?? "",
    estimate: estimateById.get(id) ?? 1,
    earliestStart: earliestStart.get(id) ?? 0,
    earliestFinish: earliestFinish.get(id) ?? 0,
  }));

  return {
    criticalPath,
    totalDuration: criticalPath.length > 0 ? maxFinish : 0,
    hasCycle,
  };
}

@Injectable()
export class ProjectsReportsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

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

    const sprintTickets = await this.db
      .select({
        storyPoints: tickets.storyPoints,
        updatedAt: tickets.updatedAt,
        group: customStates.group,
      })
      .from(tickets)
      .leftJoin(customStates, eq(tickets.stateId, customStates.id))
      .where(and(eq(tickets.orgId, orgId), eq(tickets.sprintId, sprint.id)))
      .orderBy(asc(tickets.updatedAt));

    const totalScope = sprintTickets.reduce((sum, t) => sum + (t.storyPoints ?? 0), 0);

    const completedByDate = new Map<string, number>();
    for (const t of sprintTickets) {
      if (t.group !== "completed") continue;
      const dateKey = formatDateOnly(t.updatedAt);
      completedByDate.set(dateKey, (completedByDate.get(dateKey) ?? 0) + (t.storyPoints ?? 0));
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

    const sprintTickets = await this.db
      .select({
        sprintId: tickets.sprintId,
        storyPoints: tickets.storyPoints,
        group: customStates.group,
      })
      .from(tickets)
      .leftJoin(customStates, eq(tickets.stateId, customStates.id))
      .where(and(eq(tickets.orgId, orgId), inArray(tickets.sprintId, sprintIds)));

    const bySprint = new Map<
      number,
      { committedPoints: number; completedPoints: number; committedCount: number; completedCount: number }
    >();
    for (const id of sprintIds) {
      bySprint.set(id, { committedPoints: 0, completedPoints: 0, committedCount: 0, completedCount: 0 });
    }

    for (const t of sprintTickets) {
      if (t.sprintId === null) continue;
      const bucket = bySprint.get(t.sprintId);
      if (!bucket) continue;
      const pts = t.storyPoints ?? 0;
      bucket.committedPoints += pts;
      bucket.committedCount += 1;
      if (t.group === "completed") {
        bucket.completedPoints += pts;
        bucket.completedCount += 1;
      }
    }

    return projectSprints.map((s) => {
      const bucket = bySprint.get(s.id) ?? {
        committedPoints: 0,
        completedPoints: 0,
        committedCount: 0,
        completedCount: 0,
      };
      return {
        sprintId: s.id,
        name: s.name,
        startDate: s.startDate.toISOString(),
        endDate: s.endDate.toISOString(),
        committedPoints: bucket.committedPoints,
        completedPoints: bucket.completedPoints,
        committedCount: bucket.committedCount,
        completedCount: bucket.completedCount,
      };
    });
  }

  async snapshot(orgId: string, projectId: number) {
    await this.requireProject(orgId, projectId);

    const projectTickets = await this.db
      .select({ storyPoints: tickets.storyPoints, group: customStates.group })
      .from(tickets)
      .leftJoin(customStates, eq(tickets.stateId, customStates.id))
      .where(and(eq(tickets.orgId, orgId), eq(tickets.projectId, projectId)));

    const totals = new Map<StateGroup, { count: number; points: number }>();
    for (const group of STATE_GROUPS) {
      totals.set(group, { count: 0, points: 0 });
    }

    for (const t of projectTickets) {
      const group: StateGroup = t.group ?? "backlog";
      const bucket = totals.get(group);
      if (!bucket) continue;
      bucket.count += 1;
      bucket.points += t.storyPoints ?? 0;
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

    return this.db
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
          eq(tickets.status, "DONE"),
          gte(tickets.updatedAt, sql`NOW() - INTERVAL '12 weeks'`),
        ),
      )
      .groupBy(sql`date_trunc('week', ${tickets.updatedAt})`)
      .orderBy(sql`date_trunc('week', ${tickets.updatedAt})`);
  }

  async getLeadTimeReport(orgId: string, projectId: number) {
    await this.requireProject(orgId, projectId);

    return this.db
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
          eq(tickets.status, "DONE"),
          gte(tickets.updatedAt, sql`NOW() - INTERVAL '12 weeks'`),
        ),
      )
      .groupBy(sql`date_trunc('week', ${tickets.updatedAt})`)
      .orderBy(sql`date_trunc('week', ${tickets.updatedAt})`);
  }

  async criticalPath(orgId: string, projectId: number) {
    await this.requireProject(orgId, projectId);

    const ticketRows = await this.db
      .select({ id: tickets.id, title: tickets.title, storyPoints: tickets.storyPoints })
      .from(tickets)
      .where(and(eq(tickets.projectId, projectId), eq(tickets.orgId, orgId)));

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
  }
}
