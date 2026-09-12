/**
 * What normal looks like for one relationship.
 *
 * The inbound loop maps an event to a consequence, which is enough to file a
 * message and extract a next step and nothing like enough to notice that a
 * conversation stopped — because silence is not an event and there is nothing
 * for a mapper to be triggered by. Noticing it needs a model of the relationship
 * itself: when each side last spoke, how quickly this particular customer
 * normally answers, who is on the thread and in what role, and which
 * conversations exist.
 *
 * All of that is a function of the activities, and it is written as one on
 * purpose. A materialisation whose update path is a different computation from
 * its rebuild path is a second source of truth wearing a cache's clothes: the
 * two agree until an ordering bug or a missed field makes them disagree, and
 * then nothing says which is right. Here there is a single fold, the writer and
 * the rebuild both call it, and `relationship-state.db.spec.ts` proves against a
 * real database that they land on the same row.
 *
 * Pure, so every claim below can be argued with without a connection.
 */

import type { ContactDirection } from "../../db/schema/crm/relationships";

/**
 * How much history the state is built from.
 *
 * A COUNT and deliberately never a duration. A "last ninety days" bound would
 * make the answer depend on when it was asked, so tomorrow's rebuild would
 * differ from today's maintained state with no activity having changed — and
 * "rebuilding produces the identical state" would be false by construction
 * rather than by accident. A count over the same activity set is stable
 * forever.
 *
 * Four hundred is roughly two years of a weekly correspondence, which is far
 * more than a reply-latency baseline needs and still a bounded read on a
 * messaging channel where a thread never ends.
 */
export const RELATIONSHIP_WINDOW_MAX_ACTIVITIES = 400;

/**
 * One row of `activity_participants`, as much of it as this file needs.
 *
 * Exactly one of the three identifiers is set — the table's own CHECK says so —
 * and which one it is carries the meaning: a `user_id` is one of ours, anything
 * else is not.
 */
export interface RelationshipParticipantRow {
  readonly partyId: string | null;
  readonly userId: string | null;
  readonly address: string | null;
  /** `from` · `to` · `cc` · `attendee` · `organiser`. */
  readonly role: string;
}

/** One row of `activities`, with the people on it. */
export interface RelationshipActivityRow {
  readonly activityId: string;
  /** `call` · `email` · `meeting` · `note` · `task`. */
  readonly kind: string;
  readonly occurredAt: Date;
  readonly subject: string | null;
  readonly threadId: string | null;
  /** `human` or `system`. */
  readonly actorKind: string;
  /** `manual`, an adapter name, or `extraction` for what the loop itself wrote. */
  readonly source: string;
  readonly participants: readonly RelationshipParticipantRow[];
}

/**
 * How quickly this relationship answers, as a distribution rather than a mean.
 *
 * A mean is the one summary that cannot support ticket 02: a customer who
 * usually answers in an hour and once took a fortnight has a mean nobody
 * recognises, and a threshold built on it is silent for a week. Percentiles say
 * what usually happens and what the slow end of usual looks like, which is the
 * pair a silence judgement needs.
 */
export interface ReplyLatency {
  readonly sampleCount: number;
  readonly p50Seconds: number | null;
  readonly p90Seconds: number | null;
  readonly minSeconds: number | null;
  readonly maxSeconds: number | null;
}

export interface RelationshipParticipantState {
  /** `party:<id>` · `user:<id>` · `address:<normalised>` — stable across rows. */
  readonly identity: string;
  readonly partyId: string | null;
  readonly userId: string | null;
  readonly address: string | null;
  /** Every role this person was ever seen in, sorted so two folds compare equal. */
  readonly roles: readonly string[];
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly messageCount: number;
  /**
   * How many times this person was the sender of something that came IN.
   *
   * The number ticket 03 reads: a champion who stops replying while a
   * procurement contact starts is exactly a fall in one of these and a rise in
   * another, and nothing else in the model can express it.
   */
  readonly repliedCount: number;
  readonly lastRepliedAt: Date | null;
}

export interface RelationshipThreadState {
  readonly threadId: string;
  /** The first subject the thread was seen under. */
  readonly subject: string | null;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly messageCount: number;
  readonly lastDirection: ContactDirection | null;
  /**
   * Which conversation was live when this one started.
   *
   * Adjacency, and named for it. Nothing below the ingress seam carries a
   * provider-stated parent — `InboundCommunicationEvent` has no `In-Reply-To` —
   * so `parentThreadId` would be a claim the data cannot support. What is
   * genuinely observable is which thread this relationship was last active on
   * before this one began, and that is the whole of what a fork judgement needs.
   */
  readonly precededByThreadId: string | null;
}

export interface RelationshipState {
  /** The oldest activity the window kept. Null when there are none. */
  readonly observedFrom: Date | null;
  readonly lastContactAt: Date | null;
  readonly lastInboundAt: Date | null;
  readonly lastOutboundAt: Date | null;
  readonly lastInboundActivityId: string | null;
  readonly lastOutboundActivityId: string | null;
  /**
   * When the ball entered their court, or null when it is our turn.
   *
   * A timestamp rather than a flag, because ticket 02 asks how long it has been
   * their turn and a boolean has no answer. It is the FIRST unanswered outbound
   * of the current run, not the last: chasing somebody three times in an hour
   * does not restart their clock.
   */
  readonly awaitingReplySince: Date | null;
  readonly contactCount: number;
  readonly inboundCount: number;
  readonly outboundCount: number;
  /** Activities whose direction could not be read. Recorded, never assumed. */
  readonly unreadableDirectionCount: number;
  readonly replyLatency: ReplyLatency;
  readonly participants: readonly RelationshipParticipantState[];
  readonly threads: readonly RelationshipThreadState[];
}

/**
 * One person, however the row happened to name them.
 *
 * Addresses are lower-cased and trimmed for the same reason `party_identifiers`
 * normalises: `Priya@Example.com` and `priya@example.com` are one participant,
 * and counting them as two makes "the champion stopped replying" fire the first
 * time somebody's mail client changes its capitalisation.
 */
export function participantIdentity(row: RelationshipParticipantRow): string | null {
  if (row.partyId) return `party:${row.partyId}`;
  if (row.userId) return `user:${row.userId}`;
  const address = row.address?.trim().toLowerCase();
  return address ? `address:${address}` : null;
}

function senderOf(activity: RelationshipActivityRow): RelationshipParticipantRow | undefined {
  return activity.participants.find((participant) => participant.role === "from");
}

/**
 * Which way a contact travelled, or null when the record cannot say.
 *
 * The sender decides, and the actor column is only the fallback. A rep pasting a
 * customer's reply into the CRM files it as `human`, so reading `actor_kind`
 * first would attribute the customer's own words to us — and "who owes the next
 * step" is decided by exactly that.
 *
 * Null is a real answer rather than a failure. A direction we cannot read is not
 * a direction we may assume: the telephony adapter already refuses a call whose
 * provider stated none, and inventing one here would corrupt the latency
 * baseline every downstream judgement is built on. The count of them is carried
 * on the state so the gap is visible rather than silent.
 */
export function directionOf(activity: RelationshipActivityRow): ContactDirection | null {
  // A task is a next step, not a contact, and an extraction is the loop talking
  // to itself. Neither is somebody saying something to somebody.
  if (activity.kind === "task") return null;
  if (activity.source === "extraction") return null;

  const sender = senderOf(activity);
  if (sender) return sender.userId ? "outbound" : "inbound";

  // No sender recorded. A person filing something by hand is one of ours; a
  // system row nobody is named on says nothing at all.
  if (activity.actorKind === "human") return "outbound";
  return null;
}

/**
 * A total order over a relationship's history.
 *
 * The same order every cursor over `activities` uses, and for the same reason:
 * timestamps collide — an imported mail folder writes hundreds in one second —
 * so the identifier is the tie-break. Without it "which of these two came first"
 * is decided by whatever order the rows came back in, and the reply-latency
 * samples would differ between a rebuild and an incremental update purely
 * because the two read the table differently.
 */
function compare(left: RelationshipActivityRow, right: RelationshipActivityRow): number {
  const difference = left.occurredAt.getTime() - right.occurredAt.getTime();
  if (difference !== 0) return difference;
  return left.activityId < right.activityId ? -1 : left.activityId > right.activityId ? 1 : 0;
}

/** Nearest-rank, which needs no interpolation and is exact on tiny samples. */
function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

interface MutableParticipant {
  identity: string;
  partyId: string | null;
  userId: string | null;
  address: string | null;
  roles: Set<string>;
  firstSeenAt: Date;
  lastSeenAt: Date;
  messageCount: number;
  repliedCount: number;
  lastRepliedAt: Date | null;
}

interface MutableThread {
  threadId: string;
  subject: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  messageCount: number;
  lastDirection: ContactDirection | null;
  precededByThreadId: string | null;
}

/**
 * The whole state, from the activities and nothing else.
 *
 * Deduplicates by identifier and sorts before it counts anything, so the result
 * is a function of the activity SET rather than of the sequence a caller
 * happened to hold — which is what lets the incremental writer hand it a growing
 * prefix and the rebuild hand it everything, and get the same row.
 */
export function foldRelationshipState(
  rows: readonly RelationshipActivityRow[],
): RelationshipState {
  const unique = new Map<string, RelationshipActivityRow>();
  for (const row of rows) unique.set(row.activityId, row);

  const ordered = [...unique.values()].sort(compare);
  // The newest N. The bound is applied here as well as in the read, so the
  // authority on how much history counts is a function that can be argued with
  // rather than a LIMIT in one of two queries.
  const window =
    ordered.length > RELATIONSHIP_WINDOW_MAX_ACTIVITIES
      ? ordered.slice(ordered.length - RELATIONSHIP_WINDOW_MAX_ACTIVITIES)
      : ordered;

  const participants = new Map<string, MutableParticipant>();
  const threads = new Map<string, MutableThread>();
  const latencies: number[] = [];

  let lastContactAt: Date | null = null;
  let lastInboundAt: Date | null = null;
  let lastOutboundAt: Date | null = null;
  let lastInboundActivityId: string | null = null;
  let lastOutboundActivityId: string | null = null;
  let awaitingReplySince: Date | null = null;
  let inboundCount = 0;
  let outboundCount = 0;
  let unreadableDirectionCount = 0;
  let liveThreadId: string | null = null;

  for (const activity of window) {
    const direction = directionOf(activity);

    for (const row of activity.participants) {
      const identity = participantIdentity(row);
      if (!identity) continue;

      const existing = participants.get(identity);
      const entry: MutableParticipant = existing ?? {
        identity,
        partyId: row.partyId,
        userId: row.userId,
        address: row.address?.trim().toLowerCase() ?? null,
        roles: new Set<string>(),
        firstSeenAt: activity.occurredAt,
        lastSeenAt: activity.occurredAt,
        messageCount: 0,
        repliedCount: 0,
        lastRepliedAt: null,
      };

      entry.roles.add(row.role);
      entry.messageCount += 1;
      if (activity.occurredAt < entry.firstSeenAt) entry.firstSeenAt = activity.occurredAt;
      if (activity.occurredAt > entry.lastSeenAt) entry.lastSeenAt = activity.occurredAt;

      if (row.role === "from" && direction === "inbound") {
        entry.repliedCount += 1;
        if (!entry.lastRepliedAt || activity.occurredAt > entry.lastRepliedAt)
          entry.lastRepliedAt = activity.occurredAt;
      }

      participants.set(identity, entry);
    }

    if (activity.threadId) {
      const existing = threads.get(activity.threadId);
      if (existing) {
        existing.messageCount += 1;
        existing.lastSeenAt = activity.occurredAt;
        if (direction) existing.lastDirection = direction;
      } else {
        threads.set(activity.threadId, {
          threadId: activity.threadId,
          subject: activity.subject,
          firstSeenAt: activity.occurredAt,
          lastSeenAt: activity.occurredAt,
          messageCount: 1,
          lastDirection: direction,
          // The conversation this relationship was last active on. Null for the
          // first thread it ever had, which has nothing to have branched from.
          precededByThreadId: liveThreadId,
        });
      }
      liveThreadId = activity.threadId;
    }

    if (!direction) {
      unreadableDirectionCount += 1;
      continue;
    }

    lastContactAt = activity.occurredAt;

    if (direction === "inbound") {
      inboundCount += 1;
      lastInboundAt = activity.occurredAt;
      lastInboundActivityId = activity.activityId;

      if (awaitingReplySince) {
        // Clamped at zero: an out-of-order provider timestamp is a bad clock,
        // not a reply that arrived before it was prompted.
        const seconds = Math.max(
          0,
          Math.round((activity.occurredAt.getTime() - awaitingReplySince.getTime()) / 1000),
        );
        latencies.push(seconds);
        awaitingReplySince = null;
      }
      continue;
    }

    outboundCount += 1;
    lastOutboundAt = activity.occurredAt;
    lastOutboundActivityId = activity.activityId;
    // Only the FIRST of a run starts their clock. See `awaitingReplySince`.
    if (!awaitingReplySince) awaitingReplySince = activity.occurredAt;
  }

  const sortedLatencies = [...latencies].sort((left, right) => left - right);

  return {
    observedFrom: window[0]?.occurredAt ?? null,
    lastContactAt,
    lastInboundAt,
    lastOutboundAt,
    lastInboundActivityId,
    lastOutboundActivityId,
    awaitingReplySince,
    contactCount: inboundCount + outboundCount,
    inboundCount,
    outboundCount,
    unreadableDirectionCount,
    replyLatency: {
      sampleCount: sortedLatencies.length,
      p50Seconds: percentile(sortedLatencies, 0.5),
      p90Seconds: percentile(sortedLatencies, 0.9),
      minSeconds: sortedLatencies[0] ?? null,
      maxSeconds: sortedLatencies[sortedLatencies.length - 1] ?? null,
    },
    // Both sorted by their own stable key, so two folds of the same set are
    // deeply equal rather than merely equivalent — which is what makes
    // "rebuilding produces the identical state" assertable with one comparison.
    participants: [...participants.values()]
      .sort((left, right) => (left.identity < right.identity ? -1 : 1))
      .map((entry) => ({
        identity: entry.identity,
        partyId: entry.partyId,
        userId: entry.userId,
        address: entry.address,
        roles: [...entry.roles].sort(),
        firstSeenAt: entry.firstSeenAt,
        lastSeenAt: entry.lastSeenAt,
        messageCount: entry.messageCount,
        repliedCount: entry.repliedCount,
        lastRepliedAt: entry.lastRepliedAt,
      })),
    threads: [...threads.values()]
      .sort((left, right) => (left.threadId < right.threadId ? -1 : 1))
      .map((entry) => ({
        threadId: entry.threadId,
        subject: entry.subject,
        firstSeenAt: entry.firstSeenAt,
        lastSeenAt: entry.lastSeenAt,
        messageCount: entry.messageCount,
        lastDirection: entry.lastDirection,
        precededByThreadId: entry.precededByThreadId,
      })),
  };
}
