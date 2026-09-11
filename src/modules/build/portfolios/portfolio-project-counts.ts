import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { projectDailySnapshots, projectStatuses, tickets } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";

export interface ProjectTicketCounts {
  readonly openCount: number;
  readonly doneCount: number;
}

// Resolves open/done ticket counts for a set of project IDs.
// Primary path reads the latest daily snapshot (maintained by the nightly sweep).
// Projects created since the last sweep have no snapshot row yet; those fall back
// to a live aggregate so we never silently report 0 for a real project.
// Cancelled tickets are excluded from open (terminal, but not done).
export async function resolveProjectCounts(
  db: Db,
  orgId: string,
  projectIds: number[],
): Promise<Map<number, ProjectTicketCounts>> {
  const snapshotRows = await db
    .select({
      projectId: projectDailySnapshots.projectId,
      openCount: sql<number>`COALESCE(SUM(CASE WHEN ${projectDailySnapshots.stateGroup} IN ('backlog', 'unstarted', 'started') THEN ${projectDailySnapshots.count} ELSE 0 END), 0)::int`,
      doneCount: sql<number>`COALESCE(SUM(CASE WHEN ${projectDailySnapshots.stateGroup} = 'completed' THEN ${projectDailySnapshots.count} ELSE 0 END), 0)::int`,
    })
    .from(projectDailySnapshots)
    .where(
      and(
        eq(projectDailySnapshots.orgId, orgId),
        inArray(projectDailySnapshots.projectId, projectIds),
        sql`${projectDailySnapshots.snapshotDate} = (
            SELECT MAX(s2.snapshot_date)
            FROM build.project_daily_snapshots s2
            WHERE s2.project_id = ${projectDailySnapshots.projectId}
          )`,
      ),
    )
    .groupBy(projectDailySnapshots.projectId);

  const countsMap = new Map<number, ProjectTicketCounts>();
  for (const row of snapshotRows)
    countsMap.set(row.projectId, { openCount: row.openCount, doneCount: row.doneCount });

  const unsnapshottedIds = projectIds.filter((id) => !countsMap.has(id));
  if (unsnapshottedIds.length > 0) {
    const liveRows = await db
      .select({
        projectId: tickets.projectId,
        openCount: sql<number>`COALESCE(SUM(CASE WHEN ${projectStatuses.type} IN ('backlog', 'unstarted', 'started') THEN 1 ELSE 0 END), 0)::int`,
        doneCount: sql<number>`COALESCE(SUM(CASE WHEN ${projectStatuses.type} = 'completed' THEN 1 ELSE 0 END), 0)::int`,
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
      .where(
        and(
          eq(tickets.orgId, orgId),
          inArray(tickets.projectId, unsnapshottedIds),
          isNull(tickets.deletedAt),
        ),
      )
      .groupBy(tickets.projectId);

    for (const r of liveRows) {
      if (r.projectId !== null)
        countsMap.set(r.projectId, { openCount: r.openCount, doneCount: r.doneCount });
    }
  }

  return countsMap;
}
