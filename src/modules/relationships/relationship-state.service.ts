import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, eq, isNotNull, lte } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import {
  activities,
  relationshipParticipants,
  relationshipStates,
  relationshipThreads,
} from "../../db/schema";
import { foldRelationshipState } from "./relationship-state";
import type { RelationshipAnchor, StoredRelationship } from "./relationship-state.types";
import { loadRelationshipWindow, writeRelationshipState } from "./lib/relationship-rebuild";

export type { RelationshipAnchor, StoredRelationship } from "./relationship-state.types";

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

  // The activity window `rebuild` folds, and the transactional write of the
  // result, live in `lib/relationship-rebuild.ts` and take this service's handle.

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
    const rows = await loadRelationshipWindow(this.db, organizationId, anchor);
    const state = foldRelationshipState(rows);

    await writeRelationshipState(this.db, organizationId, anchor, state);
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
