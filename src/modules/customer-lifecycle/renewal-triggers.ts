import type {
  CustomerHealthBand,
  CustomerLifecycleStage,
} from "../../db/schema/crm/customer-lifecycle";
import { TERMINAL_LIFECYCLE_STAGES } from "../../db/schema/crm/customer-lifecycle";
import { daysUntil, toDateText, type CustomerLifecycleSignal } from "./lifecycle-record";

/**
 * When a renewal becomes something to work, and what that produces.
 *
 * Phase 6, ticket 09. The whole ticket is a refusal: a renewal is an opportunity
 * and the outbound loop already knows how to work one, so nothing here sends,
 * holds, or decides whether a message may leave. It decides that an opportunity
 * should exist. From that moment the existing machinery owns it —
 * `outbound-eligibility.ts` sees an open deal, `send-guardrails.ts` gates the
 * send at send time, `hold-window.ts` holds it, and every guardrail applies with
 * no exception written for retention. A second hold model would mean two answers
 * to "may this leave", and the one nobody remembered to update would be the one
 * that let something through.
 *
 * Pure, so the judgement can be argued with without a database and so a tenant's
 * lead time can be tested against their own history rather than observed in
 * production.
 */

export const RENEWAL_TRIGGER_KINDS = ["renewal.due", "churn.risk"] as const;
export type RenewalTriggerKind = (typeof RENEWAL_TRIGGER_KINDS)[number];

/**
 * One renewal this tenant has already been through, start to finish.
 *
 * The two dates are the opportunity's, not the contract's: what the lead time
 * has to cover is how long THIS tenant takes to get a renewal to a conclusion
 * once somebody starts on it.
 */
export interface CompletedRenewalCycle {
  readonly openedAt: Date;
  readonly closedAt: Date;
}

export interface RenewalLeadTime {
  readonly days: number;
  readonly source: "history" | "term-fallback";
  /** How many completed renewals the figure came out of. Zero for the fallback. */
  readonly sampleCount: number;
}

/**
 * How many completed renewals it takes before a tenant's own number means anything.
 *
 * Two renewals are two anecdotes, and a p90 over two samples is the slower of
 * the two with extra steps. Three is the smallest number where a slow outlier
 * does not become the entire rule.
 */
export const MIN_RENEWAL_HISTORY = 3;

/** Firing nearer than this leaves no room to have a conversation. */
const MIN_LEAD_TIME_DAYS = 14;
/**
 * Beyond this the opportunity sits in the pipeline distorting the forecast for
 * half a year before anybody can honestly work it.
 */
const MAX_LEAD_TIME_DAYS = 180;
/** The fallback's own ceiling — see `renewalLeadTime`. */
const FALLBACK_CEILING_DAYS = 90;

const DAY_MS = 86_400_000;
const DAYS_PER_MONTH = 30;

/**
 * How far ahead of a renewal date this tenant needs to start.
 *
 * Derived from the tenant's own completed renewals, not from a constant: a
 * business whose renewals close in a fortnight and one whose renewals go through
 * procurement for four months are both normal, and a platform-wide ninety days
 * is either a scramble or half a year of forecast noise depending on which one
 * you are. The ninetieth percentile rather than a mean, for the reason
 * `relationship_states` keeps percentiles rather than an average: a mean of "two
 * weeks, two weeks, four months" is a number that describes none of them, and a
 * lead time that only covers the typical case fires too late for exactly the
 * renewals that needed the most warning.
 *
 * **The fallback, stated rather than hidden.** Below `MIN_RENEWAL_HISTORY`
 * completed renewals there is no distribution to take a percentile of, and the
 * only fact every lifecycle carries is its term. A quarter of the term, floored
 * at a fortnight and capped at ninety days: a renewal conversation that opens in
 * the last tenth of a term is already late, and one that opens halfway through
 * is noise nobody will act on. It is a fallback and not the rule — the third
 * completed renewal replaces it with the tenant's own figure, and `source` says
 * which of the two produced the number so nobody has to guess.
 */
export function renewalLeadTime(
  history: readonly CompletedRenewalCycle[],
  termMonths: number,
): RenewalLeadTime {
  const durations = history
    .map((cycle) => (cycle.closedAt.getTime() - cycle.openedAt.getTime()) / DAY_MS)
    .filter((days) => Number.isFinite(days) && days >= 0)
    .sort((a, b) => a - b);

  if (durations.length < MIN_RENEWAL_HISTORY) {
    const quarterOfTerm = Math.round((termMonths * DAYS_PER_MONTH) / 4);
    return {
      days: Math.max(MIN_LEAD_TIME_DAYS, Math.min(FALLBACK_CEILING_DAYS, quarterOfTerm)),
      source: "term-fallback",
      sampleCount: 0,
    };
  }

  const index = Math.max(0, Math.ceil(durations.length * 0.9) - 1);
  const p90 = durations[index] ?? durations[durations.length - 1]!;

  return {
    days: Math.max(MIN_LEAD_TIME_DAYS, Math.min(MAX_LEAD_TIME_DAYS, Math.ceil(p90))),
    source: "history",
    sampleCount: durations.length,
  };
}

/** The last health reading, where there is one. */
export interface LifecycleHealth {
  readonly score: number;
  readonly band: CustomerHealthBand;
  readonly computedAt: Date;
}

export interface LifecycleForTrigger {
  readonly customerLifecycleId: string;
  readonly partyId: string;
  readonly customerName: string;
  readonly stage: CustomerLifecycleStage;
  readonly termMonths: number;
  readonly contractValueMinor: number;
  readonly currencyCode: string;
  /** `YYYY-MM-DD`, read as UTC midnight. */
  readonly renewalDate: string;
  /**
   * Whether an opportunity for this customer is already open in the pipeline.
   *
   * The single most important fact here. Without it a nightly sweep opens one
   * renewal deal per night for the same contract, and the tenant's forecast is
   * ruined by the feature meant to protect their revenue.
   */
  readonly hasOpenOpportunity: boolean;
  readonly latestHealth: LifecycleHealth | null;
}

/**
 * The opportunity a trigger asks for, as a value.
 *
 * Not a deal row: this file has no opinion about pipelines, stage keys or
 * identifiers, and handing the service a described intent keeps the judgement
 * testable without one.
 */
export interface OpportunityIntent {
  readonly name: string;
  readonly valueMinor: number;
  readonly currencyCode: string;
  /** `YYYY-MM-DD`. */
  readonly expectedCloseDate: string;
  readonly reason: string;
}

export interface RenewalTrigger {
  readonly kind: RenewalTriggerKind;
  readonly customerLifecycleId: string;
  readonly partyId: string;
  /** Where the lifecycle moves to when this is acted on. */
  readonly nextStage: CustomerLifecycleStage;
  readonly signal: CustomerLifecycleSignal;
  readonly opportunity: OpportunityIntent;
}

export interface EvaluateTriggersInput {
  readonly now: Date;
  readonly leadTime: RenewalLeadTime;
  readonly lifecycles: readonly LifecycleForTrigger[];
}

/**
 * Every trigger the current state of a tenant's contracts supports.
 *
 * At most one per lifecycle, and that is a rule rather than a convenience. A
 * customer who is both near renewal and in trouble is one conversation, and
 * opening two opportunities against one contract would double the forecast and
 * put two loops in front of the same person — the same failure
 * `PARTY_FREQUENCY_CAPS` exists to prevent one layer down. Renewal wins, because
 * a renewal has a date on it and a churn risk does not.
 */
export function evaluateRenewalTriggers(input: EvaluateTriggersInput): RenewalTrigger[] {
  const triggers: RenewalTrigger[] = [];

  for (const lifecycle of input.lifecycles) {
    if (TERMINAL_LIFECYCLE_STAGES.includes(lifecycle.stage)) continue;
    // Somebody is already on it. Whether that somebody is a person or the
    // outbound loop is not this file's business.
    if (lifecycle.hasOpenOpportunity) continue;

    const trigger =
      renewalDueTrigger(lifecycle, input) ?? churnRiskTrigger(lifecycle, input);
    if (trigger) triggers.push(trigger);
  }

  return triggers;
}

function renewalDueTrigger(
  lifecycle: LifecycleForTrigger,
  input: EvaluateTriggersInput,
): RenewalTrigger | null {
  if (lifecycle.stage === "renewal_open") return null;

  const days = daysUntil(lifecycle.renewalDate, input.now);
  if (days > input.leadTime.days) return null;

  const evidence: Readonly<Record<string, string | number | null>> = {
    renewalDate: lifecycle.renewalDate,
    daysToRenewal: days,
    leadTimeDays: input.leadTime.days,
    leadTimeSource: input.leadTime.source,
    leadTimeSampleCount: input.leadTime.sampleCount,
    termMonths: lifecycle.termMonths,
    contractValueMinor: lifecycle.contractValueMinor,
  };

  return {
    kind: "renewal.due",
    customerLifecycleId: lifecycle.customerLifecycleId,
    partyId: lifecycle.partyId,
    nextStage: "renewal_open",
    signal: {
      kind: "renewal.window-opened",
      evidence,
      /**
       * `instant`, and deliberately so. What this produces is a deal row, which
       * one write removes. Nothing has reached the customer — the message that
       * eventually does goes through the outbound loop's own hold, which is why
       * there is no hold here to reinvent.
       */
      reversibility: "instant",
      summary:
        days < 0
          ? `${lifecycle.customerName} renewed ${Math.abs(days)} days ago and nobody worked it`
          : `${lifecycle.customerName} renews in ${days} days, inside this tenant's ${input.leadTime.days}-day cycle`,
      observedAt: input.now,
    },
    opportunity: {
      name: `${lifecycle.customerName} — renewal`,
      valueMinor: lifecycle.contractValueMinor,
      currencyCode: lifecycle.currencyCode,
      expectedCloseDate: lifecycle.renewalDate,
      reason: `Renewal window opened ${input.leadTime.days} days out (${input.leadTime.source})`,
    },
  };
}

function churnRiskTrigger(
  lifecycle: LifecycleForTrigger,
  input: EvaluateTriggersInput,
): RenewalTrigger | null {
  const health = lifecycle.latestHealth;
  if (!health || health.band !== "critical") return null;
  if (lifecycle.stage === "at_risk") return null;

  /**
   * A save has to close before the tenant's own cycle runs out, or before the
   * contract does — whichever comes first. Reusing the derived lead time rather
   * than picking a second number keeps one answer to "how long does this tenant
   * need", which is the fact ticket 09's last criterion is about.
   */
  const byCycle = toDateText(new Date(input.now.getTime() + input.leadTime.days * DAY_MS));
  const expectedCloseDate =
    byCycle < lifecycle.renewalDate ? byCycle : lifecycle.renewalDate;

  const evidence: Readonly<Record<string, string | number | null>> = {
    healthScore: health.score,
    healthBand: health.band,
    healthComputedAt: health.computedAt.toISOString(),
    renewalDate: lifecycle.renewalDate,
    daysToRenewal: daysUntil(lifecycle.renewalDate, input.now),
    leadTimeDays: input.leadTime.days,
    leadTimeSource: input.leadTime.source,
    contractValueMinor: lifecycle.contractValueMinor,
  };

  return {
    kind: "churn.risk",
    customerLifecycleId: lifecycle.customerLifecycleId,
    partyId: lifecycle.partyId,
    nextStage: "at_risk",
    signal: {
      kind: "churn.risk-raised",
      evidence,
      reversibility: "instant",
      summary: `${lifecycle.customerName} scored ${health.score} — the contract is at risk before its renewal date`,
      observedAt: input.now,
    },
    opportunity: {
      name: `${lifecycle.customerName} — at risk`,
      valueMinor: lifecycle.contractValueMinor,
      currencyCode: lifecycle.currencyCode,
      expectedCloseDate,
      reason: `Health at ${health.score} (${health.band})`,
    },
  };
}
