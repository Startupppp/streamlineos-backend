/**
 * What a forecast is allowed to know about a deal.
 *
 * Every number here is derived from something the tenant already has: the stage
 * ledger, the deal's own columns, its activity timeline, the lead it came from
 * and the rep it is assigned to. Nothing is captured for the model's benefit,
 * which is what makes it possible to score a tenant's pipeline on the day they
 * turn it on rather than a quarter later.
 *
 * The whole file is pure. Given the same inputs it returns the same vector, and
 * `asOf` is an argument rather than `Date.now()` — a forecast a tenant cannot
 * reproduce is worse than no forecast, and reproducing one means being able to
 * ask what the model saw on the morning it said what it said.
 */

/**
 * Bumped whenever the meaning or the membership of the vector changes.
 *
 * A model is stored with the version it was trained under and refuses to score
 * against a different one, because coefficients fitted to one vocabulary applied
 * to another are numbers with no meaning that still look like a probability.
 *
 * 2 — the smoothing prior no longer removes the row's own outcome from the
 * organisation-wide baseline. Membership is unchanged; `repWinRate` and
 * `sourceWinRate` take different values because the prior they are smoothed
 * towards does. See `assembleDealFeatures`: under 1 that prior was a
 * two-valued encoding of the label, and any model trained under it learned the
 * answer key. No model should be carried across this boundary.
 */
export const FORECAST_FEATURE_SPEC_VERSION = "2";

export const DEAL_FEATURE_NAMES = [
  "stageProbability",
  "logValue",
  "ageDays",
  "currentStageDwellDays",
  "advanceCount",
  "regressionCount",
  "activityCount",
  "daysSinceLastActivity",
  "activitiesPerWeek",
  "daysToExpectedClose",
  "hasExpectedCloseDate",
  "expectedCloseOverdue",
  "repWinRate",
  "sourceWinRate",
] as const;

export type DealFeatureName = (typeof DEAL_FEATURE_NAMES)[number];

/**
 * The hard caps, stated once.
 *
 * Two jobs. They stop one pathological deal — an import with a 1970 creation
 * date, a mailbox sync that logged nine thousand activities — from dominating a
 * fit that has only a few dozen examples to learn from. And they bound the work:
 * a capped array aggregate is what lets the whole pipeline be assembled in three
 * queries rather than one per deal.
 */
export const FORECAST_FEATURE_CAPS = {
  maxAgeDays: 730,
  maxDwellDays: 365,
  maxDaysToClose: 365,
  maxActivities: 200,
  maxActivitiesPerWeek: 50,
  maxStageMoves: 50,
  /** Ten crore major units. Beyond this the log is flat anyway. */
  maxValueMinor: 100_000_000_000,
  /** Deals scored in one pass, newest first. */
  maxOpenDealsScored: 5_000,
  /** Closed deals read for one training run, newest first. */
  maxTrainingExamples: 5_000,
  /** How far back a training run looks. */
  trainingWindowDays: 730,
} as const;

/**
 * How hard a group has to argue before it is believed over the tenant average.
 *
 * Ten notional prior observations: a rep with three closes is still mostly the
 * house average, a rep with two hundred is essentially their own number. Without
 * this a rep who closed their only deal reads as a certainty.
 */
export const WIN_RATE_PRIOR_WEIGHT = 10;

/** The rate assumed for a tenant with no closed history at all. */
export const NEUTRAL_WIN_RATE = 0.5;

const DAY_MS = 86_400_000;

export interface DealSnapshot {
  readonly dealId: number;
  readonly createdAt: Date;
  readonly valueMinor: number;
  readonly stage: string;
  readonly expectedCloseDate: Date | null;
  readonly assignedToId: string | null;
  /** The lead's source, where the deal came from one. */
  readonly sourceKey: string | null;
}

export interface StageMove {
  readonly fromStage: string | null;
  readonly toStage: string;
  readonly occurredAt: Date;
}

export interface DealTimeline {
  readonly moves: readonly StageMove[];
  readonly activityCount: number;
  readonly lastActivityAt: Date | null;
}

export interface OutcomeCounts {
  readonly won: number;
  readonly total: number;
}

export interface HistoricalRates {
  readonly baseline: OutcomeCounts;
  readonly byRep: ReadonlyMap<string, OutcomeCounts>;
  readonly bySource: ReadonlyMap<string, OutcomeCounts>;
}

export type DealOutcome = "won" | "lost";

export interface DealFeatureInput {
  readonly asOf: Date;
  readonly deal: DealSnapshot;
  readonly timeline: DealTimeline;
  /** The tenant's own configured probability per stage, 0–100. */
  readonly stageProbabilities: ReadonlyMap<string, number>;
  readonly rates: HistoricalRates;
  /**
   * Set only when this deal's own outcome is already counted in `rates` — that
   * is, when the vector is a training example rather than a live score. Its
   * outcome is then subtracted before the rep and source rates are read, or the
   * example would be quietly told its own answer.
   */
  readonly ownOutcome: DealOutcome | null;
}

export interface DealFeatureVector {
  readonly dealId: number;
  readonly asOf: string;
  readonly specVersion: string;
  readonly values: Readonly<Record<DealFeatureName, number>>;
}

export function emptyHistoricalRates(): HistoricalRates {
  return { baseline: { won: 0, total: 0 }, byRep: new Map(), bySource: new Map() };
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, value));
}

function elapsedDays(from: Date, to: Date, cap: number): number {
  return clamp(Math.floor((to.getTime() - from.getTime()) / DAY_MS), 0, cap);
}

/** The rate a tenant with history assumes before any group speaks. */
export function baseWinRate(counts: OutcomeCounts): number {
  if (counts.total <= 0) return NEUTRAL_WIN_RATE;
  return clamp(counts.won / counts.total, 0, 1);
}

/**
 * A group's own rate, pulled towards the prior in proportion to how little it
 * has to say.
 *
 * `(won + prior x weight) / (total + weight)` — the posterior mean of a Beta
 * prior, which is the cheapest honest answer to "this rep has closed four
 * deals, what does that tell me".
 */
export function smoothedWinRate(counts: OutcomeCounts, prior: number): number {
  const won = Math.max(0, counts.won);
  const total = Math.max(won, Math.max(0, counts.total));
  const safePrior = clamp(prior, 0, 1);
  return clamp(
    (won + safePrior * WIN_RATE_PRIOR_WEIGHT) / (total + WIN_RATE_PRIOR_WEIGHT),
    0,
    1,
  );
}

function withoutOwnOutcome(
  counts: OutcomeCounts | undefined,
  ownOutcome: DealOutcome | null,
): OutcomeCounts {
  const base = counts ?? { won: 0, total: 0 };
  if (ownOutcome === null) return base;
  return {
    won: base.won - (ownOutcome === "won" ? 1 : 0),
    total: base.total - 1,
  };
}

/**
 * The activity half of the timeline, capped and cut off at the scoring moment.
 *
 * Separated out because the assembly service computes the same two numbers in
 * SQL over millions of rows; this is the definition both agree on, and the
 * database spec asserts they do.
 */
export function summariseActivityWindow(
  occurredAt: readonly Date[],
  asOf: Date,
): { activityCount: number; lastActivityAt: Date | null } {
  let count = 0;
  let last: Date | null = null;

  for (const at of occurredAt) {
    if (at.getTime() > asOf.getTime()) continue;
    count += 1;
    if (last === null || at.getTime() > last.getTime()) last = at;
  }

  return {
    activityCount: Math.min(count, FORECAST_FEATURE_CAPS.maxActivities),
    lastActivityAt: last,
  };
}

export function toFeatureArray(values: Readonly<Record<DealFeatureName, number>>): number[] {
  return DEAL_FEATURE_NAMES.map((name) => values[name]);
}

interface LedgerShape {
  readonly advanceCount: number;
  readonly regressionCount: number;
  readonly lastMoveAt: Date | null;
}

function readLedger(
  moves: readonly StageMove[],
  asOf: Date,
  probabilityOf: (stage: string | null) => number,
): LedgerShape {
  const inWindow = moves
    .filter((move) => move.occurredAt.getTime() <= asOf.getTime())
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
    .slice(-FORECAST_FEATURE_CAPS.maxStageMoves);

  let advanceCount = 0;
  let regressionCount = 0;
  let lastMoveAt: Date | null = null;

  for (const move of inWindow) {
    lastMoveAt = move.occurredAt;
    // The opening entry is the deal appearing, not a move. Counting it would add
    // the same 1 to every deal alive, which the intercept absorbs anyway.
    if (move.fromStage === null) continue;
    if (probabilityOf(move.toStage) >= probabilityOf(move.fromStage)) advanceCount += 1;
    else regressionCount += 1;
  }

  return { advanceCount, regressionCount, lastMoveAt };
}

/**
 * One deal, one moment, one vector.
 *
 * The order of operations matters for reproducibility: everything is read
 * against `asOf`, nothing consults the clock, and every unbounded quantity is
 * clamped before it reaches the vector rather than after.
 */
export function assembleDealFeatures(input: DealFeatureInput): DealFeatureVector {
  const { asOf, deal, timeline, stageProbabilities, rates, ownOutcome } = input;

  /**
   * The organisation-wide rate, WITH this deal in it — deliberately not
   * leave-one-out, unlike the rep and source rates below.
   *
   * Leaving one out is right for a group of four deals and wrong for a group of
   * four hundred, and here it was actively harmful. The baseline is one group
   * per organisation, so removing the row's own outcome gives the prior exactly
   * two values across the entire training set — `(won-1)/(total-1)` for a deal
   * that was won and `won/(total-1)` for one that was lost — and which of the
   * two a row receives is decided by nothing but its own label. Worked at three
   * sizes: 40/100 gives 0.403670 against 0.412844, 200/500 gives 0.400786
   * against 0.402750, 8/20 gives 0.413793 against 0.448276. Distinct every time,
   * which is all a linear model needs to separate on it perfectly.
   *
   * That is target leakage the acceptance gate cannot catch, because the
   * held-out rows carry the same encoding of their own outcomes. A model fitted
   * on it would clear `minAuc` and beat naive on Brier while having learned the
   * answer key.
   *
   * It also skewed serving against training: an open deal has no outcome to
   * remove, so `prior` took a third value there — 0.409091 in the first case —
   * that appeared in no training row at all.
   *
   * Including the row costs a 1/N contamination of a rate over hundreds of
   * deals, which is the ordinary and harmless kind. `withoutOwnOutcome` stays
   * where it belongs: on `rates.rep` and `rates.source`, whose groups really are
   * small enough for one deal to move them.
   */
  const prior = baseWinRate(rates.baseline ?? { won: 0, total: 0 });

  const probabilityOf = (stage: string | null): number => {
    if (stage === null) return 0;
    const declared = stageProbabilities.get(stage);
    return declared === undefined ? prior : clamp(declared / 100, 0, 1);
  };

  const ageDays = elapsedDays(deal.createdAt, asOf, FORECAST_FEATURE_CAPS.maxAgeDays);
  const ledger = readLedger(timeline.moves, asOf, probabilityOf);

  const dwellSince = ledger.lastMoveAt ?? deal.createdAt;
  const currentStageDwellDays = elapsedDays(
    dwellSince,
    asOf,
    FORECAST_FEATURE_CAPS.maxDwellDays,
  );

  const activityCount = clamp(timeline.activityCount, 0, FORECAST_FEATURE_CAPS.maxActivities);
  const daysSinceLastActivity =
    timeline.lastActivityAt === null
      ? ageDays
      : elapsedDays(timeline.lastActivityAt, asOf, FORECAST_FEATURE_CAPS.maxAgeDays);

  const weeksOpen = Math.max(ageDays, 1) / 7;
  const activitiesPerWeek = clamp(
    activityCount / weeksOpen,
    0,
    FORECAST_FEATURE_CAPS.maxActivitiesPerWeek,
  );

  const hasExpectedCloseDate = deal.expectedCloseDate === null ? 0 : 1;
  const daysToExpectedClose =
    deal.expectedCloseDate === null
      ? 0
      : clamp(
          Math.round((deal.expectedCloseDate.getTime() - asOf.getTime()) / DAY_MS),
          -FORECAST_FEATURE_CAPS.maxDaysToClose,
          FORECAST_FEATURE_CAPS.maxDaysToClose,
        );

  const valueMinor = clamp(deal.valueMinor, 0, FORECAST_FEATURE_CAPS.maxValueMinor);

  const repCounts =
    deal.assignedToId === null
      ? null
      : withoutOwnOutcome(rates.byRep.get(deal.assignedToId), ownOutcome);
  const sourceCounts =
    deal.sourceKey === null
      ? null
      : withoutOwnOutcome(rates.bySource.get(deal.sourceKey), ownOutcome);

  return {
    dealId: deal.dealId,
    asOf: asOf.toISOString(),
    specVersion: FORECAST_FEATURE_SPEC_VERSION,
    values: {
      stageProbability: probabilityOf(deal.stage),
      logValue: Math.log10(1 + valueMinor / 100),
      ageDays,
      currentStageDwellDays,
      advanceCount: ledger.advanceCount,
      regressionCount: ledger.regressionCount,
      activityCount,
      daysSinceLastActivity,
      activitiesPerWeek,
      daysToExpectedClose,
      hasExpectedCloseDate,
      expectedCloseOverdue: daysToExpectedClose < 0 ? 1 : 0,
      repWinRate: repCounts === null ? prior : smoothedWinRate(repCounts, prior),
      sourceWinRate: sourceCounts === null ? prior : smoothedWinRate(sourceCounts, prior),
    },
  };
}
