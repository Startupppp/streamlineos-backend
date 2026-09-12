import type { HealthFactorKey } from "../../db/schema/crm/lifecycle";
import type { HealthFactor, HealthWindow } from "./health-score";
import { DEFAULT_HEALTH_WEIGHTS_BPS } from "./health-score";

/**
 * How each of the four inputs turns raw observations into a 0..100 value.
 *
 * Pure, and separate from `health.service.ts`, because the service's job is to
 * count rows and this file's job is to decide what the counts mean. Mixing them
 * is how a scoring rule ends up only reachable through a query and therefore
 * only testable with a database.
 *
 * The rule that shapes all four is about ABSENCE, and it is the substance here:
 *
 *   Absence is evidence only where absence is observable.
 *
 * If an organisation logs its customer conversations, then a customer with no
 * conversation logged in six months is a measured fact — silence — and scores
 * badly. If the organisation logs nothing at all, the same emptiness says
 * nothing about the customer and reporting it as silence would put every
 * customer of a tenant that has not adopted the timeline into the critical band
 * on their first day.
 *
 * So `engagement` and `support` treat an empty result as a measurement, PROVIDED
 * the organisation demonstrably uses that source; `usage` and `sentiment` never
 * do, because nothing here observes a customer using the product and nobody is
 * surveyed by default — for those two, no observation means no observation.
 * Every one of the four reports which of those cases it is in.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The windows. Deliberately different, and the difference is the argument:
 * tickets and survey responses are sparse enough that a quarter of them is
 * usually nothing, while a quarter of silence on the timeline is already the
 * answer. One shared window would either make the sparse inputs permanently
 * missing or make the dense ones permanently forgiving.
 */
export const HEALTH_WINDOW_DAYS: Readonly<Record<HealthFactorKey, number>> = {
  usage: 90,
  engagement: 90,
  support: 180,
  sentiment: 180,
};

export function healthWindow(days: number, asOf: Date): HealthWindow {
  return { days, from: new Date(asOf.getTime() - days * MS_PER_DAY), to: asOf };
}

function clampValue(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

// ── Engagement ──────────────────────────────────────────────────────────────

/** Contact this recent is as good as contact gets; there is no bonus above it. */
export const FRESH_CONTACT_DAYS = 7;
/** What "in touch" means as a cadence. Two touches a month, on distinct days. */
export const EXPECTED_CONTACT_DAYS_PER_MONTH = 2;

export interface EngagementObservations {
  /** Does this organisation anchor any activity to any party at all. */
  readonly sourceInUse: boolean;
  /** Activities for this party inside the window. */
  readonly activityCount: number;
  /**
   * Distinct DAYS with activity, not activities. An import of a mail thread
   * writes forty rows in one second, and counting rows would score that as forty
   * times the engagement of a phone call — the shape of contact that actually
   * predicts a renewal is recurrence, not volume.
   */
  readonly contactDays: number;
  /** The most recent activity EVER, which may predate the window. */
  readonly lastActivityAt: Date | null;
}

/**
 * Recency and cadence, weighted equally.
 *
 * Two halves because either alone is wrong in a way people recognise: a customer
 * spoken to daily for a month and then not for three is not engaged, and a
 * customer emailed once yesterday is not either. Together they say "somebody is
 * in regular contact and it has not stopped".
 */
export function engagementFactor(
  observations: EngagementObservations,
  window: HealthWindow,
  weightBps: number = DEFAULT_HEALTH_WEIGHTS_BPS.engagement,
): HealthFactor {
  const base = { key: "engagement" as const, weightBps, window };

  if (!observations.sourceInUse) {
    return {
      ...base,
      status: "missing",
      reason: "no-source",
      detail: { activityCount: 0, contactDays: 0 },
    };
  }

  const daysSinceLastActivity =
    observations.lastActivityAt === null
      ? null
      : Math.max(
          0,
          Math.floor(
            (window.to.getTime() - observations.lastActivityAt.getTime()) / MS_PER_DAY,
          ),
        );

  const recency = (() => {
    if (daysSinceLastActivity === null) return 0;
    if (daysSinceLastActivity <= FRESH_CONTACT_DAYS) return 100;
    if (daysSinceLastActivity >= window.days) return 0;
    return clampValue(
      100 *
        (1 -
          (daysSinceLastActivity - FRESH_CONTACT_DAYS) /
            (window.days - FRESH_CONTACT_DAYS)),
    );
  })();

  const expectedContactDays = Math.max(
    1,
    Math.round((window.days / 30) * EXPECTED_CONTACT_DAYS_PER_MONTH),
  );
  const cadence = clampValue((observations.contactDays / expectedContactDays) * 100);

  return {
    ...base,
    status: "measured",
    value: clampValue((recency + cadence) / 2),
    observations: observations.activityCount,
    detail: {
      activityCount: observations.activityCount,
      contactDays: observations.contactDays,
      expectedContactDays,
      daysSinceLastActivity,
      recencyValue: recency,
      cadenceValue: cadence,
    },
  };
}

// ── Support ─────────────────────────────────────────────────────────────────

/**
 * Penalties, each capped on its own.
 *
 * Capped separately rather than as one total because the caps are what stop a
 * single dimension from owning the input: a customer who files twenty routine
 * tickets is a heavy user, not a leaving one, and without the volume cap they
 * would outrank a customer with one unresolved breach of an urgent SLA. The
 * order of the caps is the claim — a breached commitment is worth more than
 * volume, and volume is worth the least.
 */
export const TICKET_VOLUME_PENALTY = 6;
export const TICKET_VOLUME_PENALTY_CAP = 30;
export const URGENT_TICKET_PENALTY = 15;
export const URGENT_TICKET_PENALTY_CAP = 45;
export const SLA_BREACH_PENALTY = 12;
export const SLA_BREACH_PENALTY_CAP = 48;

export interface SupportObservations {
  /** Does this organisation anchor any ticket to any party at all. */
  readonly sourceInUse: boolean;
  /** Tickets opened for this party inside the window. */
  readonly opened: number;
  /** Of those, the ones raised HIGH or URGENT. */
  readonly urgent: number;
  /** Of those, the ones whose SLA deadline passed unresolved. */
  readonly slaBreached: number;
  /** Still open now, whenever they were raised. */
  readonly openNow: number;
}

/**
 * Starts at 100 and subtracts. A customer with no service failures has had no
 * service failures — which, in an organisation that demonstrably records them,
 * is a measurement and a good one, not an absence.
 */
export function supportFactor(
  observations: SupportObservations,
  window: HealthWindow,
  weightBps: number = DEFAULT_HEALTH_WEIGHTS_BPS.support,
): HealthFactor {
  const base = { key: "support" as const, weightBps, window };

  if (!observations.sourceInUse) {
    return {
      ...base,
      status: "missing",
      reason: "no-source",
      detail: { opened: 0, urgent: 0, slaBreached: 0, openNow: 0 },
    };
  }

  const volumePenalty = Math.min(
    observations.opened * TICKET_VOLUME_PENALTY,
    TICKET_VOLUME_PENALTY_CAP,
  );
  const urgentPenalty = Math.min(
    observations.urgent * URGENT_TICKET_PENALTY,
    URGENT_TICKET_PENALTY_CAP,
  );
  const breachPenalty = Math.min(
    observations.slaBreached * SLA_BREACH_PENALTY,
    SLA_BREACH_PENALTY_CAP,
  );

  return {
    ...base,
    status: "measured",
    value: clampValue(100 - volumePenalty - urgentPenalty - breachPenalty),
    observations: observations.opened,
    detail: {
      opened: observations.opened,
      urgent: observations.urgent,
      slaBreached: observations.slaBreached,
      openNow: observations.openNow,
      volumePenalty,
      urgentPenalty,
      breachPenalty,
    },
  };
}

// ── Sentiment ───────────────────────────────────────────────────────────────

/**
 * What each verdict is worth. Neutral is the midpoint and NOT the value a
 * missing verdict gets — those are the two things this module refuses to
 * conflate, and giving them the same number is exactly how the existing scorer
 * conflates them.
 */
export const SENTIMENT_VALUE = { positive: 100, neutral: 50, negative: 0 } as const;

export interface SentimentObservations {
  /** Has this organisation ever had a conversation analysed for sentiment. */
  readonly sourceInUse: boolean;
  readonly positive: number;
  readonly neutral: number;
  readonly negative: number;
  /** Whether anything was ever observed for this customer, window aside. */
  readonly observedEver: boolean;
}

/**
 * The mean verdict over the window.
 *
 * Unweighted by recency on purpose: a sentiment read is already an event with a
 * date, the window is the memory, and a second decay inside it would be two
 * parameters doing one job — the mistake `lifecycle-risk.ts` avoids by putting
 * its decay in one place and nowhere else.
 *
 * Nothing in the window is never scored. A customer who was cheerful eight
 * months ago and has said nothing since is not currently cheerful; that is
 * `stale`, and it is a third fact distinct from "never asked" and from "said
 * something neutral".
 */
export function sentimentFactor(
  observations: SentimentObservations,
  window: HealthWindow,
  weightBps: number = DEFAULT_HEALTH_WEIGHTS_BPS.sentiment,
): HealthFactor {
  const base = { key: "sentiment" as const, weightBps, window };
  const detail = {
    positive: observations.positive,
    neutral: observations.neutral,
    negative: observations.negative,
  };

  if (!observations.sourceInUse) {
    return { ...base, status: "missing", reason: "no-source", detail };
  }

  const total = observations.positive + observations.neutral + observations.negative;
  if (total === 0) {
    return {
      ...base,
      status: "missing",
      reason: observations.observedEver ? "stale" : "no-observations",
      detail,
    };
  }

  const points =
    observations.positive * SENTIMENT_VALUE.positive +
    observations.neutral * SENTIMENT_VALUE.neutral +
    observations.negative * SENTIMENT_VALUE.negative;

  return {
    ...base,
    status: "measured",
    value: clampValue(points / total),
    observations: total,
    detail,
  };
}

// ── Usage ───────────────────────────────────────────────────────────────────

export interface UsageObservations {
  /** Has this organisation ever filed a usage observation for anybody. */
  readonly sourceInUse: boolean;
  /** Usage observations for this customer inside the window. */
  readonly observationCount: number;
  /**
   * The summed decline those observations stated, in the signal impact scale.
   * Positive is a fall; the producer says how far.
   */
  readonly declineImpact: number;
  /** Whether anything was ever observed for this customer, window aside. */
  readonly observedEver: boolean;
}

/**
 * The weakest of the four, and worth being plain about why.
 *
 * This platform holds NO product telemetry. Nothing in the schema records a
 * customer opening anything — `portal_memberships` has no last-seen column,
 * `ai_usage_logs` is the tenant's own spend, and `activities` is what our staff
 * did, not what the customer did. The only per-customer usage fact the system
 * holds is a `usage-decline` lifecycle signal, which a human or an integration
 * files when they notice a fall.
 *
 * That has a consequence worth stating rather than papering over: the usage
 * input is either "a decline was observed" or "unmeasured", and it can never
 * report that usage is fine. Scoring an unobserved customer 100 would be the
 * opposite of the truth — it would make every customer nobody is watching look
 * excellent, which is the exact population this feature exists to surface. So
 * unobserved is `missing`, it costs the score its largest weight, and the
 * coverage number says so out loud.
 */
export function usageFactor(
  observations: UsageObservations,
  window: HealthWindow,
  weightBps: number = DEFAULT_HEALTH_WEIGHTS_BPS.usage,
): HealthFactor {
  const base = { key: "usage" as const, weightBps, window };
  const detail = {
    observationCount: observations.observationCount,
    declineImpact: observations.declineImpact,
  };

  if (!observations.sourceInUse) {
    return { ...base, status: "missing", reason: "no-source", detail };
  }

  if (observations.observationCount === 0) {
    return {
      ...base,
      status: "missing",
      reason: observations.observedEver ? "stale" : "no-observations",
      detail,
    };
  }

  return {
    ...base,
    status: "measured",
    value: clampValue(100 - observations.declineImpact),
    observations: observations.observationCount,
    detail,
  };
}
