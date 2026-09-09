import { questionRateBps } from "./transcript-metrics";

/**
 * The calls worth listening to, and what "worth" is allowed to mean.
 *
 * CRM-P2-06 is a small feature with one large hazard. "Show me the best calls"
 * is a query that, answered carelessly, hands somebody a ranked list of other
 * people's conversations — the leaderboard `call-coaching.controller.ts` refuses
 * to build, arrived at from the search side. Two things stop that here and
 * neither of them is in this file, which is the point: candidates arrive from
 * `CallAnalysisCohortService`, so a call is a candidate only if this reader
 * could already have opened it one at a time, and only if the consent rule
 * permits the recording to have been processed at all. This file ranks what it
 * is given and has no way to reach anything else.
 *
 * What it does own is the definition of "well". Three metrics, each with an
 * explicit notion of good, because "best" without one silently becomes "highest
 * number", and the highest talk ratio in a team is the worst call in it.
 *
 *   - **talk-ratio** — closeness to a target, not a maximum. A rep speaking 92%
 *     of a call is not exemplary and neither is one speaking 8%; both are calls
 *     where one side stopped participating. The target is the middle of the
 *     range `call-coaching.ts` already treats as healthy, so the two surfaces
 *     cannot disagree about what a good call looks like.
 *   - **question-rate** — a maximum, honestly. More questions per turn is better
 *     on a discovery call and there is no ceiling worth asserting; a rep asking
 *     two questions a turn is running the conversation, which is the thing being
 *     held up as an example.
 *   - **next-step** — a filter, not a score. Every call that ended with a named
 *     commitment exemplifies next-step capture equally well, so ranking them
 *     against each other would be inventing a difference. Most recent first,
 *     which is at least a fact.
 *
 * A floor applies to all three. A call has to be a conversation before it can be
 * a good one: `transcript-metrics.ts` already refuses to produce metrics under
 * four turns, and four turns is a greeting. Handing a colleague a two-minute
 * call to learn from wastes their afternoon and discredits the feature the first
 * time somebody tries it.
 *
 * Nothing here carries a quote, a next-step sentence or an objection. An
 * exemplar is a pointer — "listen to this one" — and the reader follows it to
 * `GET /crm/calls/:activityId/analysis`, which applies the visibility rule
 * again on its own terms. Putting the content in the list would mean the search
 * endpoint became a second, unaudited way to read analyses in bulk.
 */

export const EXEMPLAR_METRICS = ["talk-ratio", "question-rate", "next-step"] as const;
export type ExemplarMetric = (typeof EXEMPLAR_METRICS)[number];

/**
 * The talk ratio an exemplary call sits nearest.
 *
 * 5000 bps — half the words. It is the midpoint of the 35–65% span that
 * `TALK_RATIO_BANDS` in `call-coaching.ts` treats as the healthy middle, and it
 * is derived from those bands rather than picked here so that a change to the
 * bands cannot leave the two surfaces recommending different calls. Below 35% a
 * rep is being interviewed; above 80% it is a demo nobody asked for.
 */
export const EXEMPLAR_TALK_RATIO_TARGET_BPS = 5000;

/**
 * The shortest call that can be held up as an example.
 *
 * Eight rep turns, against the four `parseDiarisedTranscript` needs before it
 * will produce a metric at all. Four is the floor for the arithmetic being
 * meaningful; eight is the floor for the call being a conversation somebody
 * could learn from — roughly an opening, two exchanges and a close. Set lower,
 * the top of a question-rate list fills with three-turn calls where one question
 * is a rate of 3,300 bps; set much higher, a team that runs short qualification
 * calls never sees an exemplar and concludes the feature is broken.
 */
export const EXEMPLAR_MIN_REP_TURNS = 8;

/** The most exemplars one page may hold. The platform-wide list cap. */
export const EXEMPLAR_MAX_PAGE_SIZE = 100;

/**
 * One call as the ranker needs it.
 *
 * Everything on it is either a counted metric from `transcript-metrics.ts`, the
 * stored `nextStepCommitted` judgement, or an identifier. No prose, by
 * construction rather than by discipline.
 */
export interface ExemplarCandidate {
  readonly activityId: string;
  readonly repUserId: string | null;
  readonly occurredAt: Date | null;
  readonly analysedAt: Date;
  readonly talkRatioBps: number | null;
  readonly repTurnCount: number | null;
  readonly repQuestionCount: number | null;
  readonly nextStepCommitted: boolean;
}

export interface CallExemplar {
  readonly activityId: string;
  readonly repUserId: string | null;
  readonly occurredAt: Date | null;
  readonly analysedAt: Date;
  readonly talkRatioBps: number | null;
  /** Derived through `questionRateBps`, so every surface divides identically. */
  readonly questionRateBps: number | null;
  readonly repTurnCount: number | null;
  readonly repQuestionCount: number | null;
  readonly nextStepCommitted: boolean;
  /**
   * The value this call was ranked on, in the metric's own units — basis points
   * for the two rates, and the analysis timestamp in milliseconds for
   * `next-step`, where there is nothing else to order by.
   *
   * Returned instead of an opaque score. A reader who is being told this is a
   * good example of a talk ratio should be able to see the talk ratio; a number
   * that only the sorting understands invites the question "good compared to
   * what" and answers it with nothing.
   */
  readonly metricValueBps: number | null;
}

export interface ExemplarSelection {
  readonly exemplars: readonly CallExemplar[];
  /**
   * Visible, consented calls in the window that could not be ranked on this
   * metric — no speaker attribution, too short, or no next step committed.
   *
   * Reported rather than swallowed. A rep who ran forty calls and sees three
   * exemplars needs to know whether the other thirty-seven were bad or were
   * simply not measurable, and those two produce very different next actions.
   */
  readonly ineligible: number;
}

/**
 * Rank the candidates and say how many could not be ranked.
 *
 * Pure, total, and takes no clock: `next-step` orders by `analysedAt`, which is
 * on the row, so a spec can assert the ordering without freezing time.
 */
export function selectCallExemplars(
  candidates: readonly ExemplarCandidate[],
  metric: ExemplarMetric,
): ExemplarSelection {
  const scored: { exemplar: CallExemplar; score: number }[] = [];
  let ineligible = 0;

  for (const candidate of candidates) {
    const score = scoreFor(candidate, metric);
    if (score === null) {
      ineligible += 1;
      continue;
    }
    scored.push({ exemplar: toExemplar(candidate, metric), score });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      // A longer conversation is the better example when two calls score the
      // same, and the id breaks the last tie so paging is deterministic — two
      // pages of an unstable sort show one call twice and another never.
      (b.exemplar.repTurnCount ?? 0) - (a.exemplar.repTurnCount ?? 0) ||
      a.exemplar.activityId.localeCompare(b.exemplar.activityId),
  );

  return { exemplars: scored.map((entry) => entry.exemplar), ineligible };
}

/**
 * How well this call exemplifies the metric, or null when it cannot be judged.
 *
 * Higher is better in every branch, which is what lets one comparator serve all
 * three. `null` is eligibility, not a low score: a call with no speaker
 * attribution is not a bad example of a talk ratio, it is a call whose talk
 * ratio nobody knows, and ranking it last would put it above a call that is
 * merely mediocre.
 */
function scoreFor(candidate: ExemplarCandidate, metric: ExemplarMetric): number | null {
  if (metric === "next-step") {
    if (!candidate.nextStepCommitted) return null;
    /**
     * No floor on turns here, and that is deliberate rather than an oversight.
     * A short call that ends with a booked meeting is a good example of exactly
     * the thing being asked for, and it may have no speaker attribution at all —
     * `nextStepCommitted` is a judgement about the conversation, not arithmetic
     * over turns. Applying the diarisation floor would silently exclude every
     * call from a carrier that does not label speakers.
     */
    return candidate.analysedAt.getTime();
  }

  const turns = candidate.repTurnCount;
  if (turns === null || turns < EXEMPLAR_MIN_REP_TURNS) return null;

  if (metric === "talk-ratio") {
    if (candidate.talkRatioBps === null) return null;
    // Distance inverted, so nearest-to-target sorts first under the same
    // descending comparator the other metrics use.
    return -Math.abs(candidate.talkRatioBps - EXEMPLAR_TALK_RATIO_TARGET_BPS);
  }

  const rate = questionRateBps(candidate.repQuestionCount, turns);
  return rate;
}

function toExemplar(candidate: ExemplarCandidate, metric: ExemplarMetric): CallExemplar {
  const rate = questionRateBps(candidate.repQuestionCount, candidate.repTurnCount);

  return {
    activityId: candidate.activityId,
    repUserId: candidate.repUserId,
    occurredAt: candidate.occurredAt,
    analysedAt: candidate.analysedAt,
    talkRatioBps: candidate.talkRatioBps,
    questionRateBps: rate,
    repTurnCount: candidate.repTurnCount,
    repQuestionCount: candidate.repQuestionCount,
    nextStepCommitted: candidate.nextStepCommitted,
    metricValueBps:
      metric === "talk-ratio"
        ? candidate.talkRatioBps
        : metric === "question-rate"
          ? rate
          : /**
             * Null for `next-step`, rather than 1 or 10000. The list is ordered
             * by recency and the metric is a boolean the row already carries;
             * inventing a value for the column would make it look like a
             * measurement of how well the next step was captured, which is not
             * a thing anything here measures.
             */
            null,
  };
}
