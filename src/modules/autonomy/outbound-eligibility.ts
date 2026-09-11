import type { OutboundClass } from "./outbound-classes";

/**
 * Whether the relationship warrants a message, and which one.
 *
 * Pure, and separated from the drafting for the reason the phase brief gives:
 * this decision is the one that can be argued with, so it has to be readable
 * without a database and testable without a model. Nothing here writes, spends
 * or sends — it answers "is there something to say", and the answer is a value.
 *
 * It is NOT the guardrail. This runs when the message is composed;
 * `send-guardrails.ts` runs when it leaves, and the two disagree on purpose —
 * the state that makes a send wrong (a reply arrived, consent was withdrawn, the
 * deal closed) changes in between, so the compose-time reading of it is a
 * courtesy and the send-time reading is the enforcement.
 */

export type DealState = "open" | "won" | "lost" | "none";

export interface RelationshipSnapshot {
  readonly now: Date;
  /** The last thing they said to us, on any channel. */
  readonly lastInboundAt: Date | null;
  /** The last thing anyone here said to them — a rep's mail counts. */
  readonly lastOutboundAt: Date | null;
  /** The last thing *the system* said to them, which is what spacing measures. */
  readonly lastAutonomousOutboundAt: Date | null;
  readonly dealState: DealState;
  /** Whether the outstanding next step is ours rather than theirs. */
  readonly awaitingUs: boolean;
  readonly nextStepDueAt: Date | null;
  readonly hasReachableAddress: boolean;
  /**
   * How long this customer normally takes to reply, in seconds, when it has
   * been observed often enough to mean anything.
   *
   * Null is the ordinary case and not a defect: a relationship with one message
   * in it has no cadence, and `relationship_states.reply_p50_seconds` stays
   * null until there is one. A null falls back to the fixed thresholds below,
   * which is what every relationship used to get.
   */
  readonly replyP50Seconds?: number | null;
}

export type OutboundRefusal =
  | "no-reachable-address"
  | "deal-closed"
  | "they-replied"
  | "the-ball-is-ours"
  | "too-soon-since-our-last"
  | "nothing-to-say";

export type OutboundVerdict =
  | {
      readonly act: true;
      readonly outboundClass: OutboundClass;
      readonly reason:
        | "next-step-overdue"
        | "silence-on-an-open-deal"
        | "long-silence";
    }
  | { readonly act: false; readonly reason: OutboundRefusal };

/**
 * How long the system waits before drafting to the same party again.
 *
 * Deliberately shorter than the send-time frequency cap and doing a different
 * job: this stops one loop redrafting the same nudge on every sweep, the cap
 * stops four loops each politely sending one. A loop that only had this would
 * still be safe on its own and dangerous in company.
 */
export const OUTBOUND_SPACING_DAYS = 5;

/**
 * Silence, before the system will nudge an open deal.
 *
 * Exported because the sweep that finds candidates has to use the same number
 * this function judges them by. A sweep with its own copy either misses deals
 * that are due, or pays to load and refuse ones that are not — and the two
 * numbers drift apart the first time either is tuned. It is the shorter of the
 * two thresholds, so it is the earliest anything here can be due, which makes it
 * the right cutoff for a candidate query.
 */
export const NUDGE_AFTER_DAYS = 10;

/** Silence, before it will check in on a relationship with nothing open. */
const CHECK_IN_AFTER_DAYS = 45;

/**
 * Silence is relative to how this person normally answers.
 *
 * Ten days is a reasonable default and a poor universal rule. Somebody who
 * replies within two hours has plainly gone quiet long before day ten, and by
 * then the deal has cooled; somebody whose normal turnaround is three weeks has
 * not gone quiet at day ten at all, and a nudge there is nagging a customer who
 * is behaving exactly as they always do. The product already measures the
 * difference — `relationship_states.reply_p50_seconds` has been computed and
 * stored since relationships shipped — and nothing read it.
 *
 * Three of their own reply times, because one is their normal rhythm and two is
 * a slow week. Three is the first multiple that is hard to explain as anything
 * but silence.
 */
const SILENCE_CADENCE_MULTIPLE = 3;

/**
 * How far the observed cadence may move the threshold, as a fraction of it.
 *
 * The band is what keeps this an adjustment rather than a second policy. A
 * customer who replies in ten minutes must not have the system chasing them the
 * same afternoon — the floor holds at three days for a nudge, which is still
 * inside `OUTBOUND_SPACING_DAYS` and so cannot produce a second message anyway.
 * A customer who replies in three months must not push an open deal out to a
 * year of silence; twenty days is the longest an open deal goes unattended
 * whatever the history says.
 */
const SILENCE_MIN_FRACTION = 0.3;
const SILENCE_MAX_FRACTION = 2;

/**
 * The earliest any relationship can become due, and therefore the cutoff a
 * candidate sweep must use.
 *
 * Exported for the same reason `NUDGE_AFTER_DAYS` is, and it replaces it in
 * that role: once the threshold moves per relationship, a sweep still cutting
 * at ten days would never surface the fast-replying relationships this whole
 * mechanism exists to serve, and the feature would be inert while looking
 * finished. Widening the cutoff costs database reads and not provider calls —
 * `composeAndHold` runs `judgeOutbound` before it spends anything, so a
 * candidate that is not yet due is refused for free.
 */
export const EARLIEST_SILENCE_DAYS = NUDGE_AFTER_DAYS * SILENCE_MIN_FRACTION;

/**
 * The silence threshold for one relationship, in days.
 *
 * Exported so the sweep and the tests can state the same number this function
 * judges by, and pure so the band above can be argued with directly.
 */
export function silenceThresholdDays(
  defaultDays: number,
  replyP50Seconds: number | null | undefined,
): number {
  if (replyP50Seconds === null || replyP50Seconds === undefined) return defaultDays;
  /**
   * A non-positive or non-finite median is a broken measurement, not a customer
   * who replies instantly. Falling back is the only safe reading: treating zero
   * as "replies at once" would set the threshold to the floor for every
   * relationship whose statistics have not been computed properly yet.
   */
  if (!Number.isFinite(replyP50Seconds) || replyP50Seconds <= 0) return defaultDays;

  const observedDays = (replyP50Seconds / 86_400) * SILENCE_CADENCE_MULTIPLE;
  return Math.min(
    Math.max(observedDays, defaultDays * SILENCE_MIN_FRACTION),
    defaultDays * SILENCE_MAX_FRACTION,
  );
}

/**
 * How late a next step has to be before chasing it is not pedantic.
 *
 * A message on the morning something was due reads as a system watching a
 * calendar rather than a colleague noticing.
 */
const NEXT_STEP_GRACE_DAYS = 1;

const DAY_MS = 86_400_000;

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / DAY_MS;
}

/**
 * The order below is the argument.
 *
 * Every refusal is checked before every reason to act, so a snapshot that both
 * warrants a nudge and shows a reply resolves to the reply. The reverse
 * ordering would produce a message that is technically due and obviously wrong,
 * which is the failure this loop is judged on.
 */
export function judgeOutbound(snapshot: RelationshipSnapshot): OutboundVerdict {
  if (!snapshot.hasReachableAddress) return { act: false, reason: "no-reachable-address" };

  // A closed deal has no follow-up. Won or lost, the next message is a human's.
  if (snapshot.dealState === "won" || snapshot.dealState === "lost")
    return { act: false, reason: "deal-closed" };

  /**
   * They answered. `>` rather than `>=`, so a reply recorded at the same
   * millisecond as our own message — which is what an import of both sides of a
   * thread produces — is not read as an answer to it.
   */
  if (
    snapshot.lastInboundAt &&
    snapshot.lastOutboundAt &&
    snapshot.lastInboundAt.getTime() > snapshot.lastOutboundAt.getTime()
  )
    return { act: false, reason: "they-replied" };

  // We owe them something. Asking them for an update on our own homework is the
  // single most embarrassing thing an automated follow-up can do.
  if (snapshot.awaitingUs) return { act: false, reason: "the-ball-is-ours" };

  if (
    snapshot.lastAutonomousOutboundAt &&
    daysBetween(snapshot.lastAutonomousOutboundAt, snapshot.now) < OUTBOUND_SPACING_DAYS
  )
    return { act: false, reason: "too-soon-since-our-last" };

  /**
   * CRM-P1-08. There used to be a branch here returning `meeting_request` when
   * `snapshot.meetingRequested` was true. Nothing could ever set it true.
   *
   * The fact it needed is "they asked to meet AND nothing is booked", and only
   * the second half is answerable from what the CRM stores — no field anywhere
   * records that somebody asked. The only snapshot builder,
   * `OutboundService.loadComposeContext`, therefore hardcoded false, and the
   * compose API takes a party and a deal rather than a snapshot, so no caller
   * could supply one either. The branch was unreachable in every path, while a
   * unit test constructing the snapshot directly kept proving it worked.
   *
   * Removed rather than left as a reminder, because a branch that cannot run is
   * indistinguishable from one that has not fired yet, and the class it
   * produced would have been stoppable, reportable and cap-counted for a
   * message nobody could send.
   *
   * `meeting_request` stays in OUTBOUND_CLASSES: it is the vocabulary a human
   * uses to say "stop asking them for a meeting", it is a stored value on
   * existing rows, and it is where a wired version would return to. Nothing
   * produces it automatically today, and that is now true by inspection rather
   * than by a constant somebody has to notice.
   *
   * Inferring it from the deal's next step is not the fix. That would put a
   * meeting request in front of somebody who never asked for one, which is
   * worse than the follow-up they get instead.
   */

  if (
    snapshot.nextStepDueAt &&
    daysBetween(snapshot.nextStepDueAt, snapshot.now) >= NEXT_STEP_GRACE_DAYS
  )
    return { act: true, outboundClass: "follow_up", reason: "next-step-overdue" };

  /**
   * Never contacted reads as maximally quiet rather than as freshly contacted.
   *
   * The alternative — treating a null as "just now" — makes the system silent
   * exactly on the relationships nobody has touched, which are the ones the
   * ticket is about.
   */
  const quietDays = snapshot.lastOutboundAt
    ? daysBetween(snapshot.lastOutboundAt, snapshot.now)
    : Number.POSITIVE_INFINITY;

  if (
    snapshot.dealState === "open" &&
    quietDays >= silenceThresholdDays(NUDGE_AFTER_DAYS, snapshot.replyP50Seconds)
  )
    return { act: true, outboundClass: "nudge", reason: "silence-on-an-open-deal" };

  if (
    snapshot.dealState === "none" &&
    quietDays >= silenceThresholdDays(CHECK_IN_AFTER_DAYS, snapshot.replyP50Seconds)
  )
    return { act: true, outboundClass: "check_in", reason: "long-silence" };

  return { act: false, reason: "nothing-to-say" };
}

/** One sentence for the ledger, so a refusal reads as a decision rather than a gap. */
export function outboundRefusalSummary(reason: OutboundRefusal): string {
  switch (reason) {
    case "no-reachable-address":
      return "No address on file to reach them at — nothing drafted.";
    case "deal-closed":
      return "The deal is closed; the next message here is a person's.";
    case "they-replied":
      return "They replied after our last message — there is no silence to break.";
    case "the-ball-is-ours":
      return "The outstanding next step is ours, so chasing them would be wrong.";
    case "too-soon-since-our-last":
      return `The system wrote to them within the last ${OUTBOUND_SPACING_DAYS} days.`;
    case "nothing-to-say":
      return "Nothing in the relationship warrants a message right now.";
  }
}
