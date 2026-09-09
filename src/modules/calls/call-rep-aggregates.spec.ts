import type { CallAnalysisVisibility } from "./call-analysis-visibility";
import {
  repCallAggregates,
  trendBucketFor,
  trendBuckets,
  type RepCallCandidate,
} from "./call-rep-aggregates";

/**
 * The arithmetic, with the visibility decision handed in rather than computed.
 *
 * `call-rep-aggregates.service.spec.ts` proves the service only ever hands this
 * function rows the reader may read; this file proves that, given such rows, the
 * grouping does not invent a number. The split matters because the two failures
 * look identical from a response body: a leaked row and a miscounted median both
 * arrive as a number that is wrong in a plausible direction.
 */

const NOW = new Date("2026-09-09T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const REP_A = "user-rep-a";
const REP_B = "user-rep-b";

/**
 * The three decisions this file has to tell apart, spelled out rather than
 * abbreviated to a boolean. `rep-window` and `not-your-call` are both invisible
 * and are counted differently, which is the thing most likely to regress.
 */
const SEEN: CallAnalysisVisibility = { visible: true, reason: "window-elapsed", opensAt: null };
const IN_WINDOW: CallAnalysisVisibility = {
  visible: false,
  reason: "rep-window",
  opensAt: new Date(NOW.getTime() + 12 * HOUR),
};
const OUT_OF_SCOPE: CallAnalysisVisibility = {
  visible: false,
  reason: "not-your-call",
  opensAt: null,
};

const call = (over: Partial<RepCallCandidate> = {}): RepCallCandidate => ({
  repUserId: REP_A,
  visibility: SEEN,
  analysedAt: new Date(NOW.getTime() - DAY),
  talkRatioBps: 5000,
  repTurnCount: 10,
  repQuestionCount: 3,
  nextStepCommitted: false,
  ...over,
});

const window30 = { since: new Date(NOW.getTime() - 30 * DAY), until: NOW, bucket: "week" as const };

describe("per-rep call aggregates", () => {
  it("groups only the calls it was told are visible", () => {
    const result = repCallAggregates(
      [
        call({ repUserId: REP_A, talkRatioBps: 4000 }),
        call({ repUserId: REP_A, talkRatioBps: 6000 }),
        /**
         * Rep B's call is embargoed. If it reached the grouping it would appear
         * as a second row with a wildly different median — the exact shape of
         * the leak this whole feature has to not have.
         */
        call({ repUserId: REP_B, visibility: IN_WINDOW, talkRatioBps: 9500 }),
      ],
      window30,
    );

    expect(result.reps).toHaveLength(1);
    expect(result.reps[0]!.repUserId).toBe(REP_A);
    expect(result.reps[0]!.medianTalkRatioBps).toBe(5000);
    expect(result.embargoed).toBe(1);
  });

  it("gives a rep no row when every one of their calls is still embargoed", () => {
    const result = repCallAggregates(
      [
        call({ repUserId: REP_A }),
        call({ repUserId: REP_B, visibility: IN_WINDOW }),
        call({ repUserId: REP_B, visibility: IN_WINDOW }),
      ],
      window30,
    );

    expect(result.reps.map((rep) => rep.repUserId)).toEqual([REP_A]);
    // Not lost, just not attributed to a row that would say nothing else.
    expect(result.embargoed).toBe(2);
  });

  it("says nothing at all about a call that was never in this reader's scope", () => {
    const result = repCallAggregates(
      [
        call({ repUserId: REP_A }),
        /**
         * What a rep holding only `crm:call-analysis:view` sees of a colleague's
         * settled call. It must not become a row, and it must not become a
         * number either: `embargoed: 2` on a rep's own page is a report of how
         * busy the rest of the team was.
         */
        call({ repUserId: REP_B, visibility: OUT_OF_SCOPE }),
        call({ repUserId: REP_B, visibility: OUT_OF_SCOPE }),
      ],
      window30,
    );

    expect(result.reps.map((rep) => rep.repUserId)).toEqual([REP_A]);
    expect(result.embargoed).toBe(0);
    expect(result.unattributed).toBe(0);
  });

  it("counts an unattributed call without giving it a rep row", () => {
    const result = repCallAggregates(
      [call({ repUserId: REP_A }), call({ repUserId: null }), call({ repUserId: null })],
      window30,
    );

    expect(result.reps).toHaveLength(1);
    expect(result.unattributed).toBe(2);
  });

  it("tells a rep how much of their own period is still embargoed", () => {
    const result = repCallAggregates(
      [
        call({ repUserId: REP_A }),
        call({ repUserId: REP_A }),
        call({ repUserId: REP_A, visibility: IN_WINDOW }),
      ],
      window30,
    );

    expect(result.reps[0]!.callsAnalysed).toBe(2);
    expect(result.reps[0]!.embargoed).toBe(1);
  });

  it("takes the median rather than the mean, so one bad transcript does not move it", () => {
    const result = repCallAggregates(
      [
        call({ talkRatioBps: 4800 }),
        call({ talkRatioBps: 5000 }),
        call({ talkRatioBps: 5200 }),
        /** A transcript where the model mislabelled the speakers. */
        call({ talkRatioBps: 9900 }),
        call({ talkRatioBps: 5100 }),
      ],
      window30,
    );

    // The mean would be 6000. The median describes how this rep actually talks.
    expect(result.reps[0]!.medianTalkRatioBps).toBe(5100);
  });

  it("reports a call with no speaker attribution instead of banding it as zero", () => {
    const result = repCallAggregates(
      [
        call({ talkRatioBps: 5000, repTurnCount: 10, repQuestionCount: 2 }),
        call({ talkRatioBps: null, repTurnCount: null, repQuestionCount: null }),
      ],
      window30,
    );

    const rep = result.reps[0]!;
    expect(rep.callsAnalysed).toBe(2);
    expect(rep.withoutSpeakerMetrics).toBe(1);
    expect(rep.medianTalkRatioBps).toBe(5000);
  });

  it("keeps next-step capture over every visible call, diarised or not", () => {
    const result = repCallAggregates(
      [
        call({ nextStepCommitted: true }),
        call({
          nextStepCommitted: true,
          talkRatioBps: null,
          repTurnCount: null,
          repQuestionCount: null,
        }),
        call({ nextStepCommitted: false }),
        call({ nextStepCommitted: false }),
      ],
      window30,
    );

    // 2 of 4, not 1 of 3: whether a next step was agreed does not need speaker
    // labels, so excluding the undiarised call would understate the rep.
    expect(result.reps[0]!.nextStepCommittedBps).toBe(5000);
  });

  it("has no median for a rep whose calls were all undiarised", () => {
    const result = repCallAggregates(
      [call({ talkRatioBps: null, repTurnCount: null, repQuestionCount: null })],
      window30,
    );

    const rep = result.reps[0]!;
    expect(rep.medianTalkRatioBps).toBeNull();
    expect(rep.medianQuestionRateBps).toBeNull();
  });

  it("derives the question rate from the two counts", () => {
    const result = repCallAggregates(
      [call({ repTurnCount: 10, repQuestionCount: 3 }), call({ repTurnCount: 20, repQuestionCount: 3 })],
      window30,
    );

    // 3000 and 1500 bps; the median of two is their mean.
    expect(result.reps[0]!.medianQuestionRateBps).toBe(2250);
  });

  it("emits every bucket in the window, including the empty ones", () => {
    const result = repCallAggregates([call({ analysedAt: new Date(NOW.getTime() - 2 * DAY) })], {
      since: new Date(NOW.getTime() - 28 * DAY),
      until: NOW,
      bucket: "week",
    });

    const trend = result.reps[0]!.trend;
    expect(trend).toHaveLength(4);
    // Oldest first, and the call lands in the most recent bucket.
    expect(trend.map((point) => point.calls)).toEqual([0, 0, 0, 1]);
    // An empty bucket reports no median, never a zero that reads as silence.
    expect(trend[0]!.medianTalkRatioBps).toBeNull();
  });

  it("puts a call landing on a bucket edge in exactly one bucket", () => {
    const buckets = trendBuckets({
      since: new Date(NOW.getTime() - 14 * DAY),
      until: NOW,
      bucket: "week",
    });
    const edge = buckets[1]!.start;

    const result = repCallAggregates([call({ analysedAt: edge })], {
      since: new Date(NOW.getTime() - 14 * DAY),
      until: NOW,
      bucket: "week",
    });

    expect(result.reps[0]!.trend.map((point) => point.calls)).toEqual([0, 1]);
  });

  it("chooses the bucket width from the window rather than taking it from a caller", () => {
    expect(trendBucketFor(7)).toBe("day");
    expect(trendBucketFor(14)).toBe("day");
    expect(trendBucketFor(15)).toBe("week");
    expect(trendBucketFor(90)).toBe("week");

    // The bound that keeps a response's size predictable: no window produces
    // more points than this, whichever width it lands on.
    expect(trendBuckets({ since: new Date(NOW.getTime() - 90 * DAY), until: NOW, bucket: "week" }))
      .toHaveLength(13);
    expect(trendBuckets({ since: new Date(NOW.getTime() - 14 * DAY), until: NOW, bucket: "day" }))
      .toHaveLength(14);
  });

  it("orders reps by how much of the window is theirs, not by any metric", () => {
    const result = repCallAggregates(
      [
        call({ repUserId: REP_B, talkRatioBps: 5000 }),
        call({ repUserId: REP_A, talkRatioBps: 9000 }),
        call({ repUserId: REP_A, talkRatioBps: 9000 }),
      ],
      window30,
    );

    // Rep A leads on call count while holding the worse talk ratio, which is the
    // point: the order is not a league table.
    expect(result.reps.map((rep) => rep.repUserId)).toEqual([REP_A, REP_B]);
  });
});
