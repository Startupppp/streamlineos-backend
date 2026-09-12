import type { OutboundClass } from "./outbound-classes";
import type { DealState } from "./outbound-eligibility";
import { isKnownTimeZone, nextOpening, OUTBOUND_WORKING_HOURS } from "./working-hours";

/**
 * The rules that stop the system embarrassing a tenant, evaluated at SEND time.
 *
 * Not at compose time, and the distinction is the whole ticket. Every fact this
 * function reads can change between the moment a message is drafted and the
 * moment it leaves: a reply arrives, the deal closes, somebody clicks
 * unsubscribe, a colleague already mailed them, the clock crosses into the
 * evening. A guardrail checked when the draft was written would have been true
 * once and would be enforcing a stale reading of the world at the only moment
 * that matters.
 *
 * It is a pure function of a snapshot for that reason: the caller's job is to
 * take that snapshot as late as it possibly can, inside the same step that
 * claims the send, and this file's job is to be arguable without a database.
 *
 * These are enforcement, not configuration. Every threshold below is a constant
 * in this file. There is no tenant column behind any of them and no patch
 * endpoint that reaches them — `guardrails-are-not-settings.spec.ts` pins that,
 * because the way a rule like this dies is that somebody adds an override "just
 * for one customer" and the next person reads the override as the rule.
 */

export type ConsentStatus = "OPTED_IN" | "OPTED_OUT" | "UNKNOWN";

export interface SendTimeFacts {
  readonly now: Date;
  readonly outboundClass: OutboundClass;

  /**
   * Whether the party this message is addressed to has been soft-deleted (or
   * is simply gone) since the draft was held.
   *
   * A hold can sit for hours, and a party can be deleted, merged away, or
   * erased inside that window — nothing about placing the hold re-checks that
   * before the send fires. Read fresh at send time like every other fact
   * here, never carried from the draft.
   */
  readonly partyDeleted: boolean;

  /** Read from the consent model at send time, not copied from the draft. */
  readonly consent: ConsentStatus;
  readonly consentExpiresAt: Date | null;
  /** The address appears on a suppression list — the platform's or the tenant's. */
  readonly suppressed: boolean;

  /** A human stopped a message of this class to this party and nobody released it. */
  readonly classStopped: boolean;

  /**
   * When the system last sent this party ANYTHING, newest first, across every
   * loop. Not per class, and not per loop — see `PARTY_FREQUENCY_CAPS`.
   */
  readonly recentSendsToParty: readonly Date[];

  /** The party's own zone, where anybody ever recorded one. */
  readonly partyTimezone: string | null;
  /** The tenant's, which is the fallback and is always known. */
  readonly tenantTimezone: string;

  /** Anything inbound from them after the draft was written. */
  readonly repliedAt: Date | null;
  readonly draftedAt: Date;
  readonly dealState: DealState;

  /** How many times this message has already been put off for the clock. */
  readonly deferralsSoFar: number;
}

export type GuardrailBlock =
  | "party-deleted"
  | "suppressed"
  | "opted-out"
  | "consent-expired"
  | "class-stopped"
  | "reply-arrived"
  | "deal-closed"
  | "frequency-cap"
  | "deferred-too-often";

export type GuardrailVerdict =
  | {
      readonly allow: true;
      readonly timezoneUsed: string;
      readonly timezoneSource: "party" | "tenant";
    }
  | { readonly allow: false; readonly action: "block"; readonly reason: GuardrailBlock }
  | {
      readonly allow: false;
      readonly action: "defer";
      readonly reason: "outside-working-hours";
      readonly notBefore: Date;
      readonly timezoneUsed: string;
      readonly timezoneSource: "party" | "tenant";
    };

/**
 * How often the system may write to one party, counting every loop together.
 *
 * The criterion is exact about why: four loops cannot each politely send one
 * message. A per-loop cap of one is four messages a week to somebody who did
 * not ask for any, and each loop would be able to show that it behaved.
 *
 * Two windows rather than one, because a single short window permits a
 * perfectly legal drip that never stops, and a single long one permits four in
 * an afternoon followed by silence.
 */
export const PARTY_FREQUENCY_CAPS: readonly { readonly windowDays: number; readonly max: number }[] =
  [
    { windowDays: 5, max: 1 },
    { windowDays: 30, max: 3 },
  ];

/**
 * How many times a message may be held back for the clock before it is dropped.
 *
 * One deferral covers a night or a weekend. Needing three means the window has
 * been closed for over a week, at which point the message is stale enough that
 * sending it is worse than not — the follow-up nobody sent is the ticket, but
 * the follow-up nobody sent for nine days is a different message.
 */
export const MAX_WORKING_HOUR_DEFERRALS = 2;

const DAY_MS = 86_400_000;

/**
 * Which clock the recipient is actually reading.
 *
 * The party's own where anybody recorded one and the runtime recognises it;
 * the tenant's otherwise. An unrecognised zone falls through to the tenant's
 * rather than to UTC, because a tenant's working day is a much better guess at
 * a customer's than midnight-to-midnight in Greenwich.
 */
export function resolveTimezone(facts: {
  readonly partyTimezone: string | null;
  readonly tenantTimezone: string;
}): { readonly timeZone: string; readonly source: "party" | "tenant" } {
  const party = facts.partyTimezone?.trim();
  if (party && isKnownTimeZone(party)) return { timeZone: party, source: "party" };
  return { timeZone: facts.tenantTimezone, source: "tenant" };
}

/** How many sends fall inside a rolling window ending now. */
export function sendsWithin(
  sends: readonly Date[],
  now: Date,
  windowDays: number,
): number {
  const floor = now.getTime() - windowDays * DAY_MS;
  return sends.filter((at) => at.getTime() > floor && at.getTime() <= now.getTime()).length;
}

export function exceedsFrequencyCap(sends: readonly Date[], now: Date): boolean {
  return PARTY_FREQUENCY_CAPS.some((cap) => sendsWithin(sends, now, cap.windowDays) >= cap.max);
}

/**
 * Whether this message may leave, right now.
 *
 * The order is the argument, and it runs from the checks that are about the
 * recipient's rights down to the ones that are about our manners. A message
 * that is both outside working hours and going to somebody who opted out is
 * reported as the opt-out — deferring it would schedule a send that must never
 * happen, and would report the wrong reason to the person reading the ledger.
 */
export function evaluateGuardrails(facts: SendTimeFacts): GuardrailVerdict {
  // Absolute, and checked first: every other reason below is about whether
  // this party should be written to; this one is about whether there is
  // still a party there to write to. A hold placed against a live party can
  // outlive that party, and nothing upstream of send time re-checks it.
  if (facts.partyDeleted) return { allow: false, action: "block", reason: "party-deleted" };

  // Absolute. A suppressed address is undeliverable as well as unwanted, and
  // continuing to send to one damages delivery for every other recipient.
  if (facts.suppressed) return { allow: false, action: "block", reason: "suppressed" };

  if (facts.consent === "OPTED_OUT")
    return { allow: false, action: "block", reason: "opted-out" };

  /**
   * An expired opt-in is not an opt-in. `<=` so a consent that runs out at the
   * exact instant of the send is expired: the alternative reading gives the
   * benefit of a rounding error to the party that did not ask to be mailed.
   */
  if (facts.consentExpiresAt && facts.consentExpiresAt.getTime() <= facts.now.getTime())
    return { allow: false, action: "block", reason: "consent-expired" };

  // Ticket 08's fourth criterion: a stop is about the class, not the instance.
  if (facts.classStopped) return { allow: false, action: "block", reason: "class-stopped" };

  /**
   * They answered while it was waiting.
   *
   * This is the case that makes send-time evaluation load-bearing rather than
   * tidy: at compose time the relationship was silent and the draft was right.
   * `>` rather than `>=` for the same reason as in `outbound-eligibility.ts` —
   * a message stored at the same millisecond as the draft is not a reply to it.
   */
  if (facts.repliedAt && facts.repliedAt.getTime() > facts.draftedAt.getTime())
    return { allow: false, action: "block", reason: "reply-arrived" };

  if (facts.dealState === "won" || facts.dealState === "lost")
    return { allow: false, action: "block", reason: "deal-closed" };

  if (exceedsFrequencyCap(facts.recentSendsToParty, facts.now))
    return { allow: false, action: "block", reason: "frequency-cap" };

  const { timeZone, source } = resolveTimezone(facts);
  const opening = nextOpening(facts.now, timeZone, OUTBOUND_WORKING_HOURS);

  if (opening.getTime() > facts.now.getTime()) {
    if (facts.deferralsSoFar >= MAX_WORKING_HOUR_DEFERRALS)
      return { allow: false, action: "block", reason: "deferred-too-often" };

    return {
      allow: false,
      action: "defer",
      reason: "outside-working-hours",
      notBefore: opening,
      timezoneUsed: timeZone,
      timezoneSource: source,
    };
  }

  return { allow: true, timezoneUsed: timeZone, timezoneSource: source };
}

/** What the ledger and the review feed say about a refusal. */
export function guardrailSummary(reason: GuardrailBlock): string {
  switch (reason) {
    case "party-deleted":
      return "The party this was addressed to was deleted while it was waiting.";
    case "suppressed":
      return "The address is on a suppression list; nothing was sent.";
    case "opted-out":
      return "They opted out of this channel before it left.";
    case "consent-expired":
      return "Consent to contact them on this channel had expired.";
    case "class-stopped":
      return "Somebody stopped this kind of message to this customer, pending review.";
    case "reply-arrived":
      return "They replied while it was waiting, so it was no longer the right message.";
    case "deal-closed":
      return "The deal closed while it was waiting.";
    case "frequency-cap":
      return "This customer has already had as much automated mail as the cap allows.";
    case "deferred-too-often":
      return "It waited too long for working hours to reopen and is now stale.";
  }
}
