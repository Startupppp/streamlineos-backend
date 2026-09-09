import type { CallAnalysisVisibility } from "./call-analysis-visibility";
import { questionRateBps } from "./transcript-metrics";

/**
 * One rep's calls, summarised — and the argument for why this may exist at all.
 *
 * `call-coaching.controller.ts` says, in as many words, that there is "no
 * per-rep route anywhere in this module", because a leaderboard is not a
 * rendering choice: it is an endpoint that returns rows keyed by person, after
 * which every client that consumes it eventually sorts them. CRM-P2-05 asks for
 * exactly that endpoint, so the tension is real and is resolved here rather than
 * ignored.
 *
 * What actually makes a per-person aggregate dangerous is not the grouping. It
 * is a grouping computed over rows the reader was not entitled to read one at a
 * time — a manager quoting a number that includes the call the rep has not seen
 * yet, or a rep learning a colleague's talk ratio from a mean they were never
 * meant to be shown. `CallAnalysisCohortService` removes that: every candidate
 * reaching this file has already been decided by `callAnalysisVisibility`, so a
 * rep without `crm:call-analysis:view-team` arrives holding their own calls and
 * nothing else, and the group-by cannot manufacture a colleague's row out of
 * rows that are not there. The aggregate is therefore never more than a
 * re-statement of what the reader could already have assembled by hand from the
 * per-call route.
 *
 * Three things this file still refuses, because the cohort seam does not settle
 * them:
 *
 *   - **No ranking, and no sort key.** Rows come back in a stable order that has
 *     nothing to do with performance (see `compareReps`). A client can of course
 *     sort them; what it cannot do is receive an ordering that this module
 *     asserts is a ranking.
 *   - **No mean.** The median, for the reason `call-coaching.ts` gives for using
 *     bands: one bad transcript moves a mean and does not move a median, and a
 *     coaching conversation built on an artefact is worse than one built on
 *     nothing. A median over a rep's own calls is a description of how they work;
 *     a mean is a number to be beaten.
 *   - **No metric that is not measured.** Talk ratio, rep turns and rep questions
 *     are counted arithmetic from `transcript-metrics.ts`; the question rate is
 *     their quotient, derived through that module's own function so every surface
 *     divides identically. Next-step capture is the model's `nextStepCommitted`
 *     judgement, which is stored per call and is therefore a real measurement
 *     rather than an inference made here. **Monologue length is deliberately
 *     absent**: nothing in this codebase measures the longest uninterrupted run
 *     by one speaker, and reporting a plausible-looking figure for it would be
 *     the exact failure `transcript-metrics.ts` was written to prevent.
 *
 * A rep whose every call in the window is still embargoed gets no row. A row
 * carrying a name, a zero and nothing else would be a person-shaped placeholder
 * that says only "this person made calls" — which the timeline already says —
 * while inviting a reader to treat the blank as a result. The count is not lost:
 * it is in `embargoed` at the top level.
 */

/** How wide one point on a trend line is. Derived, never requested — see below. */
export type TrendBucket = "day" | "week";

/**
 * One analysed call as this file needs it.
 *
 * The whole `CallAnalysisVisibility` decision is carried in, not just its
 * boolean, and not recomputed. Nothing here may look at a permission, a release
 * or a clock: the moment this file could decide visibility for itself there
 * would be two answers to the question and the specs would only pin one of them.
 *
 * The reason is needed as well as the verdict because the two ways of being
 * invisible are not the same fact. `rep-window` is "this opens later", which the
 * reader has to be told about or their period silently understates itself.
 * `not-your-call` is "this was never in your scope" — a colleague's call seen by
 * somebody who does not hold `crm:call-analysis:view-team` — and counting those
 * would tell a rep how many calls the rest of the team made, which is a fact
 * about other people arrived at through a total.
 */
export interface RepCallCandidate {
  /** Null for an adapter-delivered call with nobody attributed. */
  readonly repUserId: string | null;
  readonly visibility: CallAnalysisVisibility;
  readonly analysedAt: Date;
  readonly talkRatioBps: number | null;
  readonly repTurnCount: number | null;
  readonly repQuestionCount: number | null;
  readonly nextStepCommitted: boolean;
}

export interface RepTrendPoint {
  /** Inclusive lower edge of the bucket. */
  readonly bucketStart: Date;
  /** Exclusive upper edge, so two adjacent buckets cannot both claim a call. */
  readonly bucketEnd: Date;
  readonly calls: number;
  readonly medianTalkRatioBps: number | null;
  readonly medianQuestionRateBps: number | null;
  readonly nextStepCommittedBps: number | null;
}

export interface RepCallAggregate {
  readonly repUserId: string;
  /** Calls this reader may read. Every metric below is computed from these. */
  readonly callsAnalysed: number;
  /** This rep's calls in the window that are still in their private window. */
  readonly embargoed: number;
  /** Visible calls whose transcript carried no speaker attribution. */
  readonly withoutSpeakerMetrics: number;
  readonly medianTalkRatioBps: number | null;
  readonly medianQuestionRateBps: number | null;
  /** Share of visible calls that ended with a named commitment, in bps. */
  readonly nextStepCommittedBps: number | null;
  /** Every bucket in the window, including the empty ones. */
  readonly trend: readonly RepTrendPoint[];
}

export interface RepCallAggregates {
  readonly reps: readonly RepCallAggregate[];
  /**
   * Visible calls with nobody attributed — counted, never grouped.
   *
   * An adapter-delivered call has no rep (`actor_kind = 'system'`), and
   * `call-analysis-visibility.ts` makes those readable by everyone precisely
   * because there is no named person to protect. Folding them into a rep's row
   * would attribute somebody else's conversation to them; dropping them silently
   * would make the per-rep totals disagree with the org-wide digest for a reason
   * nobody could find.
   */
  readonly unattributed: number;
  /**
   * Calls in this reader's scope that have not opened yet, across every rep,
   * including reps who therefore have no row at all.
   *
   * A bare total and nothing else, for the reason `CoachingDigest.embargoed`
   * gives: without it the surface silently understates the period, and with any
   * breakdown finer than this it starts saying something about somebody.
   *
   * Counts only `rep-window`. Calls belonging to other people, seen by somebody
   * without `crm:call-analysis:view-team`, are not in scope and are not counted
   * anywhere — see the branch in `repCallAggregates`.
   */
  readonly embargoed: number;
}

export interface TrendWindow {
  /** Inclusive lower edge of the whole window. */
  readonly since: Date;
  /** Exclusive upper edge — normally now. */
  readonly until: Date;
  readonly bucket: TrendBucket;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const BUCKET_MS: Readonly<Record<TrendBucket, number>> = {
  day: DAY_MS,
  week: 7 * DAY_MS,
};

/**
 * The bucket size, decided rather than asked for.
 *
 * Not a query parameter, and that is a deliberate narrowing. A caller free to
 * pair a ninety-day window with daily buckets would ask for ninety points per
 * rep and get a response whose size is the product of two unrelated numbers,
 * while reading a chart where a rep's three calls on a Tuesday are a spike. Two
 * weeks is the point where a rep has enough calls per day for a daily point to
 * mean anything; past it, weekly. Either way the count of points is bounded by
 * fourteen, which is what makes the response size predictable.
 */
export function trendBucketFor(sinceDays: number): TrendBucket {
  return sinceDays <= 14 ? "day" : "week";
}

/**
 * Bucket edges, counted backwards from `until`.
 *
 * Backwards rather than forwards from `since`, and aligned to nothing — not to
 * midnight, not to an ISO week, not to a calendar month. Every one of those
 * needs a timezone, and this codebase has already been bitten by date arithmetic
 * that could only be right in one zone. Counting back from the request's own
 * instant makes "the last seven days" mean exactly that for a reader in Delhi
 * and one in Denver, and makes the boundary reproducible in a spec without a
 * clock.
 *
 * The last bucket is the most recent, and the list is returned oldest first
 * because that is the direction a trend is read in.
 */
export function trendBuckets(window: TrendWindow): { start: Date; end: Date }[] {
  const size = BUCKET_MS[window.bucket];
  const untilMs = window.until.getTime();
  const sinceMs = window.since.getTime();
  const edges: { start: Date; end: Date }[] = [];

  for (let end = untilMs; end > sinceMs; end -= size) {
    const start = Math.max(end - size, sinceMs);
    edges.push({ start: new Date(start), end: new Date(end) });
    if (start === sinceMs) break;
  }

  return edges.reverse();
}

export function repCallAggregates(
  candidates: readonly RepCallCandidate[],
  window: TrendWindow,
): RepCallAggregates {
  const buckets = trendBuckets(window);

  const visibleByRep = new Map<string, RepCallCandidate[]>();
  const embargoedByRep = new Map<string, number>();
  let unattributed = 0;
  let embargoed = 0;

  for (const candidate of candidates) {
    if (!candidate.visibility.visible) {
      /**
       * A call outside this reader's scope is dropped without a trace, and a
       * call inside it that has not opened yet is counted. Collapsing the two
       * into one "hidden" total is the tempting simplification and it is a leak:
       * a rep holding only `crm:call-analysis:view` would learn the size of
       * their colleagues' week from a number that looks like bookkeeping.
       */
      if (candidate.visibility.reason !== "rep-window") continue;

      embargoed += 1;
      // Tracked per rep as well as in the total, so a rep who does have visible
      // calls can be told how much of their period is missing from the numbers.
      if (candidate.repUserId !== null)
        embargoedByRep.set(
          candidate.repUserId,
          (embargoedByRep.get(candidate.repUserId) ?? 0) + 1,
        );
      continue;
    }

    if (candidate.repUserId === null) {
      unattributed += 1;
      continue;
    }

    const held = visibleByRep.get(candidate.repUserId);
    if (held) held.push(candidate);
    else visibleByRep.set(candidate.repUserId, [candidate]);
  }

  const reps = [...visibleByRep.entries()]
    .map(([repUserId, calls]) =>
      aggregateOne(repUserId, calls, embargoedByRep.get(repUserId) ?? 0, buckets),
    )
    .sort(compareReps);

  return { reps, unattributed, embargoed };
}

function aggregateOne(
  repUserId: string,
  calls: readonly RepCallCandidate[],
  embargoed: number,
  buckets: readonly { start: Date; end: Date }[],
): RepCallAggregate {
  const summary = summarise(calls);

  return {
    repUserId,
    callsAnalysed: calls.length,
    embargoed,
    withoutSpeakerMetrics: summary.withoutSpeakerMetrics,
    medianTalkRatioBps: summary.medianTalkRatioBps,
    medianQuestionRateBps: summary.medianQuestionRateBps,
    nextStepCommittedBps: summary.nextStepCommittedBps,
    trend: buckets.map((bucket) => {
      const inBucket = calls.filter((call) => {
        const at = call.analysedAt.getTime();
        // Half-open, so a call landing exactly on an edge belongs to one bucket
        // and not to both — a closed interval double-counts every boundary.
        return at >= bucket.start.getTime() && at < bucket.end.getTime();
      });
      const point = summarise(inBucket);
      return {
        bucketStart: bucket.start,
        bucketEnd: bucket.end,
        calls: inBucket.length,
        medianTalkRatioBps: point.medianTalkRatioBps,
        medianQuestionRateBps: point.medianQuestionRateBps,
        nextStepCommittedBps: point.nextStepCommittedBps,
      };
    }),
  };
}

interface Summary {
  readonly withoutSpeakerMetrics: number;
  readonly medianTalkRatioBps: number | null;
  readonly medianQuestionRateBps: number | null;
  readonly nextStepCommittedBps: number | null;
}

function summarise(calls: readonly RepCallCandidate[]): Summary {
  const talkRatios: number[] = [];
  const questionRates: number[] = [];
  let withoutSpeakerMetrics = 0;
  let committed = 0;

  for (const call of calls) {
    if (call.talkRatioBps === null || call.repTurnCount === null || call.repQuestionCount === null) {
      /**
       * The metric arc is all-or-nothing in the database (the CHECK in 0540), so
       * one null means the transcript was not diarised. Counted rather than
       * dropped: a median over eleven calls that quietly ignored four of them is
       * a number with a hole nobody can see.
       */
      withoutSpeakerMetrics += 1;
    } else {
      talkRatios.push(call.talkRatioBps);
      const rate = questionRateBps(call.repQuestionCount, call.repTurnCount);
      // Null exactly when the rep took no turns, which is a call with no
      // question rate rather than a rate of zero.
      if (rate !== null) questionRates.push(rate);
    }

    if (call.nextStepCommitted) committed += 1;
  }

  return {
    withoutSpeakerMetrics,
    medianTalkRatioBps: median(talkRatios),
    medianQuestionRateBps: median(questionRates),
    /**
     * Computed over every visible call, diarised or not — unlike the two
     * medians. Whether a next step was agreed is a judgement about the whole
     * conversation and does not need speaker attribution, so excluding
     * undiarised calls here would understate a rep who happens to use a carrier
     * that does not label speakers.
     */
    nextStepCommittedBps:
      calls.length === 0 ? null : Math.round((committed * 10_000) / calls.length),
  };
}

/**
 * The median, or null for an empty set.
 *
 * Null rather than zero, and the distinction is the same one
 * `transcript-metrics.ts` makes about talk ratio: a rep with no diarised calls
 * has no median talk ratio, and rendering that as 0% would report somebody as
 * having said nothing.
 */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/**
 * A stable order that is not a ranking.
 *
 * By call count descending and then by user id, so the response is deterministic
 * — a paginated endpoint whose order depends on a hash iteration would show the
 * same rep on two pages and on neither. Call count is the one ordering that is
 * explicitly not a performance metric: it says how much of this window is about
 * each person, which is what a reader needs to weigh the numbers, and it is the
 * same fact the timeline already shows.
 */
function compareReps(a: RepCallAggregate, b: RepCallAggregate): number {
  return b.callsAnalysed - a.callsAnalysed || a.repUserId.localeCompare(b.repUserId);
}
