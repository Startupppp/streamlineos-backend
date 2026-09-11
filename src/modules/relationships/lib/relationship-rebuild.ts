import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import {
  activities,
  activityParticipants,
  relationshipParticipants,
  relationshipStates,
  relationshipThreads,
} from "../../../db/schema";
import {
  RELATIONSHIP_WINDOW_MAX_ACTIVITIES,
  type RelationshipActivityRow,
  type RelationshipState,
} from "../relationship-state";
import type { RelationshipAnchor } from "../relationship-state.types";

/*
  The two halves of `RelationshipStateService.rebuild` either side of the fold:
  the relationship's activity window going in, and the replaced state row with
  its participants and threads coming out. The fold itself stays in the
  service, so there is still exactly one computation of the state.
*/

/**
 * The relationship's activities, newest first, bounded by the same count the
 * fold applies.
 *
 * The bound is applied twice deliberately, exactly as the thread window's is:
 * here so the read is a bounded range scan on a partial timeline index rather
 * than a whole correspondence pulled into memory, and again in the fold, which
 * is the authority — how much history counts is decided by a pure function
 * that can be argued with, not by a LIMIT in one of two queries.
 */
export async function loadRelationshipWindow(
  db: Db,
  organizationId: string,
  anchor: RelationshipAnchor,
): Promise<RelationshipActivityRow[]> {
  const rows = await db
    .select({
      activityId: activities.activityId,
      kind: activities.kind,
      occurredAt: activities.occurredAt,
      subject: activities.subject,
      threadId: activities.threadId,
      actorKind: activities.actorKind,
      source: activities.source,
    })
    .from(activities)
    .where(
      and(
        eq(activities.organizationId, organizationId),
        anchor.kind === "party"
          ? eq(activities.partyId, anchor.partyId)
          : eq(activities.dealId, anchor.dealId),
        isNull(activities.deletedAt),
      ),
    )
    .orderBy(desc(activities.occurredAt), desc(activities.activityId))
    .limit(RELATIONSHIP_WINDOW_MAX_ACTIVITIES);

  if (rows.length === 0) return [];

  // One query for the people, never one per activity.
  const people = await db
    .select({
      activityId: activityParticipants.activityId,
      partyId: activityParticipants.partyId,
      userId: activityParticipants.userId,
      address: activityParticipants.address,
      role: activityParticipants.role,
    })
    .from(activityParticipants)
    .where(
      and(
        eq(activityParticipants.organizationId, organizationId),
        inArray(
          activityParticipants.activityId,
          rows.map((row) => row.activityId),
        ),
      ),
    );

  const byActivity = new Map<string, RelationshipActivityRow["participants"][number][]>();
  for (const person of people) {
    const list = byActivity.get(person.activityId) ?? [];
    list.push({
      partyId: person.partyId,
      userId: person.userId,
      address: person.address,
      role: person.role,
    });
    byActivity.set(person.activityId, list);
  }

  return rows.map((row) => ({
    activityId: row.activityId,
    kind: row.kind,
    occurredAt: row.occurredAt,
    subject: row.subject,
    threadId: row.threadId,
    actorKind: row.actorKind,
    source: row.source,
    participants: byActivity.get(row.activityId) ?? [],
  }));
}

/**
 * Replace one relationship's stored state with `state`, in one transaction.
 * See `RelationshipStateService.rebuild` for why this replaces rather than merges.
 */
export async function writeRelationshipState(
  db: Db,
  organizationId: string,
  anchor: RelationshipAnchor,
  state: RelationshipState,
): Promise<void> {
  await db.transaction(async (tx) => {
    const anchorPredicate =
      anchor.kind === "party"
        ? and(
            eq(relationshipStates.organizationId, organizationId),
            eq(relationshipStates.partyId, anchor.partyId),
          )
        : and(
            eq(relationshipStates.organizationId, organizationId),
            eq(relationshipStates.dealId, anchor.dealId),
          );

    const columns = {
      observedFrom: state.observedFrom,
      lastContactAt: state.lastContactAt,
      lastInboundAt: state.lastInboundAt,
      lastOutboundAt: state.lastOutboundAt,
      lastInboundActivityId: state.lastInboundActivityId,
      lastOutboundActivityId: state.lastOutboundActivityId,
      awaitingReplySince: state.awaitingReplySince,
      contactCount: state.contactCount,
      inboundCount: state.inboundCount,
      outboundCount: state.outboundCount,
      unreadableDirectionCount: state.unreadableDirectionCount,
      replySampleCount: state.replyLatency.sampleCount,
      replyP50Seconds: state.replyLatency.p50Seconds,
      replyP90Seconds: state.replyLatency.p90Seconds,
      replyMinSeconds: state.replyLatency.minSeconds,
      replyMaxSeconds: state.replyLatency.maxSeconds,
      participantCount: state.participants.length,
      threadCount: state.threads.length,
      builtAt: new Date(),
    };

    const [existing] = await tx
      .select({ relationshipStateId: relationshipStates.relationshipStateId })
      .from(relationshipStates)
      .where(anchorPredicate)
      .limit(1);

    let relationshipStateId: string;

    if (existing) {
      relationshipStateId = existing.relationshipStateId;
      await tx.update(relationshipStates).set(columns).where(anchorPredicate);
    } else {
      /**
       * `targetWhere` is not optional. Both unique indexes are partial — one
       * anchor column is null on every row — and naming a partial index in an
       * ON CONFLICT without repeating its predicate raises 42P10 rather than
       * quietly picking the other one.
       */
      const [inserted] = await tx
        .insert(relationshipStates)
        .values({
          organizationId,
          partyId: anchor.kind === "party" ? anchor.partyId : null,
          dealId: anchor.kind === "deal" ? anchor.dealId : null,
          ...columns,
        })
        .onConflictDoUpdate({
          target:
            anchor.kind === "party"
              ? [relationshipStates.organizationId, relationshipStates.partyId]
              : [relationshipStates.organizationId, relationshipStates.dealId],
          targetWhere:
            anchor.kind === "party"
              ? sql`party_id is not null`
              : sql`deal_id is not null`,
          set: columns,
        })
        .returning({ relationshipStateId: relationshipStates.relationshipStateId });

      if (!inserted) throw new Error("relationships: could not materialise the state row");
      relationshipStateId = inserted.relationshipStateId;
    }

    const childPredicate = (table: typeof relationshipParticipants | typeof relationshipThreads) =>
      and(
        eq(table.organizationId, organizationId),
        eq(table.relationshipStateId, relationshipStateId),
      );

    /**
     * Physically deleted, not soft-deleted. These rows are derived — the
     * platform's soft-delete default is about business entities somebody may
     * need back, and a participant row nobody can produce from the activities
     * is not a record of anything.
     */
    await tx.delete(relationshipParticipants).where(childPredicate(relationshipParticipants));
    await tx.delete(relationshipThreads).where(childPredicate(relationshipThreads));

    if (state.participants.length > 0) {
      await tx.insert(relationshipParticipants).values(
        state.participants.map((participant) => ({
          organizationId,
          relationshipStateId,
          identity: participant.identity,
          partyId: participant.partyId,
          userId: participant.userId,
          address: participant.address,
          roles: [...participant.roles],
          firstSeenAt: participant.firstSeenAt,
          lastSeenAt: participant.lastSeenAt,
          messageCount: participant.messageCount,
          repliedCount: participant.repliedCount,
          lastRepliedAt: participant.lastRepliedAt,
        })),
      );
    }

    if (state.threads.length > 0) {
      await tx.insert(relationshipThreads).values(
        state.threads.map((thread) => ({
          organizationId,
          relationshipStateId,
          threadId: thread.threadId,
          subject: thread.subject,
          firstSeenAt: thread.firstSeenAt,
          lastSeenAt: thread.lastSeenAt,
          messageCount: thread.messageCount,
          lastDirection: thread.lastDirection,
          precededByThreadId: thread.precededByThreadId,
        })),
      );
    }
  });
}
