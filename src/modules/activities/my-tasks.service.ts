import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { keysetAfter } from "../../common/pagination/keyset";
import { activities, businessParties, deals, subjects, users } from "../../db/schema";
import {
  buildTaskPage,
  decodeTaskCursor,
  type TaskPage,
  type TaskPosition,
} from "./task-list";
import type { MyTasksQuery } from "./dto/activity.schemas";

/**
 * Everything after a position, in the order the task list is read in.
 *
 * Two cases rather than one row comparison, because the sort has a null group
 * at the end and `(due_at, activity_id) > (?, ?)` is unknown — not true — for
 * every row in it. Written as one comparison, page two of a task list silently
 * loses every undated task.
 */
function afterTaskPosition(position: TaskPosition): SQL {
  if (position.dueAt === null)
    return sql`(${activities.dueAt} is null and ${activities.activityId} > ${position.activityId})`;

  return sql`(${activities.dueAt} is null or ${keysetAfter(activities.dueAt, activities.activityId, { sortValue: position.dueAt, id: position.activityId })})`;
}

/**
 * A person's own open tasks, read by assignee.
 *
 * Its own service rather than another method on `ActivitiesService`, because it
 * is a different question with a different order, a different cursor and a
 * different set of joins — and because the timeline service was already at the
 * size where the next reader stops reading.
 */
@Injectable()
export class MyTasksService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async myTasks(organizationId: string, userId: string, query: MyTasksQuery): Promise<TaskPage> {
    const position = decodeTaskCursor(query.cursor);

    const conditions: (SQL | undefined)[] = [
      eq(activities.organizationId, organizationId),
      isNull(activities.deletedAt),
      eq(activities.kind, "task"),
      eq(activities.assigneeUserId, userId),
      query.includeCompleted ? undefined : isNull(activities.completedAt),
      position ? afterTaskPosition(position) : undefined,
    ];

    const rows = await this.db
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
        partyId: activities.partyId,
        dealId: activities.dealId,
        subjectId: activities.subjectId,
      })
      .from(activities)
      .leftJoin(users, eq(users.id, activities.actorUserId))
      .where(and(...conditions))
      .orderBy(sql`${activities.dueAt} is null`, asc(activities.dueAt), asc(activities.activityId))
      .limit(query.limit + 1);

    const names = await this.anchorNames(organizationId, rows);

    return buildTaskPage(
      rows.map((row) => ({
        ...row,
        partyName: row.partyId ? (names.parties.get(row.partyId) ?? null) : null,
        dealName: row.dealId ? (names.deals.get(row.dealId) ?? null) : null,
        subjectTitle: row.subjectId ? (names.subjects.get(row.subjectId) ?? null) : null,
      })),
      query.limit,
    );
  }

  /**
   * What each task is about, in one bounded pass per anchor kind.
   *
   * Not three left joins on the page query: three outer joins to widen a page of
   * tasks costs more than three keyed reads of the handful of anchors actually
   * on it, and the party and subject sides are text keys into different tables
   * anyway. Not a lookup per row either — a task list is a
   * screen somebody opens every morning, and N+1 there never gets attributed to
   * the query that caused it. A kind with no anchors on the page asks nothing.
   */
  private async anchorNames(
    organizationId: string,
    rows: ReadonlyArray<{ partyId: string | null; dealId: number | null; subjectId: string | null }>,
  ): Promise<{
    parties: Map<string, string>;
    deals: Map<number, string>;
    subjects: Map<string, string>;
  }> {
    const partyIds = [...new Set(rows.map((row) => row.partyId).filter((id): id is string => !!id))];
    const subjectIds = [...new Set(rows.map((row) => row.subjectId).filter((id): id is string => !!id))];
    const dealIds = [...new Set(rows.map((row) => row.dealId).filter((id): id is number => id !== null))];

    const [partyRows, dealRows, subjectRows] = await Promise.all([
      partyIds.length
        ? this.db
            .select({ id: businessParties.partyId, name: businessParties.name })
            .from(businessParties)
            .where(
              and(
                eq(businessParties.organizationId, organizationId),
                inArray(businessParties.partyId, partyIds),
              ),
            )
        : Promise.resolve([]),
      dealIds.length
        ? this.db
            .select({ id: deals.id, name: deals.name })
            .from(deals)
            .where(and(eq(deals.orgId, organizationId), inArray(deals.id, dealIds)))
        : Promise.resolve([]),
      subjectIds.length
        ? this.db
            .select({ id: subjects.subjectId, name: subjects.title })
            .from(subjects)
            .where(
              and(eq(subjects.organizationId, organizationId), inArray(subjects.subjectId, subjectIds)),
            )
        : Promise.resolve([]),
    ]);

    return {
      parties: new Map(partyRows.map((row) => [row.id, row.name])),
      deals: new Map(dealRows.map((row) => [row.id, row.name])),
      subjects: new Map(subjectRows.map((row) => [row.id, row.name])),
    };
  }
}
