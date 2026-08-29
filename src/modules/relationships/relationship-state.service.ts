import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import {
  activities,
  activityParticipants,
  relationshipParticipants,
  relationshipStates,
  relationshipThreads,
} from "../../db/schema";
import {
  RELATIONSHIP_WINDOW_MAX_ACTIVITIES,
  foldRelationshipState,
  type RelationshipActivityRow,
  type RelationshipState,
} from "./relationship-state";

/**
 * What a relationship state is about. Exactly one, never a type-plus-id pair.
 *
 * The same shape `TimelineAnchor` uses, minus the subject arm: a subject is a
 * record on the generic renderer rather than a counterparty, so "how quickly do
 * they reply" is not a question about one.
 */
export type RelationshipAnchor =
  | { readonly kind: "party"; readonly partyId: string }
  | { readonly kind: "deal"; readonly dealId: number };

/**
 * The deal a stored row is anchored to, insisted upon.
 *
 * A row reaches here having already failed the `party_id` test, so it is
 * deal-anchored by elimination — and a deal-anchored row with no `deal_id` is a
 * contradiction the CHECK constraint exists to prevent. This used to read
 * `row.dealId ?? ""`, which turned that contradiction into an anchor pointing at
 * nothing and carried it into a caller's query. There is no empty integer to
 * fall back to, and inventing one would only move the problem, so it throws
 * where the state is actually wrong.
 */
function dealAnchorId(dealId: number | null): number {
  if (dealId === null)
    throw new Error("relationship_states row has neither a party nor a deal anchor");
  return dealId;
}

export interface StoredRelationship {
  readonly relationshipStateId: string;
  readonly anchor: RelationshipAnchor;
  readonly state: RelationshipState;
}

/** How many relationships one sweep of the awaiting-reply read may return. */
export const AWAITING_REPLY_PAGE = 200;

/**
 * The materialiser.
 *
 * There is one write path and one read path and both of them go through
 * `foldRelationshipState`, which is the entire point: an updater and a rebuilder
 * written as two computations agree right up until they do not, and then nothing
 * says which one is right. Here `onActivity` and `rebuild` are the same method
 * with a different way of naming the anchor.
 *
 * That makes the state genuinely disposable. Truncate all three tables and the
 * next activity on a relationship puts that relationship back exactly as it was;
 * `relationship-state.db.spec.ts` proves it against a real database rather than
 * asserting it here.
 */
@Injectable()
export class RelationshipStateService {
  private readonly logger = new Logger("RelationshipState");

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Bring a relationship up to date because something arrived on it.
   *
   * Called from the ingress workflow and from `ActivitiesService`, so the state
   * moves when a communication does rather than waiting for a sweep — which is
   * ticket 01's fourth criterion and also the only way a silence judgement can
   * be honest, since a state a day behind reports a silence a day late.
   *
   * The activity is read WITHOUT the soft-delete filter on purpose: deleting an
   * activity changes what the relationship looks like just as much as adding
   * one, and the anchor is still on the row.
   */
  async onActivity(organizationId: string, activityId: string): Promise<void> {
    const [row] = await this.db
      .select({ partyId: activities.partyId, dealId: activities.dealId })
      .from(activities)
      .where(
        and(eq(activities.organizationId, organizationId), eq(activities.activityId, activityId)),
      )
      .limit(1);

    if (!row) return;

    // A subject-anchored activity has neither, and is not a relationship.
    const anchor: RelationshipAnchor | null = row.partyId
      ? { kind: "party", partyId: row.partyId }
      : row.dealId
        ? { kind: "deal", dealId: row.dealId }
        : null;

    if (!anchor) return;
    await this.rebuild(organizationId, anchor);
  }

  /**
   * Rebuild one relationship from its activities, replacing whatever was there.
   *
   * A replace rather than a merge. The state is a function of the activities, so
   * anything the previous row held that this fold does not produce is by
   * definition wrong — a participant who was removed from a thread, a
   * conversation whose activities were deleted. Merging would keep them forever.
   */
  async rebuild(organizationId: string, anchor: RelationshipAnchor): Promise<void> {
    const rows = await this.loadWindow(organizationId, anchor);
    const state = foldRelationshipState(rows);

    await this.db.transaction(async (tx) => {
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

  /**
   * The stored state, in the same shape the fold produces.
   *
   * One shape rather than two is what makes "rebuilding produces the identical
   * state" a single comparison instead of a column-by-column argument, and it is
   * what lets tickets 02 and 03 write their judgements as pure functions over a
   * `RelationshipState` without caring which side of the seam it came from.
   */
  async read(organizationId: string, anchor: RelationshipAnchor): Promise<StoredRelationship | null> {
    const [row] = await this.db
      .select({
        relationshipStateId: relationshipStates.relationshipStateId,
        partyId: relationshipStates.partyId,
        dealId: relationshipStates.dealId,
        observedFrom: relationshipStates.observedFrom,
        lastContactAt: relationshipStates.lastContactAt,
        lastInboundAt: relationshipStates.lastInboundAt,
        lastOutboundAt: relationshipStates.lastOutboundAt,
        lastInboundActivityId: relationshipStates.lastInboundActivityId,
        lastOutboundActivityId: relationshipStates.lastOutboundActivityId,
        awaitingReplySince: relationshipStates.awaitingReplySince,
        contactCount: relationshipStates.contactCount,
        inboundCount: relationshipStates.inboundCount,
        outboundCount: relationshipStates.outboundCount,
        unreadableDirectionCount: relationshipStates.unreadableDirectionCount,
        replySampleCount: relationshipStates.replySampleCount,
        replyP50Seconds: relationshipStates.replyP50Seconds,
        replyP90Seconds: relationshipStates.replyP90Seconds,
        replyMinSeconds: relationshipStates.replyMinSeconds,
        replyMaxSeconds: relationshipStates.replyMaxSeconds,
      })
      .from(relationshipStates)
      .where(
        and(
          eq(relationshipStates.organizationId, organizationId),
          anchor.kind === "party"
            ? eq(relationshipStates.partyId, anchor.partyId)
            : eq(relationshipStates.dealId, anchor.dealId),
        ),
      )
      .limit(1);

    // A relationship nobody has ever communicated with is absent rather than
    // empty, and cross-tenant is the same answer — which is what makes a 404 at
    // the surface honest instead of an existence oracle.
    if (!row) return null;

    const [participants, threads] = await Promise.all([
      this.db
        .select({
          identity: relationshipParticipants.identity,
          partyId: relationshipParticipants.partyId,
          userId: relationshipParticipants.userId,
          address: relationshipParticipants.address,
          roles: relationshipParticipants.roles,
          firstSeenAt: relationshipParticipants.firstSeenAt,
          lastSeenAt: relationshipParticipants.lastSeenAt,
          messageCount: relationshipParticipants.messageCount,
          repliedCount: relationshipParticipants.repliedCount,
          lastRepliedAt: relationshipParticipants.lastRepliedAt,
        })
        .from(relationshipParticipants)
        .where(
          and(
            eq(relationshipParticipants.organizationId, organizationId),
            eq(relationshipParticipants.relationshipStateId, row.relationshipStateId),
          ),
        )
        .orderBy(asc(relationshipParticipants.identity)),
      this.db
        .select({
          threadId: relationshipThreads.threadId,
          subject: relationshipThreads.subject,
          firstSeenAt: relationshipThreads.firstSeenAt,
          lastSeenAt: relationshipThreads.lastSeenAt,
          messageCount: relationshipThreads.messageCount,
          lastDirection: relationshipThreads.lastDirection,
          precededByThreadId: relationshipThreads.precededByThreadId,
        })
        .from(relationshipThreads)
        .where(
          and(
            eq(relationshipThreads.organizationId, organizationId),
            eq(relationshipThreads.relationshipStateId, row.relationshipStateId),
          ),
        )
        .orderBy(asc(relationshipThreads.threadId)),
    ]);

    return {
      relationshipStateId: row.relationshipStateId,
      anchor: row.partyId
        ? { kind: "party", partyId: row.partyId }
        : { kind: "deal", dealId: dealAnchorId(row.dealId) },
      state: {
        observedFrom: row.observedFrom,
        lastContactAt: row.lastContactAt,
        lastInboundAt: row.lastInboundAt,
        lastOutboundAt: row.lastOutboundAt,
        lastInboundActivityId: row.lastInboundActivityId,
        lastOutboundActivityId: row.lastOutboundActivityId,
        awaitingReplySince: row.awaitingReplySince,
        contactCount: row.contactCount,
        inboundCount: row.inboundCount,
        outboundCount: row.outboundCount,
        unreadableDirectionCount: row.unreadableDirectionCount,
        replyLatency: {
          sampleCount: row.replySampleCount,
          p50Seconds: row.replyP50Seconds,
          p90Seconds: row.replyP90Seconds,
          minSeconds: row.replyMinSeconds,
          maxSeconds: row.replyMaxSeconds,
        },
        participants: participants.map((participant) => ({
          ...participant,
          roles: [...participant.roles].sort(),
        })),
        threads,
      },
    };
  }

  /**
   * Every relationship where it is still their turn, oldest first.
   *
   * The read ticket 02's detector runs. `olderThan` is passed by the caller
   * rather than computed here so the judgement owns its own clock — a sweep that
   * decided its own cutoff would be untestable without freezing time.
   */
  async listAwaitingReply(
    organizationId: string,
    olderThan: Date,
    limit = AWAITING_REPLY_PAGE,
  ): Promise<StoredRelationship[]> {
    const rows = await this.db
      .select({
        partyId: relationshipStates.partyId,
        dealId: relationshipStates.dealId,
      })
      .from(relationshipStates)
      .where(
        and(
          eq(relationshipStates.organizationId, organizationId),
          isNotNull(relationshipStates.awaitingReplySince),
          lte(relationshipStates.awaitingReplySince, olderThan),
        ),
      )
      .orderBy(asc(relationshipStates.awaitingReplySince))
      .limit(Math.min(limit, AWAITING_REPLY_PAGE));

    const found: StoredRelationship[] = [];
    for (const row of rows) {
      const anchor: RelationshipAnchor = row.partyId
        ? { kind: "party", partyId: row.partyId }
        : { kind: "deal", dealId: dealAnchorId(row.dealId) };
      const stored = await this.read(organizationId, anchor);
      if (stored) found.push(stored);
    }

    return found;
  }

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
  private async loadWindow(
    organizationId: string,
    anchor: RelationshipAnchor,
  ): Promise<RelationshipActivityRow[]> {
    const rows = await this.db
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
    const people = await this.db
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
   * Best-effort maintenance, for callers whose real job is something else.
   *
   * The ingress workflow and the activities writer both file a communication
   * first and update this second, and neither should fail because a
   * materialisation did. A state one activity behind is repaired by the next
   * activity or by an explicit rebuild; a delivery rejected because a derived
   * table could not be written is a lost message.
   *
   * It never swallows silently — a deferred failure nobody logged is the next
   * outage nobody can see.
   */
  async tryOnActivity(organizationId: string, activityId: string): Promise<void> {
    try {
      await this.onActivity(organizationId, activityId);
    } catch (error) {
      this.logger.warn(
        `relationship state not updated for activity ${activityId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
