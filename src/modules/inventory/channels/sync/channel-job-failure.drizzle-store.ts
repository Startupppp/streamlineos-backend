import { and, desc, eq, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import { invChannelJobs } from "../../../../db/schema";

/** The dead-letter screen's read: this channel's failures, newest first. */
export async function listChannelJobFailures(
  db: Db,
  orgId: string,
  filters: { channelId?: number; status?: "FAILED" | "DEAD"; page: number; limit: number },
) {
  const conditions = [
    eq(invChannelJobs.orgId, orgId),
    filters.channelId === undefined ? undefined : eq(invChannelJobs.channelId, filters.channelId),
    filters.status
      ? eq(invChannelJobs.status, filters.status)
      : or(eq(invChannelJobs.status, "FAILED"), eq(invChannelJobs.status, "DEAD")),
  ].filter((condition): condition is SQL => condition !== undefined);

  const offset = (filters.page - 1) * filters.limit;
  const [items, [countRow]] = await Promise.all([
    db
      .select({
        id: invChannelJobs.id,
        channelId: invChannelJobs.channelId,
        kind: invChannelJobs.kind,
        externalRef: invChannelJobs.externalRef,
        status: invChannelJobs.status,
        attemptCount: invChannelJobs.attemptCount,
        lastErrorCode: invChannelJobs.lastErrorCode,
        lastError: invChannelJobs.lastError,
        nextAttemptAt: invChannelJobs.nextAttemptAt,
        deadLetteredAt: invChannelJobs.deadLetteredAt,
        createdAt: invChannelJobs.createdAt,
        updatedAt: invChannelJobs.updatedAt,
      })
      .from(invChannelJobs)
      .where(and(...conditions))
      .orderBy(desc(invChannelJobs.updatedAt))
      .limit(filters.limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(invChannelJobs)
      .where(and(...conditions)),
  ]);

  const total = countRow?.count ?? 0;
  return { items, total, page: filters.page, totalPages: Math.ceil(total / filters.limit) };
}
