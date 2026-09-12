import type { LifecycleSignalKind } from "../../db/schema/crm/lifecycle";
import { calendarDateOf, daysBetween, parseIsoDate } from "./lifecycle-terms";

/**
 * How much of a customer's recurring revenue is in doubt, as one number.
 *
 * Pure, and separate from the service, because this is the only part of the
 * feature that is a judgement rather than a fact. The term, the value and the
 * renewal date are recorded; the score is inferred, and an inference that cannot
 * be exercised at its boundaries without a database is an inference nobody will
 * revise when it turns out to be wrong.
 *
 * Three rules, and they are the argument:
 *
 * Evidence decays. An escalation in March says nothing about a renewal in
 * December, and a score that never forgets is one that saturates at 100 for
 * every customer who has ever had a bad week — at which point it ranks nothing.
 *
 * Evidence goes both ways. A signed expansion is evidence against churn, and a
 * model that can only accumulate harm has no way to represent a customer who
 * recovered.
 *
 * Proximity is not evidence, but it is urgency. Two customers with identical
 * signals, one renewing next week and one next year, are not the same call to
 * make today. The proximity term is bounded well below the signal terms so it
 * can order a quiet book without ever manufacturing an alarm on its own.
 */

/** Beyond this a signal contributes nothing. One quarter — a renewal cycle's memory. */
export const SIGNAL_WINDOW_DAYS = 90;

/** How close a renewal has to be before it adds pressure of its own. */
export const RENEWAL_PRESSURE_WINDOW_DAYS = 60;

/** The most the calendar alone may contribute. Deliberately small; see above. */
export const MAX_RENEWAL_PRESSURE = 15;

/**
 * A renewal date that has passed while the lifecycle is still `active` is not
 * proximity — it is a term nobody renewed and nobody closed, which is either
 * lost revenue or a book nobody is maintaining. Both are worth the top of the
 * calendar's range rather than a fraction of it.
 */
export const OVERDUE_RENEWAL_PRESSURE = 25;

/**
 * What each kind of evidence is worth when it is fresh.
 *
 * Signed: positive is pressure toward churn, negative is evidence against it.
 * These are defaults for a caller that states no impact of its own — the stored
 * `impact` column is what the score actually reads, so re-tuning this table
 * never rewrites the history of a customer nothing happened to.
 *
 * The relative ordering is the substance. A departed champion outweighs a single
 * overdue invoice because one is a change in who decides and the other is
 * usually an accounts-payable calendar.
 */
export const DEFAULT_SIGNAL_IMPACT: Record<LifecycleSignalKind, number> = {
  "champion-departed": 35,
  "usage-decline": 30,
  "support-escalation": 25,
  "relationship-silence": 20,
  "detractor-response": 20,
  "invoice-overdue": 15,
  "expansion-interest": -20,
  "renewal-commitment": -40,
  /** A note carries only what the person filing it said it carries. */
  note: 0,
};

/** The bound the column's CHECK also enforces. Stated once, used both sides. */
export const MIN_SIGNAL_IMPACT = -100;
export const MAX_SIGNAL_IMPACT = 100;

export interface RiskSignal {
  readonly impact: number;
  readonly observedAt: Date;
}

export interface RiskInput {
  readonly signals: readonly RiskSignal[];
  /** The lifecycle's renewal date, as stored. */
  readonly renewalOn: string;
  readonly status: string;
  readonly asOf: Date;
}

/**
 * Linear decay to zero over the window.
 *
 * Linear rather than exponential on purpose: a half-life is a second parameter
 * to argue about and produces a tail that never quite reaches zero, so a signal
 * from two years ago still nudges the ordering. A signal outside the window
 * should contribute exactly nothing, and linear says so.
 *
 * A signal observed in the future weighs full — clock skew and a rep filing a
 * renewal date they have already agreed both produce one, and discounting it
 * would silently drop the most recent evidence there is.
 */
export function decayFactor(ageDays: number): number {
  if (ageDays <= 0) return 1;
  if (ageDays >= SIGNAL_WINDOW_DAYS) return 0;
  return 1 - ageDays / SIGNAL_WINDOW_DAYS;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The calendar's contribution.
 *
 * Zero for anything that is not `active`: a renewed or churned term has no
 * renewal to be close to, and letting a closed row accumulate pressure would put
 * dead revenue at the top of the at-risk list forever.
 */
export function renewalPressure(renewalOn: string, status: string, asOf: Date): number {
  if (status !== "active") return 0;

  const renewal = parseIsoDate(renewalOn);
  if (!renewal) return 0;

  const daysAway = daysBetween(calendarDateOf(asOf), renewal);
  if (daysAway < 0) return OVERDUE_RENEWAL_PRESSURE;
  if (daysAway >= RENEWAL_PRESSURE_WINDOW_DAYS) return 0;

  return Math.round(
    MAX_RENEWAL_PRESSURE * (1 - daysAway / RENEWAL_PRESSURE_WINDOW_DAYS),
  );
}

/**
 * 0..100. Clamped at both ends, so a customer with a wall of good news scores
 * zero rather than a negative number no column may hold and no list may sort.
 */
export function riskScore(input: RiskInput): number {
  const evidence = input.signals.reduce((total, signal) => {
    const ageDays = (input.asOf.getTime() - signal.observedAt.getTime()) / MS_PER_DAY;
    return total + signal.impact * decayFactor(ageDays);
  }, 0);

  const raw = evidence + renewalPressure(input.renewalOn, input.status, input.asOf);
  return Math.min(100, Math.max(0, Math.round(raw)));
}

/**
 * The bands the list filters on and a screen colours by.
 *
 * Named rather than left to the caller, because "at risk" appearing in a
 * controller with one threshold and in a digest with another is how two surfaces
 * come to disagree about the same customer.
 */
export const RISK_BANDS = ["healthy", "watch", "at-risk"] as const;
export type RiskBand = (typeof RISK_BANDS)[number];

export const WATCH_THRESHOLD = 30;
export const AT_RISK_THRESHOLD = 60;

export function riskBand(score: number): RiskBand {
  if (score >= AT_RISK_THRESHOLD) return "at-risk";
  if (score >= WATCH_THRESHOLD) return "watch";
  return "healthy";
}

/** Clamps a stated impact into the range the column accepts. */
export function clampImpact(impact: number): number {
  return Math.min(MAX_SIGNAL_IMPACT, Math.max(MIN_SIGNAL_IMPACT, Math.round(impact)));
}

/** The impact a signal carries when the caller states none. */
export function impactFor(kind: LifecycleSignalKind, stated: number | null | undefined): number {
  if (typeof stated === "number" && Number.isFinite(stated)) return clampImpact(stated);
  return DEFAULT_SIGNAL_IMPACT[kind] ?? 0;
}
