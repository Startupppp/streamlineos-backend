import type { LifecycleTriggerKind } from "../../db/schema/crm/lifecycle";
import { AT_RISK_THRESHOLD as RISK_AT_RISK_THRESHOLD } from "./lifecycle-risk";
import {
  addDays,
  calendarDateOf,
  daysBetween,
  formatIsoDate,
  parseIsoDate,
  type CalendarDate,
} from "./lifecycle-terms";

/**
 * When a renewal conversation should open, and why.
 *
 * Pure, and it is the whole of the judgement in this ticket. Everything else in
 * the feature is traffic: reading the book, opening an opportunity, handing that
 * opportunity to the outbound loop that already exists. What can be argued with
 * is only this — how early a renewal is worth opening, what counts as evidence
 * that waiting for the calendar is a mistake, and how long a loop that declined
 * should be left alone before it is asked again.
 *
 * There is deliberately nothing here about drafting, holding, sending or
 * guardrails. A retention feature that grows its own sender ends up with two
 * machines that disagree about whether a customer may be written to, and the
 * newer one is always the one without the working-hours check. This file decides
 * WHEN; `OutboundService.composeAndHold` decides everything after that, exactly
 * as it does for a message a person triggered.
 */

/**
 * How far ahead of the renewal date the conversation opens. One quarter.
 *
 * Long enough that a customer who needs a procurement cycle has one, short
 * enough that the message is about something the recipient recognises as
 * imminent. It is also the same 90 days `SIGNAL_WINDOW_DAYS` uses, which is not
 * a coincidence worth removing: the evidence that decides whether the renewal is
 * safe is exactly the evidence that is still live when the conversation opens.
 */
export const RENEWAL_LEAD_DAYS = 90;

/**
 * How long a declined trigger is left alone before the loop is asked again.
 *
 * The loop's refusals expire — "they replied", "the ball is ours", "the system
 * wrote to them four days ago" are all statements about a moment — so a trigger
 * it refused is re-offered rather than abandoned. Two days, because the reasons
 * that clear fastest clear in about a day and a sweep that re-offers daily pays
 * a provider for a draft every morning on every customer whose relationship has
 * not moved.
 */
export const TRIGGER_RETRY_DAYS = 2;

/**
 * How many times a trigger may be offered before it becomes a person's problem.
 *
 * A loop that has declined six times over at least a fortnight is not going to
 * change its mind on the seventh: the refusals it repeats — no reachable
 * address, the ball is ours, nothing to say — are ones only a human can clear.
 * Standing down leaves the row with the last refusal on it, which is the thing
 * somebody actually needs to read; retrying forever would bury that under a
 * thousand identical rows and keep paying for drafts nobody may send.
 */
export const MAX_TRIGGER_ATTEMPTS = 6;

/**
 * The health band that overrules the calendar.
 *
 * `critical` only, not `at_risk`. The health model reports `at_risk` from a
 * score of 40, which on a four-input model with two inputs missing is a common
 * resting state rather than an alarm — opening every such customer's renewal a
 * quarter early would make the early path the ordinary path and the lead window
 * meaningless. `critical` is the band that says the revenue is going.
 */
export const CHURN_TRIGGER_HEALTH_BAND = "critical";

/** What the sweep is given about one contract. Values, so this stays testable. */
export interface TriggerCandidate {
  readonly status: string;
  /** The lifecycle's renewal date, as stored (YYYY-MM-DD). */
  readonly renewalOn: string;
  /** The term this candidate is in, and the trigger's idempotency key. */
  readonly termStartedOn: string;
  /** 0..100, from `customer_lifecycles.risk_score`. */
  readonly riskScore: number;
  /** `crm_health`'s vocabulary, or null for "the model could not say". */
  readonly healthStatus: string | null;
  /** The newest signal on the lifecycle, which is when the evidence arrived. */
  readonly lastSignalAt: Date | null;
  /** The trigger already on this term, if a previous sweep opened one. */
  readonly existing: ExistingTrigger | null;
  readonly asOf: Date;
}

export interface ExistingTrigger {
  /** Whether the renewal opportunity was actually opened. */
  readonly hasOpportunity: boolean;
  readonly attempts: number;
  readonly lastAttemptAt: Date | null;
  /**
   * Whether the loop placed a hold. Once it has, the message exists and its
   * window is running — the trigger's job is done and re-offering would only
   * collide with `uniq_autonomy_holds_live_outbound` after paying for a draft.
   */
  readonly holdPlaced: boolean;
}

export type TriggerStandDown =
  /** The contract ended. Nothing to renew, and a closed term must not be chased. */
  | "term-closed"
  /** The stored renewal date does not parse. Reported, never guessed at. */
  | "unusable-term"
  /** Neither the calendar nor the evidence says now. */
  | "not-due"
  /** The loop is already working it: a message is drafted and waiting. */
  | "already-working"
  | "too-soon-to-reoffer"
  | "attempts-exhausted";

export type TriggerDecision =
  /** Open the renewal opportunity, then hand it to the loop. */
  | {
      readonly action: "open";
      readonly kind: LifecycleTriggerKind;
      /** The day the conversation became due; written onto the opportunity. */
      readonly dueOn: string;
    }
  /** The conversation is already open. Ask the loop again. */
  | { readonly action: "reoffer" }
  | { readonly action: "stand-down"; readonly reason: TriggerStandDown };

/**
 * The order below is the argument.
 *
 * An existing trigger is resolved BEFORE any freshness question, because the
 * calendar reason that opened it is still true on every subsequent sweep — a
 * renewal inside its lead window stays inside it — so asking "is it due" first
 * would re-answer yes forever and the idempotency would have to live in the
 * caller. It lives here, where it can be tested without a database.
 */
export function decideTrigger(candidate: TriggerCandidate): TriggerDecision {
  if (candidate.status !== "active") return standDown("term-closed");

  const renewal = parseIsoDate(candidate.renewalOn);
  if (!renewal) return standDown("unusable-term");

  const existing = candidate.existing;
  if (existing) {
    if (existing.holdPlaced) return standDown("already-working");
    if (existing.attempts >= MAX_TRIGGER_ATTEMPTS) return standDown("attempts-exhausted");
    if (
      existing.lastAttemptAt &&
      elapsedDays(existing.lastAttemptAt, candidate.asOf) < TRIGGER_RETRY_DAYS
    )
      return standDown("too-soon-to-reoffer");

    return { action: "reoffer" };
  }

  const today = calendarDateOf(candidate.asOf);

  /**
   * `<=` and no lower bound, so a renewal that has already passed still opens
   * the conversation rather than falling out of the window.
   *
   * A term whose renewal date went by while the lifecycle stayed `active` is the
   * single most urgent row in the book — it is either revenue nobody renewed or
   * a book nobody maintains — and `renewalPressure` already treats it as the top
   * of its range. A window with a floor would silently exclude exactly those.
   */
  if (daysBetween(today, renewal) <= RENEWAL_LEAD_DAYS)
    return {
      action: "open",
      kind: "renewal-due",
      /**
       * The day the lead window opened, not today. For a renewal already inside
       * its window that date is in the past by however long the window has been
       * open, which is what makes the loop's `next-step-overdue` branch read a
       * renewal ignored for a month as a month overdue.
       *
       * Clamped to the start of the term, because the lead window is longer than
       * the shortest term this book allows: a one-month contract renews 30 days
       * after it starts, and `renewal - 90` would date the conversation two
       * months before the customer bought anything. That is also what
       * `chk_customer_lifecycle_triggers_dates` refuses, so the clamp is the
       * difference between a short term opening a renewal and a short term
       * throwing a constraint violation on every sweep.
       */
      dueOn: notBeforeTerm(addDays(renewal, -RENEWAL_LEAD_DAYS), candidate.termStartedOn),
    };

  if (isChurnEvidence(candidate))
    return {
      action: "open",
      kind: "churn-risk",
      /**
       * The day the evidence arrived, which is when this conversation actually
       * became due — not the day a sweep happened to notice. Falls back to today
       * only when there is no dated signal behind the score, and is clamped
       * forward to the start of the term because a due date predating the
       * contract is not a fact about this term.
       */
      dueOn: evidenceDate(candidate, today),
    };

  return standDown("not-due");
}

/**
 * Evidence that waiting for the calendar would be a mistake.
 *
 * Two sources, either sufficient, and they answer different questions. The
 * lifecycle risk score is built from what happened to this contract —
 * escalations, overdue invoices, a departed champion. The health band is built
 * from how the customer is using and experiencing the product. A customer can be
 * critical on one and quiet on the other, and requiring both would mean the
 * trigger only fires when the situation is already unarguable.
 */
export function isChurnEvidence(candidate: {
  readonly riskScore: number;
  readonly healthStatus: string | null;
}): boolean {
  if (candidate.riskScore >= RISK_AT_RISK_THRESHOLD) return true;
  return candidate.healthStatus === CHURN_TRIGGER_HEALTH_BAND;
}

function evidenceDate(candidate: TriggerCandidate, today: CalendarDate): string {
  const observed = candidate.lastSignalAt ? calendarDateOf(candidate.lastSignalAt) : today;
  /**
   * A signal dated in the future — clock skew, or a rep filing something they
   * have already agreed — must not date the conversation into the future, where
   * the loop's own grace period would never reach it.
   */
  const dated = daysBetween(observed, today) < 0 ? today : observed;

  return notBeforeTerm(dated, candidate.termStartedOn);
}

/**
 * A due date never predates the term it belongs to.
 *
 * The same clamp both kinds need, in one place: a conversation about this term
 * cannot have become due before this term existed, and the column's CHECK says
 * so too. An unparseable `term_started_on` leaves the date alone rather than
 * guessing — the row would fail its own foreign key long before this matters.
 */
function notBeforeTerm(date: CalendarDate, termStartedOn: string): string {
  const termStart = parseIsoDate(termStartedOn);
  if (termStart && daysBetween(termStart, date) < 0) return formatIsoDate(termStart);
  return formatIsoDate(date);
}

function standDown(reason: TriggerStandDown): TriggerDecision {
  return { action: "stand-down", reason };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole days between two instants, floored, never negative. */
function elapsedDays(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY));
}

/* ────────────────────────────────────────────────────────────────────────────
 * What the opportunity says.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Caps matching the columns and the prompt, so neither truncates silently.
 *
 * `agreedNextStep` is capped at 200 characters before it reaches the model
 * (`AGREED_NEXT_STEP_CHARS` in `outbound.service.ts`); building a longer one
 * here would mean the sentence the model reads ends mid-word.
 */
const NEXT_STEP_CHARS = 200;
const DEAL_NAME_CHARS = 120;

/**
 * The opportunity's name, as it appears in the pipeline a person works.
 *
 * It says "Renewal" first because the row lands in a rep's deal list beside
 * ordinary new business, and a renewal that reads as a new opportunity distorts
 * every forecast that counts open pipeline.
 */
export function renewalOpportunityName(customerName: string, renewalOn: string): string {
  const who = customerName.trim() || "Customer";
  return cap(`Renewal — ${who} (${renewalOn})`, DEAL_NAME_CHARS);
}

/**
 * The next step written onto the opportunity, which is the sentence the drafting
 * model is told was agreed.
 *
 * Two forms, because the two triggers are asking for different conversations. A
 * scheduled renewal asks whether they are continuing. A renewal opened early
 * because the evidence is bad asks the same question with the reason attached,
 * so the draft is about the relationship rather than the paperwork.
 *
 * It never states the contract value. The recipient's own price is not something
 * an autonomously drafted message should quote — the model paraphrases, and a
 * paraphrased number in a renewal mail is a commercial error nobody can recall.
 */
export function renewalNextStep(kind: LifecycleTriggerKind, renewalOn: string): string {
  const sentence =
    kind === "churn-risk"
      ? `Open the renewal conversation early: this account is showing churn risk ahead of its ${renewalOn} renewal. Confirm they are continuing and surface anything that is not working.`
      : `Confirm whether they are renewing on ${renewalOn}, and agree the next step for it.`;

  return cap(sentence, NEXT_STEP_CHARS);
}

function cap(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}
