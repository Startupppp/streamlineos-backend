import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import { keysetBefore } from "../../common/pagination/keyset";
import type { Db } from "../../db/drizzle.types";
import { activities, users } from "../../db/schema";
import {
  buildTimelinePage,
  decodeTimelineCursor,
  type TimelineEntry,
  type TimelinePage,
} from "./activity-timeline";
import type { TimelineQuery } from "./dto/activity.schemas";

/**
 * One chronological timeline, whatever the anchor.
 *
 * There is exactly one query here rather than one per anchor kind, because a
 * party timeline and a deal timeline differing in behaviour is precisely the
 * drift that produced six of these already.
 */
export async function queryTimeline(
  db: Db,
  organizationId: string,
  query: TimelineQuery,
): Promise<TimelinePage> {
  const position = decodeTimelineCursor(query.cursor);

  const anchor = query.partyId
    ? eq(activities.partyId, query.partyId)
    : query.dealId
      ? eq(activities.dealId, query.dealId)
      : eq(activities.subjectId, query.subjectId ?? "");

  const conditions: (SQL | undefined)[] = [
    eq(activities.organizationId, organizationId),
    isNull(activities.deletedAt),
    anchor,
    query.kind ? eq(activities.kind, query.kind) : undefined,
    // Keyset on both columns: timestamps collide, so ordering on occurred_at
    // alone skips or repeats rows at every page boundary.
    position
      ? keysetBefore(activities.occurredAt, activities.activityId, { sortValue: position.occurredAt, id: position.activityId })
      : undefined,
  ];

  const rows = await db
    .select({
      activityId: activities.activityId,
      kind: activities.kind,
      occurredAt: activities.occurredAt,
      subject: activities.subject,
      body: activities.body,
      threadId: activities.threadId,
      actorKind: activities.actorKind,
      actorLabel: activities.actorLabel,
      actorName: users.name,
      dueAt: activities.dueAt,
      completedAt: activities.completedAt,
      source: activities.source,
    })
    .from(activities)
    .leftJoin(users, eq(users.id, activities.actorUserId))
    .where(and(...conditions))
    .orderBy(desc(activities.occurredAt), desc(activities.activityId))
    .limit(query.limit + 1);

  return buildTimelinePage(rows as TimelineEntry[], query.limit);
}
