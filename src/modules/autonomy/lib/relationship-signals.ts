import type {
  RelationshipParticipantState,
  RelationshipThreadState,
} from "../../relationships/relationship-state";
import type { StoredRelationship } from "../../relationships/relationship-state.types";

/*
  Phase 4 ticket 03: two pure judgements over a relationship's state before and
  after a fold, each returning evidence and a confidence or nothing at all —
  "including cases where the right answer is to do nothing" is the ticket's own
  fourth criterion, and a detector that always fires when the structural shape
  is present could not satisfy it. Both take `StoredRelationship | null` on
  both sides rather than requiring one: a relationship that did not exist
  before this fold has no "before" to compare, and one that a hard delete
  erased has no "after" — neither is an error, both are simply nothing to
  detect a change against.

  Deliberately deterministic rather than model-scored, unlike the extraction
  path's `confidence`: there is no provider call here to calibrate against, so
  a graded score is this module's own judgement of how clear the evidence is,
  not a probability estimate. `RelationshipSignalsService` applies the same
  `shouldAct` gate to it that every other decision kind uses.
*/

export interface ParticipantChangeSignal {
  readonly droppedIdentity: string;
  readonly droppedRoles: readonly string[];
  readonly risenIdentity: string;
  readonly risenRoles: readonly string[];
  readonly confidence: number;
  readonly evidence: Record<string, unknown>;
}

export interface ThreadForkSignal {
  readonly threadId: string;
  readonly precededByThreadId: string;
  readonly subject: string | null;
  readonly precedingSubject: string | null;
  readonly confidence: number;
  readonly evidence: Record<string, unknown>;
}

/**
 * Who this relationship currently answers through.
 *
 * The participant with the most inbound replies, ties broken by the most
 * recent one — "most replies" alone cannot separate two people who have each
 * answered once, and the tiebreak is the only fact that can. Silent on a
 * relationship where nobody has ever replied (`repliedCount` is 0 for
 * everyone): there is no primary responder to report, not a primary responder
 * of `null`.
 */
function primaryResponder(
  participants: readonly RelationshipParticipantState[],
): RelationshipParticipantState | null {
  let best: RelationshipParticipantState | null = null;
  for (const participant of participants) {
    if (participant.repliedCount <= 0) continue;
    if (!best) {
      best = participant;
      continue;
    }
    if (participant.repliedCount > best.repliedCount) {
      best = participant;
      continue;
    }
    if (
      participant.repliedCount === best.repliedCount &&
      (participant.lastRepliedAt?.getTime() ?? 0) > (best.lastRepliedAt?.getTime() ?? 0)
    ) {
      best = participant;
    }
  }
  return best;
}

/**
 * A margin of one reply is real but marginal; each further reply says the
 * handoff is not a coincidence. Capped short of certainty — this is still a
 * count of replies, not a witnessed resignation.
 */
function marginConfidence(margin: number): number {
  return Math.min(0.5 + margin * 0.1, 0.95);
}

/**
 * The champion stopped replying while a procurement contact started, as a
 * signal rather than a narrative.
 *
 * Requires FOUR things at once, each ruling out a different false positive:
 * a previous primary responder existed (nothing to have changed FROM
 * otherwise); a new one exists and is a different identity (a repeat replier
 * is not a change); the new primary has genuinely replied more recently than
 * the old one currently stands at (a reordering of the same two people by
 * `repliedCount` alone, with the old one still the last word, is not a
 * handoff); and the new primary now leads by more than the noise floor of one
 * reply either way.
 */
export function detectParticipantChange(
  previous: StoredRelationship | null,
  next: StoredRelationship | null,
): ParticipantChangeSignal | null {
  if (!previous || !next) return null;

  const prevPrimary = primaryResponder(previous.state.participants);
  const nextPrimary = primaryResponder(next.state.participants);
  if (!prevPrimary || !nextPrimary) return null;
  if (prevPrimary.identity === nextPrimary.identity) return null;
  if (!nextPrimary.lastRepliedAt) return null;

  const oldPrimaryNow =
    next.state.participants.find((p) => p.identity === prevPrimary.identity) ?? null;
  const oldPrimaryLastRepliedAt = oldPrimaryNow?.lastRepliedAt ?? prevPrimary.lastRepliedAt;
  if (oldPrimaryLastRepliedAt && nextPrimary.lastRepliedAt <= oldPrimaryLastRepliedAt) return null;

  const oldPrimaryRepliedCountNow = oldPrimaryNow?.repliedCount ?? prevPrimary.repliedCount;
  const margin = nextPrimary.repliedCount - oldPrimaryRepliedCountNow;
  if (margin < 1) return null;

  return {
    droppedIdentity: prevPrimary.identity,
    droppedRoles: prevPrimary.roles,
    risenIdentity: nextPrimary.identity,
    risenRoles: nextPrimary.roles,
    confidence: marginConfidence(margin),
    evidence: {
      dropped: {
        identity: prevPrimary.identity,
        roles: prevPrimary.roles,
        repliedCountThen: prevPrimary.repliedCount,
        repliedCountNow: oldPrimaryRepliedCountNow,
        lastRepliedAt: oldPrimaryLastRepliedAt?.toISOString() ?? null,
      },
      risen: {
        identity: nextPrimary.identity,
        roles: nextPrimary.roles,
        repliedCount: nextPrimary.repliedCount,
        lastRepliedAt: nextPrimary.lastRepliedAt.toISOString(),
      },
      margin,
    },
  };
}

/**
 * A subject stripped of reply/forward chrome, for comparing what a thread is
 * actually about rather than how it was addressed.
 *
 * Repeated on purpose — "Re: Re: Fwd: Pricing" is a real subject line after
 * three hops through different mail clients, and stopping at one strip would
 * leave "Re: Fwd: Pricing" and call it distinct from "Pricing".
 */
function normalizedSubject(subject: string | null): string | null {
  if (!subject) return null;
  let s = subject.trim();
  let stripped = true;
  while (stripped) {
    const next = s.replace(/^(re|fwd?)\s*:\s*/i, "");
    stripped = next !== s;
    s = next;
  }
  return s.trim().toLowerCase() || null;
}

/**
 * Whether a new subject is its own conversation rather than the old one
 * continuing under a slightly different line.
 *
 * Equal after normalizing is the obvious "not distinct". A one-way substring
 * match ("Pricing" inside "Pricing — updated for Q3") is treated the same
 * way: the second party added to what was already being discussed rather than
 * raising something else, and ticket 03's own acceptance is that a fork
 * "never silently moves the original deal's history" — the cost of missing a
 * real fork here is a human glancing at one more thread, and the cost of
 * calling a continuation a fork is a duplicate opportunity on the board.
 */
function subjectsDistinct(preceding: string | null, next: string | null): boolean {
  const a = normalizedSubject(preceding);
  const b = normalizedSubject(next);
  if (!a || !b) return false;
  if (a === b) return false;
  return !a.includes(b) && !b.includes(a);
}

/**
 * A conversation that forked into a distinct subject, as a signal.
 *
 * Only a thread this fold has not seen before can be a fork — `threads` is
 * append-only within the window, so a thread already present was already
 * judged. `precededByThreadId` is what makes this a fork rather than simply a
 * new conversation: it says another thread on this relationship was live when
 * this one began, and `subjectsDistinct` is what tells the two apart from one
 * being a continuation of the other under a new banner.
 */
export function detectThreadFork(
  previous: StoredRelationship | null,
  next: StoredRelationship | null,
): ThreadForkSignal | null {
  if (!next) return null;

  const previousThreadIds = new Set(
    (previous?.state.threads ?? []).map((t: RelationshipThreadState) => t.threadId),
  );

  for (const thread of next.state.threads) {
    if (previousThreadIds.has(thread.threadId)) continue;
    if (!thread.precededByThreadId) continue;

    const preceding =
      next.state.threads.find((t) => t.threadId === thread.precededByThreadId) ??
      previous?.state.threads.find((t) => t.threadId === thread.precededByThreadId) ??
      null;
    if (!preceding) continue;
    if (!subjectsDistinct(preceding.subject, thread.subject)) continue;

    return {
      threadId: thread.threadId,
      precededByThreadId: thread.precededByThreadId,
      subject: thread.subject,
      precedingSubject: preceding.subject,
      // Both subjects present and unambiguously distinct is as clear as this
      // detector's evidence gets — there is no provider score to grade it by.
      confidence: 0.85,
      evidence: {
        threadId: thread.threadId,
        subject: thread.subject,
        precededByThreadId: thread.precededByThreadId,
        precedingSubject: preceding.subject,
      },
    };
  }

  return null;
}
