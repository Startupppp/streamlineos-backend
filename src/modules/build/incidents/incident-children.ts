import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { incidentDecisions, incidentFollowUpActions, incidentUpdates, users } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { buildIdCursorPage } from "../../../common/pagination/cursor";
import type { IncidentChildrenQuery } from "./dto/incidents.schemas";

export async function loadIncidentChildren(
  db: Db,
  orgId: string,
  incidentId: number,
  query: IncidentChildrenQuery,
) {
  const [updateRows, decisionRows, followUpRows] = await Promise.all([
    db
      .select({
        id: incidentUpdates.id,
        orgId: incidentUpdates.orgId,
        incidentId: incidentUpdates.incidentId,
        message: incidentUpdates.message,
        newStatus: incidentUpdates.newStatus,
        createdBy: incidentUpdates.createdBy,
        createdAt: incidentUpdates.createdAt,
        createdByName: users.name,
        createdByEmail: users.email,
      })
      .from(incidentUpdates)
      .leftJoin(users, eq(users.id, incidentUpdates.createdBy))
      .where(and(
        eq(incidentUpdates.incidentId, incidentId),
        eq(incidentUpdates.orgId, orgId),
        query.updatesCursor !== undefined ? lt(incidentUpdates.id, query.updatesCursor) : undefined,
      ))
      .orderBy(desc(incidentUpdates.id))
      .limit(query.limit + 1),
    db
      .select()
      .from(incidentDecisions)
      .where(and(
        eq(incidentDecisions.incidentId, incidentId),
        eq(incidentDecisions.orgId, orgId),
        query.decisionsCursor !== undefined ? lt(incidentDecisions.id, query.decisionsCursor) : undefined,
      ))
      .orderBy(desc(incidentDecisions.id))
      .limit(query.limit + 1),
    db
      .select()
      .from(incidentFollowUpActions)
      .where(and(
        eq(incidentFollowUpActions.incidentId, incidentId),
        eq(incidentFollowUpActions.orgId, orgId),
        isNull(incidentFollowUpActions.deletedAt),
        query.followUpActionsCursor !== undefined
          ? lt(incidentFollowUpActions.id, query.followUpActionsCursor)
          : undefined,
      ))
      .orderBy(desc(incidentFollowUpActions.id))
      .limit(query.limit + 1),
  ]);
  const updates = buildIdCursorPage(updateRows, query.limit, (row) => row.id);
  const decisions = buildIdCursorPage(decisionRows, query.limit, (row) => row.id);
  const followUpActions = buildIdCursorPage(followUpRows, query.limit, (row) => row.id);
  return {
    updates: updates.data,
    decisions: decisions.data,
    followUpActions: followUpActions.data,
    childrenPagination: {
      updates: { limit: query.limit, hasMore: updates.hasMore, nextCursor: updates.nextCursor },
      decisions: { limit: query.limit, hasMore: decisions.hasMore, nextCursor: decisions.nextCursor },
      followUpActions: {
        limit: query.limit,
        hasMore: followUpActions.hasMore,
        nextCursor: followUpActions.nextCursor,
      },
    },
  };
}
