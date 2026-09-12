import {
  EXEMPLAR_MIN_REP_TURNS,
  EXEMPLAR_TALK_RATIO_TARGET_BPS,
  selectCallExemplars,
  type ExemplarCandidate,
} from "./call-exemplars";

/**
 * What "best" is allowed to mean, asserted case by case.
 *
 * The ranking is the half of CRM-P2-06 that is easy to get plausibly wrong: an
 * implementation that sorted talk ratio descending would compile, would return
 * five calls, and would recommend the five worst conversations the team had. So
 * every test below names the call that must NOT win as well as the one that must.
 *
 * Consent and visibility are absent from this file on purpose — they are not
 * this function's to enforce and it has no way to reach them.
 * `call-exemplars.service.spec.ts` proves the service never hands a refused call
 * in.
 */

const ANALYSED = new Date("2026-09-08T09:00:00.000Z");

const candidate = (over: Partial<ExemplarCandidate> & { activityId: string }): ExemplarCandidate => ({
  repUserId: "user-rep-a",
  occurredAt: new Date("2026-09-08T08:00:00.000Z"),
  analysedAt: ANALYSED,
  talkRatioBps: 5000,
  repTurnCount: 12,
  repQuestionCount: 4,
  nextStepCommitted: false,
  ...over,
});

describe("best-call exemplar selection", () => {
  describe("talk ratio", () => {
    it("ranks by closeness to the target, not by the highest number", () => {
      const { exemplars } = selectCallExemplars(
        [
          candidate({ activityId: "monologue", talkRatioBps: 9200 }),
          candidate({ activityId: "balanced", talkRatioBps: 5100 }),
          candidate({ activityId: "silent", talkRatioBps: 400 }),
        ],
        "talk-ratio",
      );

      /**
       * Distances of 100, 4200 and 4600 from the target. The two extremes are
       * both bad calls and the ranking says so — a maximum-first sort would have
       * put `monologue` at the top and `balanced` second, which is the opposite
       * recommendation from the same data.
       */
      expect(exemplars.map((row) => row.activityId)).toEqual(["balanced", "monologue", "silent"]);
      expect(EXEMPLAR_TALK_RATIO_TARGET_BPS).toBe(5000);
    });

    it("refuses a call too short to learn anything from", () => {
      const { exemplars, ineligible } = selectCallExemplars(
        [
          candidate({
            activityId: "greeting",
            talkRatioBps: 5000,
            repTurnCount: EXEMPLAR_MIN_REP_TURNS - 1,
          }),
          candidate({ activityId: "real", talkRatioBps: 5600 }),
        ],
        "talk-ratio",
      );

      // The short call sits exactly on the target and still loses, which is the
      // whole point of the floor: a perfect ratio over five turns is arithmetic,
      // not an example.
      expect(exemplars.map((row) => row.activityId)).toEqual(["real"]);
      expect(ineligible).toBe(1);
    });

    it("counts an undiarised call as unmeasurable rather than ranking it last", () => {
      const { exemplars, ineligible } = selectCallExemplars(
        [
          candidate({ activityId: "no-labels", talkRatioBps: null }),
          candidate({ activityId: "measured", talkRatioBps: 5000 }),
        ],
        "talk-ratio",
      );

      expect(exemplars.map((row) => row.activityId)).toEqual(["measured"]);
      expect(ineligible).toBe(1);
    });

    it("puts the ranked value on the row so a reader can check it", () => {
      const { exemplars } = selectCallExemplars(
        [candidate({ activityId: "one", talkRatioBps: 4800 })],
        "talk-ratio",
      );

      expect(exemplars[0]!.metricValueBps).toBe(4800);
    });
  });

  describe("question rate", () => {
    it("ranks the rep who asked most per turn first", () => {
      const { exemplars } = selectCallExemplars(
        [
          candidate({ activityId: "telling", repTurnCount: 20, repQuestionCount: 1 }),
          candidate({ activityId: "asking", repTurnCount: 10, repQuestionCount: 6 }),
        ],
        "question-rate",
      );

      expect(exemplars.map((row) => row.activityId)).toEqual(["asking", "telling"]);
      // 6 questions over 10 turns, derived through `questionRateBps`.
      expect(exemplars[0]!.metricValueBps).toBe(6000);
    });

    it("applies the same turn floor, so a three-turn call cannot top the list", () => {
      const { exemplars, ineligible } = selectCallExemplars(
        [
          candidate({ activityId: "tiny", repTurnCount: 3, repQuestionCount: 3 }),
          candidate({ activityId: "real", repTurnCount: 10, repQuestionCount: 2 }),
        ],
        "question-rate",
      );

      // A rate of 10000 bps loses to one of 2000 because the first is noise.
      expect(exemplars.map((row) => row.activityId)).toEqual(["real"]);
      expect(ineligible).toBe(1);
    });

    it("breaks a tie with the longer conversation", () => {
      const { exemplars } = selectCallExemplars(
        [
          candidate({ activityId: "short", repTurnCount: 10, repQuestionCount: 3 }),
          candidate({ activityId: "long", repTurnCount: 20, repQuestionCount: 6 }),
        ],
        "question-rate",
      );

      expect(exemplars.map((row) => row.activityId)).toEqual(["long", "short"]);
    });
  });

  describe("next step", () => {
    it("keeps only the calls that ended with a named commitment", () => {
      const { exemplars, ineligible } = selectCallExemplars(
        [
          candidate({ activityId: "committed", nextStepCommitted: true }),
          candidate({ activityId: "polite", nextStepCommitted: false }),
        ],
        "next-step",
      );

      expect(exemplars.map((row) => row.activityId)).toEqual(["committed"]);
      expect(ineligible).toBe(1);
    });

    it("orders by recency, and asserts nothing about how well the step was captured", () => {
      const { exemplars } = selectCallExemplars(
        [
          candidate({
            activityId: "older",
            nextStepCommitted: true,
            analysedAt: new Date("2026-09-01T09:00:00.000Z"),
          }),
          candidate({
            activityId: "newer",
            nextStepCommitted: true,
            analysedAt: new Date("2026-09-07T09:00:00.000Z"),
          }),
        ],
        "next-step",
      );

      expect(exemplars.map((row) => row.activityId)).toEqual(["newer", "older"]);
      // No invented score. The metric is a boolean the row already carries.
      expect(exemplars[0]!.metricValueBps).toBeNull();
    });

    it("accepts a short undiarised call, because the judgement does not need turns", () => {
      const { exemplars } = selectCallExemplars(
        [
          candidate({
            activityId: "quick-booking",
            nextStepCommitted: true,
            talkRatioBps: null,
            repTurnCount: null,
            repQuestionCount: null,
          }),
        ],
        "next-step",
      );

      expect(exemplars.map((row) => row.activityId)).toEqual(["quick-booking"]);
    });
  });

  it("carries no verbatim customer speech of any kind", () => {
    const { exemplars } = selectCallExemplars([candidate({ activityId: "one" })], "talk-ratio");

    /**
     * A structural assertion rather than a behavioural one. The exemplar row is
     * a pointer; the moment a quote, a next-step sentence or an objection
     * appears on it, this endpoint has become a second bulk read of
     * `crm_call_analyses` with a different gate on it.
     */
    expect(Object.keys(exemplars[0]!).sort()).toEqual([
      "activityId",
      "analysedAt",
      "metricValueBps",
      "nextStepCommitted",
      "occurredAt",
      "questionRateBps",
      "repQuestionCount",
      "repTurnCount",
      "repUserId",
      "talkRatioBps",
    ]);
  });
});
