import { BadRequestException } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import type { Db } from "../../../db/drizzle.types";
import { projectStatuses, sprints, tickets } from "../../../db/schema";
import { velocityCursorPositionSchema, type VelocityQuery } from "./dto/analytics.schemas";

function velocityCursorPredicate(cursor: string | undefined) {
  if (!cursor) return undefined;
  const position = velocityCursorPositionSchema.safeParse(decodeCursor(cursor));
  if (!position.success) throw new BadRequestException("Invalid velocity report cursor");
  const startDate = sql`${position.data.sortValue}::timestamp`;
  return or(lt(sprints.startDate, startDate), and(eq(sprints.startDate, startDate), lt(sprints.id, position.data.id)));
}

export async function queryVelocityReport(db: Db, orgId: string, projectId: number, query: VelocityQuery) {
  const rows = await db.select({
    id: sprints.id, name: sprints.name, startDate: sprints.startDate, endDate: sprints.endDate,
    cursorStartDate: sql<string>`${sprints.startDate}::text`,
  }).from(sprints).where(and(
    eq(sprints.orgId, orgId), eq(sprints.projectId, projectId),
    inArray(sprints.status, ["ACTIVE", "COMPLETED"]), isNull(sprints.deletedAt),
    velocityCursorPredicate(query.cursor),
  )).orderBy(desc(sprints.startDate), desc(sprints.id)).limit(query.limit + 1);
  const page = buildCursorPage(rows, query.limit, row => ({ sortValue: row.cursorStartDate, id: String(row.id) }));
  const sprintIds = page.data.map(row => row.id);
  const statsRows = sprintIds.length ? await db.select({
    sprintId: tickets.sprintId,
    committedCount: sql<number>`COUNT(*)::int`,
    committedPoints: sql<number>`COALESCE(SUM(${tickets.storyPoints}), 0)::int`,
    completedCount: sql<number>`COUNT(*) FILTER (WHERE ${projectStatuses.type} = 'completed')::int`,
    completedPoints: sql<number>`COALESCE(SUM(CASE WHEN ${projectStatuses.type} = 'completed' THEN ${tickets.storyPoints} ELSE 0 END), 0)::int`,
  }).from(tickets).leftJoin(projectStatuses, and(
    eq(tickets.orgId, projectStatuses.orgId), eq(tickets.projectId, projectStatuses.projectId), eq(tickets.status, projectStatuses.name),
  )).where(and(eq(tickets.orgId, orgId), eq(tickets.projectId, projectId), inArray(tickets.sprintId, sprintIds), isNull(tickets.deletedAt)))
    .groupBy(tickets.sprintId) : [];
  const stats = new Map(statsRows.map(row => [row.sprintId, row]));
  return {
    pagination: page.pagination,
    data: page.data.reverse().map(sprint => {
      const totals = stats.get(sprint.id);
      return {
        sprintId: sprint.id, name: sprint.name, startDate: sprint.startDate.toISOString(), endDate: sprint.endDate.toISOString(),
        committedPoints: totals?.committedPoints ?? 0, completedPoints: totals?.completedPoints ?? 0,
        committedCount: totals?.committedCount ?? 0, completedCount: totals?.completedCount ?? 0,
      };
    }),
  };
}
