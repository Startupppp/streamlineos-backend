import type {
  RelationshipParticipantState,
  RelationshipState,
  RelationshipThreadState,
} from "./relationship-state";

/**
 * What changed about a relationship that changes what the deal is.
 *
 * Phase 4, ticket 03. Two things are worth noticing and neither is an event that
 * arrives: a champion going quiet while procurement starts replying, and a
 * thread splitting off into something that is really a second opportunity.
 * Both are differences between two folds of the same relationship, which is why
 * this takes a before and an after rather than a message.
 *
 * Pure, and separate from the service for the same reason `foldRelationshipState`
 * is: what counts as a signal is the part worth arguing about, and it should be
 * arguable without a database.
 */
export const RELATIONSHIP_SIGNAL_KINDS = [
  "participant.arrived",
  "participant.went-quiet",
  "participant.replier-changed",
  "thread.forked",
] as const;

export type RelationshipSignalKind = (typeof RELATIONSHIP_SIGNAL_KINDS)[number];

/**
 * How far a signal may be acted on without a human.
 *
 * Mirrors `decision-record.ts` deliberately rather than inventing a second
 * vocabulary: these become autonomous decisions, and a decision whose class is
 * named differently here would be classified twice and could disagree with
 * itself.
 */
export type SignalReversibility = "instant" | "hold";

export interface RelationshipSignal {
  readonly kind: RelationshipSignalKind;
  /**
   * Everything the judgement was made from, so a reviewer can disagree with it.
   *
   * Named values rather than a sentence: a reason string is unreadable by
   * anything but a person, and these are what a reversal has to undo.
   */
  readonly evidence: Readonly<Record<string, string | number | null>>;
  readonly reversibility: SignalReversibility;
  /** One line, for the review feed. */
  readonly summary: string;
}

/** Who is doing the most replying, or null when nobody has replied at all. */
function principalReplier(
  participants: readonly RelationshipParticipantState[],
): RelationshipParticipantState | null {
  let best: RelationshipParticipantState | null = null;
  for (const participant of participants) {
    if (participant.repliedCount === 0) continue;
    if (!best || participant.repliedCount > best.repliedCount) best = participant;
  }
  return best;
}

function byIdentity(
  participants: readonly RelationshipParticipantState[],
): Map<string, RelationshipParticipantState> {
  return new Map(participants.map((participant) => [participant.identity, participant]));
}

/**
 * How long a participant may be silent before it means something.
 *
 * Ticket 02's baseline, not a constant: a relationship that replies within an
 * hour and one that replies fortnightly are both normal, and a fixed threshold
 * would call one of them broken. Falls back to null when there is no baseline
 * yet, and a null threshold produces no signal — an unknown is not a silence.
 */
function silenceThresholdSeconds(state: RelationshipState): number | null {
  const p90 = state.replyLatency.p90Seconds;
  if (p90 === null || p90 <= 0) return null;
  // Twice the ninetieth percentile: past the slow tail of their own behaviour,
  // not merely slower than usual.
  return p90 * 2;
}

export interface DetectSignalsInput {
  readonly previous: RelationshipState;
  readonly current: RelationshipState;
  /** Evaluated against, never read from a clock inside — so a fold is reproducible. */
  readonly at: Date;
}

/**
 * Every signal the difference between two folds supports.
 *
 * Returns an empty array far more often than not, and that is the intended
 * behaviour rather than a failure to find anything: most messages change
 * nothing about who the deal is with.
 */
export function detectRelationshipSignals(input: DetectSignalsInput): RelationshipSignal[] {
  const { previous, current, at } = input;
  const signals: RelationshipSignal[] = [];

  const before = byIdentity(previous.participants);
  const after = byIdentity(current.participants);

  for (const [identity, participant] of after) {
    if (before.has(identity)) continue;
    signals.push({
      kind: "participant.arrived",
      evidence: {
        identity,
        partyId: participant.partyId,
        roles: participant.roles.join(",") || null,
        firstSeenAt: participant.firstSeenAt.toISOString(),
      },
      // Recording that somebody appeared changes nothing on its own.
      reversibility: "instant",
      summary: `${identity} joined the conversation`,
    });
  }

  const threshold = silenceThresholdSeconds(current);
  if (threshold !== null) {
    for (const [identity, participant] of after) {
      const was = before.get(identity);
      // Only somebody who WAS replying can stop; a person who never replied is
      // not newly silent, and calling them so is how this becomes noise.
      if (!was || was.repliedCount === 0) continue;
      if (participant.repliedCount > was.repliedCount) continue;

      const lastReplied = participant.lastRepliedAt;
      if (!lastReplied) continue;
      const silentFor = Math.round((at.getTime() - lastReplied.getTime()) / 1000);
      if (silentFor < threshold) continue;

      signals.push({
        kind: "participant.went-quiet",
        evidence: {
          identity,
          repliedCount: participant.repliedCount,
          lastRepliedAt: lastReplied.toISOString(),
          silentForSeconds: silentFor,
          thresholdSeconds: threshold,
        },
        reversibility: "instant",
        summary: `${identity} has not replied for ${silentFor}s, past this relationship's own p90`,
      });
    }
  }

  const wasPrincipal = principalReplier(previous.participants);
  const isPrincipal = principalReplier(current.participants);
  if (wasPrincipal && isPrincipal && wasPrincipal.identity !== isPrincipal.identity) {
    signals.push({
      kind: "participant.replier-changed",
      evidence: {
        from: wasPrincipal.identity,
        to: isPrincipal.identity,
        fromRepliedCount: wasPrincipal.repliedCount,
        toRepliedCount: isPrincipal.repliedCount,
      },
      reversibility: "instant",
      summary: `who replies moved from ${wasPrincipal.identity} to ${isPrincipal.identity}`,
    });
  }

  signals.push(...detectThreadForks(previous, current));
  return signals;
}

/**
 * A thread that split off into something the original was not about.
 *
 * The evidence available is deliberately weaker than "this is a reply to that":
 * nothing below the ingress seam carries `In-Reply-To`, so `precededByThreadId`
 * records which conversation was live when this one began and no more. A fork is
 * therefore a PROPOSAL — `hold`, never `instant`. Opening a second opportunity
 * and moving history are both things a person should agree to, and criterion 3
 * turns on the original deal's history never moving on its own.
 */
function detectThreadForks(
  previous: RelationshipState,
  current: RelationshipState,
): RelationshipSignal[] {
  const known = new Set(previous.threads.map((thread) => thread.threadId));
  const priorById = new Map(previous.threads.map((thread) => [thread.threadId, thread]));
  const out: RelationshipSignal[] = [];

  for (const thread of current.threads) {
    if (known.has(thread.threadId)) continue;
    const parentId = thread.precededByThreadId;
    if (!parentId) continue;

    const parent = priorById.get(parentId) ?? findThread(current.threads, parentId);
    if (!parent) continue;

    // Same subject is a continuation, not a fork. A missing subject on either
    // side is not evidence of anything, so it produces nothing.
    if (!thread.subject || !parent.subject) continue;
    if (normaliseSubject(thread.subject) === normaliseSubject(parent.subject)) continue;

    out.push({
      kind: "thread.forked",
      evidence: {
        threadId: thread.threadId,
        subject: thread.subject,
        precededByThreadId: parentId,
        precededBySubject: parent.subject,
        firstSeenAt: thread.firstSeenAt.toISOString(),
      },
      // Never instant. See the note above.
      reversibility: "hold",
      summary: `"${thread.subject}" may be a second opportunity, split from "${parent.subject}"`,
    });
  }

  return out;
}

function findThread(
  threads: readonly RelationshipThreadState[],
  threadId: string,
): RelationshipThreadState | null {
  return threads.find((thread) => thread.threadId === threadId) ?? null;
}

/**
 * Subject comparison that ignores what a mail client adds.
 *
 * `Re:` and `Fwd:` are the reply itself talking, not the subject changing, and
 * treating them as a difference would report a fork on every reply.
 */
function normaliseSubject(subject: string): string {
  return subject
    .replace(/^(\s*(re|fw|fwd|aw|sv)\s*:\s*)+/i, "")
    .trim()
    .toLowerCase();
}
