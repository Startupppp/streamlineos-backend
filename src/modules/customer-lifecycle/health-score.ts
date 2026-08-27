import type {
  CustomerHealthBand,
  HealthBasis,
  HealthContribution,
  HealthInput,
} from "../../db/schema/crm/customer-lifecycle";
import { HEALTH_INPUTS } from "../../db/schema/crm/customer-lifecycle";
import type {
  HealthScoreThresholds,
  HealthScoreWeights,
} from "../../db/schema/crm/customer-success";
import type { CustomerLifecycleSignal } from "./lifecycle-record";

/**
 * Customer health as a decomposition, not a number.
 *
 * Phase 6, ticket 08. This is the rewrite of `cs-health.service.ts`'s arithmetic
 * and it absorbs it rather than sitting beside it: the service still owns the
 * database reads and the tenant's stored weights, and every rule it used to
 * apply inline now lives here where it can be argued with. There is one health
 * computation on the platform, and this is it.
 *
 * Two properties are the ticket.
 *
 * **A score carries its inputs and their weights.** `contributions` is the same
 * idea as a commission entry's `basisMinor`/`rateBps`/`splitBps`: the stored
 * thing is what went in, and the number is derived from it. A composite that
 * cannot be taken apart is a number nobody can interrogate, and the reason
 * commission stores its working is the reason this does.
 *
 * **An absent input is absent, never zero.** The service this replaces scored a
 * missing input at a neutral fifty, so a tenant with no CSAT survey and no
 * support desk got a fabricated fifty on two fifths of their score and nobody
 * could see which two fifths. The rule here is that the composite is a weighted
 * mean over the inputs that HAVE data, and `coverageBps` says how much of the
 * declared model that was. A tenant supplying no usage data therefore gets a
 * score computed from what exists, labelled as such, by construction rather than
 * by a special case.
 *
 * Everything is in basis points until the last step. Each input scores 0..10000
 * and the composite is rounded once, over the whole weighted set — the same rule
 * `payoutMinor` follows, and for the same reason: rounding each input to a
 * hundredth first loses a point somewhere nobody can reconstruct.
 */

/** The basis-point unit `commission-accrual.ts` works in, stated again here. */
const BPS = 10_000;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * The platform's opinion about what health is made of, before a tenant edits it.
 *
 * Usage and support carry the most because they are the two that predict a
 * renewal rather than describe one: a customer who has stopped using the product
 * leaves whatever their last survey said, and a customer whose tickets go
 * unanswered leaves whatever their usage says. Sentiment carries least of the
 * four, because it is the only input produced by a model.
 */
export const DEFAULT_HEALTH_WEIGHTS_BPS: Readonly<Record<HealthInput, number>> = {
  usage: 2_500,
  engagement: 2_000,
  support: 2_500,
  sentiment: 1_500,
  renewal: 1_500,
};

/**
 * The share usage takes when a tenant's stored configuration predates it.
 *
 * `health_score_config` was written before usage was an input, so a tenant's
 * saved weights say nothing about it. Ignoring that and giving usage nothing
 * would mean a tenant who wires up telemetry sees it counted at zero forever;
 * rescaling their four numbers to leave room for it keeps their RATIOS exactly
 * as they set them, which is the part they actually chose. And when they supply
 * no usage at all, the renormalisation over available inputs puts their four
 * back at their original proportions — so the legacy configuration keeps working
 * unchanged for every tenant who never adopts usage.
 */
const USAGE_SHARE_BPS = DEFAULT_HEALTH_WEIGHTS_BPS.usage;
const LEGACY_SHARE_BPS = BPS - USAGE_SHARE_BPS;

/**
 * The stored five-weight configuration, read as this model's four.
 *
 * `sla` and `tickets` were two views of the same fact — how a customer's support
 * requests went — and are added rather than kept apart, because splitting one
 * input in two is how a tenant who cares about support ends up weighting it
 * twice by accident. `csat` becomes sentiment: both are "what did they say", and
 * the sentiment input is the wider reading of it.
 *
 * The scaled weights need not total exactly `LEGACY_SHARE_BPS` — rounding four
 * numbers loses a basis point or two — and it does not matter, because the
 * composite divides by the sum of the weights it actually used. Only the ratios
 * decide anything.
 */
export function healthWeightsFromConfig(
  config: HealthScoreWeights | null | undefined,
): Readonly<Record<HealthInput, number>> {
  if (!config) return DEFAULT_HEALTH_WEIGHTS_BPS;

  const mapped = {
    support: Math.max(0, config.sla) + Math.max(0, config.tickets),
    sentiment: Math.max(0, config.csat),
    engagement: Math.max(0, config.activity),
    renewal: Math.max(0, config.renewal),
  };
  const total = mapped.support + mapped.sentiment + mapped.engagement + mapped.renewal;

  // A configuration that weights nothing is not a configuration. Falling back to
  // the platform's beats dividing by zero and beats scoring everyone the same.
  if (total <= 0) return DEFAULT_HEALTH_WEIGHTS_BPS;

  const scale = (raw: number): number => Math.round((raw * LEGACY_SHARE_BPS) / total);

  return {
    usage: USAGE_SHARE_BPS,
    engagement: scale(mapped.engagement),
    support: scale(mapped.support),
    sentiment: scale(mapped.sentiment),
    renewal: scale(mapped.renewal),
  };
}

// ── The five inputs ─────────────────────────────────────────────────────────

/** An input's own reading, or null when there was nothing to read. */
interface InputReading {
  readonly scoreBps: number;
  readonly evidence: Readonly<Record<string, string | number | null>>;
}

function clampBps(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(BPS, Math.round(value)));
}

export interface UsageObservation {
  readonly metricKey: string;
  readonly observedValue: number;
  /** What the tenant considers full use. Zero means they told us nothing. */
  readonly expectedValue: number;
  readonly observedAt: Date;
}

export interface UsageFacts {
  /** The latest observation of each metric, gathered by the caller. */
  readonly observations: readonly UsageObservation[];
}

/**
 * How stale a usage reading may be and still describe this month.
 *
 * A tenant whose telemetry job broke in March must not still be scored on March
 * in July: the number would be real, current, and about a product the customer
 * may have stopped opening. Past this the input goes ABSENT rather than to zero,
 * because a broken pipeline is our failure and not the customer's.
 */
export const USAGE_FRESHNESS_DAYS = 60;

export function readUsage(facts: UsageFacts, now: Date): InputReading | null {
  const floor = now.getTime() - USAGE_FRESHNESS_DAYS * DAY_MS;
  const usable = facts.observations.filter(
    (observation) =>
      observation.expectedValue > 0 && observation.observedAt.getTime() >= floor,
  );
  if (usable.length === 0) return null;

  const total = usable.reduce(
    (sum, observation) =>
      sum + clampBps((observation.observedValue * BPS) / observation.expectedValue),
    0,
  );

  const oldest = usable.reduce(
    (earliest, observation) =>
      observation.observedAt.getTime() < earliest.getTime() ? observation.observedAt : earliest,
    usable[0]!.observedAt,
  );

  return {
    scoreBps: Math.round(total / usable.length),
    evidence: {
      metrics: usable.map((observation) => observation.metricKey).join(","),
      metricCount: usable.length,
      staleMetricsIgnored: facts.observations.length - usable.length,
      oldestObservationAt: oldest.toISOString(),
    },
  };
}

export interface EngagementFacts {
  /** Null when this customer has never appeared on the timeline at all. */
  readonly lastActivityAt: Date | null;
  readonly countInWindow: number;
  readonly countInPriorWindow: number;
}

/** Contact inside this is current, so recency scores full marks. */
export const ENGAGEMENT_FRESH_DAYS = 14;
/** Silence past this scores nothing; between the two it is a straight line. */
export const ENGAGEMENT_COLD_DAYS = 90;

/**
 * How much the customer is talking to us, and whether that is more or less.
 *
 * Recency alone would call a customer healthy for answering one mail after four
 * silent months. Frequency alone would call a customer healthy for a flurry of
 * activity that is really an escalation. Both, averaged, and the frequency half
 * is measured against the customer's OWN previous window rather than a platform
 * target — a monthly check-in relationship and a daily one are both normal, and
 * a fixed target would call one of them broken. That is the same rule
 * `relationship-signals.ts` applies to silence.
 *
 * Absent, never zero, when nothing has ever happened: a party with an empty
 * timeline may be disengaged or may simply never have been instrumented, and
 * those two are not the same account.
 */
export function readEngagement(facts: EngagementFacts, now: Date): InputReading | null {
  if (!facts.lastActivityAt) return null;

  const daysSince = Math.max(0, (now.getTime() - facts.lastActivityAt.getTime()) / DAY_MS);
  const recencyBps =
    daysSince <= ENGAGEMENT_FRESH_DAYS
      ? BPS
      : daysSince >= ENGAGEMENT_COLD_DAYS
        ? 0
        : clampBps(
            ((ENGAGEMENT_COLD_DAYS - daysSince) * BPS) /
              (ENGAGEMENT_COLD_DAYS - ENGAGEMENT_FRESH_DAYS),
          );

  // Both windows empty is not a decline, it is the recency half's business.
  // Only a customer who WAS active can be less active than they were.
  const hasMomentum = facts.countInPriorWindow > 0;
  const momentumBps = hasMomentum
    ? clampBps((facts.countInWindow * BPS) / facts.countInPriorWindow)
    : null;

  return {
    scoreBps:
      momentumBps === null ? recencyBps : Math.round((recencyBps + momentumBps) / 2),
    evidence: {
      lastActivityAt: facts.lastActivityAt.toISOString(),
      daysSinceLastActivity: Math.round(daysSince),
      activitiesInWindow: facts.countInWindow,
      activitiesInPriorWindow: facts.countInPriorWindow,
      recencyBps,
      momentumBps,
    },
  };
}

/**
 * How long a ticket of each priority has before it has gone wrong.
 *
 * Carried over unchanged from the service this replaces. Enforcement rather than
 * configuration, deliberately: a tenant who could edit these could make their
 * own support look perfect, and a health score that a tenant can flatter is one
 * their own board cannot use.
 */
const SLA_RESOLUTION_TARGET_HOURS: Readonly<Record<string, number>> = {
  URGENT: 8,
  HIGH: 24,
  MEDIUM: 48,
  LOW: 72,
};

/** What one still-open, already-late ticket costs. */
const OVERDUE_TICKET_PENALTY_BPS = 1_500;

export interface SupportTicketFact {
  readonly priority: string;
  readonly openedAt: Date;
  readonly resolvedAt: Date | null;
  /** The tenant's own deadline where they set one; the target table otherwise. */
  readonly slaDeadline: Date | null;
}

export interface SupportFacts {
  /** This customer's tickets, not the organisation's. See the note below. */
  readonly tickets: readonly SupportTicketFact[];
}

/**
 * How this customer's support requests have gone — this customer's, specifically.
 *
 * The service this replaces computed one SLA figure and one ticket-count figure
 * for the whole ORGANISATION and then wrote them onto every account's breakdown.
 * Every customer of a tenant with one bad week scored identically, which made
 * the input incapable of distinguishing the customer who is about to leave from
 * the one beside them who is fine. Tickets are read per party here, and a
 * customer with none is absent rather than neutral: never having contacted
 * support is not evidence about support.
 */
export function readSupport(facts: SupportFacts, now: Date): InputReading | null {
  if (facts.tickets.length === 0) return null;

  let withinTarget = 0;
  let overdueOpen = 0;

  for (const ticket of facts.tickets) {
    const target =
      SLA_RESOLUTION_TARGET_HOURS[ticket.priority.toUpperCase()] ??
      SLA_RESOLUTION_TARGET_HOURS.MEDIUM!;

    if (ticket.resolvedAt) {
      const hours = (ticket.resolvedAt.getTime() - ticket.openedAt.getTime()) / HOUR_MS;
      if (hours <= target) withinTarget += 1;
      continue;
    }

    // Still open. It has not failed until it is late, so an in-flight ticket
    // inside its window counts as met rather than dragging the score down for
    // being young — otherwise raising a ticket at all would hurt a customer.
    const late = ticket.slaDeadline
      ? now.getTime() > ticket.slaDeadline.getTime()
      : (now.getTime() - ticket.openedAt.getTime()) / HOUR_MS > target;

    if (late) overdueOpen += 1;
    else withinTarget += 1;
  }

  const attainmentBps = clampBps((withinTarget * BPS) / facts.tickets.length);

  return {
    scoreBps: clampBps(attainmentBps - overdueOpen * OVERDUE_TICKET_PENALTY_BPS),
    evidence: {
      tickets: facts.tickets.length,
      withinTarget,
      overdueOpen,
      attainmentBps,
    },
  };
}

export interface SentimentFacts {
  readonly positive: number;
  readonly neutral: number;
  readonly negative: number;
}

/**
 * What conversation analysis concluded, counted rather than averaged over text.
 *
 * A neutral reading is worth half of a positive one and not zero: "neutral" is
 * the model saying it found nothing either way, and scoring that as badly as
 * anger would make every transactional exchange look like a complaint.
 */
export function readSentiment(facts: SentimentFacts): InputReading | null {
  const total = facts.positive + facts.neutral + facts.negative;
  if (total <= 0) return null;

  return {
    scoreBps: clampBps((facts.positive * BPS + facts.neutral * (BPS / 2)) / total),
    evidence: {
      positive: facts.positive,
      neutral: facts.neutral,
      negative: facts.negative,
    },
  };
}

export interface RenewalFacts {
  /** Negative once the date has gone by. Null when nobody has recorded one. */
  readonly daysToRenewal: number | null;
}

/** Beyond this a renewal is not yet a fact about health. */
export const RENEWAL_HORIZON_DAYS = 90;

export function readRenewal(facts: RenewalFacts): InputReading | null {
  const days = facts.daysToRenewal;
  if (days === null) return null;

  const scoreBps =
    days < 0 ? 0 : days >= RENEWAL_HORIZON_DAYS ? BPS : clampBps((days * BPS) / RENEWAL_HORIZON_DAYS);

  return { scoreBps, evidence: { daysToRenewal: days } };
}

// ── The composite ───────────────────────────────────────────────────────────

export interface HealthFacts {
  readonly now: Date;
  readonly usage: UsageFacts;
  readonly engagement: EngagementFacts;
  readonly support: SupportFacts;
  readonly sentiment: SentimentFacts;
  readonly renewal: RenewalFacts;
  readonly weightsBps: Readonly<Record<HealthInput, number>>;
  readonly thresholds: HealthScoreThresholds;
}

export type HealthOutcome =
  | {
      readonly scored: true;
      readonly score: number;
      readonly band: CustomerHealthBand;
      readonly contributions: readonly HealthContribution[];
      readonly coverageBps: number;
      readonly basis: HealthBasis;
    }
  | {
      /**
       * Nothing was measurable, so there is no score — not a zero and not a
       * neutral fifty. The contributions still come back, because "we looked at
       * five things and found none of them" is the answer, and a surface that
       * shows it is more use than one showing an invented number.
       */
      readonly scored: false;
      readonly contributions: readonly HealthContribution[];
    };

export function bandFor(score: number, thresholds: HealthScoreThresholds): CustomerHealthBand {
  if (score >= thresholds.healthy) return "healthy";
  if (score >= thresholds.atRisk) return "at_risk";
  return "critical";
}

/**
 * The score, and everything it was made of.
 *
 * The order of `HEALTH_INPUTS` is the order of `contributions`, so a surface can
 * render the decomposition without sorting and two scores can be compared field
 * by field.
 */
export function scoreHealth(facts: HealthFacts): HealthOutcome {
  const readings: Readonly<Record<HealthInput, InputReading | null>> = {
    usage: readUsage(facts.usage, facts.now),
    engagement: readEngagement(facts.engagement, facts.now),
    support: readSupport(facts.support, facts.now),
    sentiment: readSentiment(facts.sentiment),
    renewal: readRenewal(facts.renewal),
  };

  const contributions: HealthContribution[] = HEALTH_INPUTS.map((input) => {
    const reading = readings[input];
    return {
      input,
      weightBps: facts.weightsBps[input],
      scoreBps: reading?.scoreBps ?? null,
      available: reading !== null,
      evidence: reading?.evidence ?? {},
    };
  });

  const declaredWeight = contributions.reduce((sum, entry) => sum + entry.weightBps, 0);
  const availableWeight = contributions.reduce(
    (sum, entry) => sum + (entry.available ? entry.weightBps : 0),
    0,
  );

  if (availableWeight <= 0) return { scored: false, contributions };

  /**
   * One division, one rounding, over the whole set.
   *
   * The numerator is an integer sum of `scoreBps × weightBps`, so nothing drifts
   * on the way in; dividing by the AVAILABLE weight rather than the declared one
   * is what makes a partial score an honest reading of the inputs that existed
   * instead of a full score with holes punched in it.
   */
  const numerator = contributions.reduce(
    (sum, entry) => sum + (entry.scoreBps ?? 0) * entry.weightBps,
    0,
  );
  const score = Math.max(0, Math.min(100, Math.round(numerator / availableWeight / 100)));
  const coverageBps =
    declaredWeight > 0 ? Math.round((availableWeight * BPS) / declaredWeight) : 0;

  return {
    scored: true,
    score,
    band: bandFor(score, facts.thresholds),
    contributions,
    coverageBps,
    basis: coverageBps >= BPS ? "complete" : "partial",
  };
}

// ── History, trend and the signal a change produces ─────────────────────────

export interface HealthPoint {
  readonly score: number;
  readonly band: CustomerHealthBand;
  readonly coverageBps: number;
  /** Which inputs were behind it. Two points with different sets are not comparable. */
  readonly availableInputs: readonly HealthInput[];
  readonly computedAt: Date;
}

export type TrendDirection = "improving" | "steady" | "declining" | "unknown";

export interface HealthTrend {
  readonly direction: TrendDirection;
  readonly deltaPoints: number;
  /** The point this was compared against, or null when there was none. */
  readonly comparedTo: Date | null;
}

/**
 * Movement small enough to be the model breathing rather than the customer.
 *
 * Three points is one late ticket resolving, or one activity falling out of a
 * ninety-day window. Calling that a decline puts a customer on a list every
 * week and teaches whoever reads the list to stop reading it.
 */
export const TREND_NOISE_POINTS = 3;

/**
 * A drop worth telling somebody about.
 *
 * Ten points crosses roughly a third of the distance between the default bands,
 * which is far enough that something changed and near enough to act on before
 * the band itself moves. A band change signals regardless of size — see
 * `healthSignals` — because crossing into "critical" is the event, not the
 * number of points it took.
 */
export const MATERIAL_HEALTH_CHANGE_POINTS = 10;

function sameInputs(a: readonly HealthInput[], b: readonly HealthInput[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((input, index) => input === right[index]);
}

/**
 * Where a customer is going, from the history rather than from the latest row.
 *
 * Compared against the most recent EARLIER point built from the same inputs. A
 * score that "fell" because the tenant's telemetry stopped reporting has not
 * fallen — the model changed underneath it — and reporting that as a decline
 * sends somebody to save a customer who is fine. Returns `unknown` rather than
 * `steady` when there is nothing comparable, because "we cannot tell" and "it
 * has not moved" are different answers.
 *
 * `history` is newest first, which is the order the read returns.
 */
export function healthTrend(history: readonly HealthPoint[]): HealthTrend {
  const latest = history[0];
  if (!latest) return { direction: "unknown", deltaPoints: 0, comparedTo: null };

  const earlier = history
    .slice(1)
    .find((point) => sameInputs(point.availableInputs, latest.availableInputs));
  if (!earlier) return { direction: "unknown", deltaPoints: 0, comparedTo: null };

  const deltaPoints = latest.score - earlier.score;
  const direction: TrendDirection =
    Math.abs(deltaPoints) < TREND_NOISE_POINTS
      ? "steady"
      : deltaPoints > 0
        ? "improving"
        : "declining";

  return { direction, deltaPoints, comparedTo: earlier.computedAt };
}

/**
 * What a new score is worth saying out loud.
 *
 * Criterion 5, and the reason it is a signal rather than a notification: this is
 * the same shape `relationship-signals.ts` produces, so a health drop and a
 * champion going quiet arrive on one feed and can become one decision.
 *
 * Returns nothing far more often than not. A first score is not a change; two
 * scores built from different inputs are not comparable; and movement inside the
 * noise band is the composite breathing.
 */
export function healthSignals(
  previous: HealthPoint | null,
  current: HealthPoint,
): CustomerLifecycleSignal[] {
  if (!previous) return [];
  if (!sameInputs(previous.availableInputs, current.availableInputs)) return [];

  const delta = current.score - previous.score;
  const evidence: Readonly<Record<string, string | number | null>> = {
    from: previous.score,
    to: current.score,
    deltaPoints: delta,
    fromBand: previous.band,
    toBand: current.band,
    coverageBps: current.coverageBps,
    comparedToAt: previous.computedAt.toISOString(),
    inputs: [...current.availableInputs].sort().join(","),
  };

  if (previous.band !== current.band)
    return [
      {
        kind: "health.band-changed",
        evidence,
        // Recording a band change acts on nothing by itself; what acts on it is
        // the trigger sweep, and that has its own reversibility.
        reversibility: "instant",
        summary: `Health moved from ${previous.band} to ${current.band} (${previous.score} → ${current.score})`,
        observedAt: current.computedAt,
      },
    ];

  if (delta <= -MATERIAL_HEALTH_CHANGE_POINTS)
    return [
      {
        kind: "health.dropped",
        evidence,
        reversibility: "instant",
        summary: `Health fell ${Math.abs(delta)} points to ${current.score}`,
        observedAt: current.computedAt,
      },
    ];

  if (delta >= MATERIAL_HEALTH_CHANGE_POINTS)
    return [
      {
        kind: "health.recovered",
        evidence,
        reversibility: "instant",
        summary: `Health rose ${delta} points to ${current.score}`,
        observedAt: current.computedAt,
      },
    ];

  return [];
}

/** The inputs a set of contributions actually had data for, for a `HealthPoint`. */
export function availableInputsOf(
  contributions: readonly HealthContribution[],
): HealthInput[] {
  return contributions.filter((entry) => entry.available).map((entry) => entry.input);
}
