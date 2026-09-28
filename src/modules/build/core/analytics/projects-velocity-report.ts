import { BadRequestException } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { buildCursorPage, decodeCursor } from "../../../../common/pagination/cursor";
import type { Db } from "../../../../db/drizzle.types";
import { cycles, projectStatuses, tickets } from "../../../../db/schema";
import { velocityCursorPositionSchema, type VelocityQuery } from "../dto/analytics.schemas";

function velocityCursorPredicate(cursor: string | undefined) {
  if (!cursor) return undefined;
  const position = velocityCursorPositionSchema.safeParse(decodeCursor(cursor));
  if (!position.success) throw new BadRequestException("Invalid velocity report cursor");
  const startDate = sql`${position.data.sortValue}::date`;
  return or(
    lt(cycles.startDate, startDate),
    and(eq(cycles.startDate, startDate), lt(cycles.id, position.data.id)),
  );
}

export async function queryVelocityReport(db: Db, orgId: string, projectId: number, query: VelocityQuery) {
  const rows = await db.select({
    id: cycles.id, name: cycles.name, startDate: cycles.startDate, endDate: cycles.endDate,
    cursorStartDate: sql<string>`${cycles.startDate}::timestamp::text`,
  }).from(cycles).where(and(
    eq(cycles.orgId, orgId), eq(cycles.projectId, projectId),
    inArray(cycles.status, ["active", "completed"]),
    isNull(cycles.deletedAt),
    velocityCursorPredicate(query.cursor),
  )).orderBy(desc(cycles.startDate), desc(cycles.id)).limit(query.limit + 1);
  const page = buildCursorPage(rows, query.limit, row => ({ sortValue: row.cursorStartDate, id: String(row.id) }));
  const cycleIds = page.data.map(row => row.id);
  const statsRows = cycleIds.length ? await db.select({
    cycleId: tickets.cycleId,
    committedCount: sql<number>`COUNT(*)::int`,
    committedPoints: sql<number>`COALESCE(SUM(${tickets.storyPoints}), 0)::int`,
    completedCount: sql<number>`COUNT(*) FILTER (WHERE ${projectStatuses.type} = 'completed')::int`,
    completedPoints: sql<number>`COALESCE(SUM(CASE WHEN ${projectStatuses.type} = 'completed' THEN ${tickets.storyPoints} ELSE 0 END), 0)::int`,
  }).from(tickets).leftJoin(projectStatuses, and(
    eq(tickets.orgId, projectStatuses.orgId), eq(tickets.projectId, projectStatuses.projectId), eq(tickets.status, projectStatuses.name),
  )).where(and(eq(tickets.orgId, orgId), eq(tickets.projectId, projectId), inArray(tickets.cycleId, cycleIds), isNull(tickets.deletedAt)))
    .groupBy(tickets.cycleId) : [];
  const stats = new Map(statsRows.map(row => [row.cycleId, row]));
  return {
    pagination: page.pagination,
    data: page.data.reverse().map(cycle => {
      const totals = stats.get(cycle.id);
      return {
        cycleId: cycle.id, name: cycle.name, startDate: new Date(cycle.startDate).toISOString(), endDate: new Date(cycle.endDate).toISOString(),
        committedPoints: totals?.committedPoints ?? 0, completedPoints: totals?.completedPoints ?? 0,
        committedCount: totals?.committedCount ?? 0, completedCount: totals?.completedCount ?? 0,
      };
    }),
  };
}
