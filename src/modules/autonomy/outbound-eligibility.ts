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
  /** They asked to meet and nothing is booked. */
  readonly meetingRequested: boolean;
  readonly hasReachableAddress: boolean;
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
        | "meeting-requested"
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

/** Silence, before the system will nudge an open deal. */
const NUDGE_AFTER_DAYS = 10;

/** Silence, before it will check in on a relationship with nothing open. */
const CHECK_IN_AFTER_DAYS = 45;

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

  if (snapshot.meetingRequested)
    return { act: true, outboundClass: "meeting_request", reason: "meeting-requested" };

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

  if (snapshot.dealState === "open" && quietDays >= NUDGE_AFTER_DAYS)
    return { act: true, outboundClass: "nudge", reason: "silence-on-an-open-deal" };

  if (snapshot.dealState === "none" && quietDays >= CHECK_IN_AFTER_DAYS)
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
