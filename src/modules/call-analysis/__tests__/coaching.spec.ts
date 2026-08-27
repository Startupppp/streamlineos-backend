import {
  coachingPrompts,
  median,
  repTrend,
  startOfIsoWeek,
  teamCoachingView,
  type AnalysedCall,
} from "../coaching";
import { MANAGER_CANNOT_SEE, MANAGER_VISIBILITY, visibilityDisclosure } from "../visibility";

function call(overrides: Partial<AnalysedCall> = {}): AnalysedCall {
  return {
    crmCallAnalysisId: "an-1",
    activityId: "act-1",
    repUserId: "rep-1",
    occurredAt: new Date("2026-08-19T09:00:00.000Z"),
    talkRatioBps: 4_000,
    questionShareBps: 4_000,
    objections: [],
    competitorKeys: [],
    nextStepCommitted: true,
    ...overrides,
  };
}

describe("teamCoachingView — a manager sees a team, not a list of people", () => {
  it("carries no call identifier and no person anywhere in what it returns", () => {
    /**
     * Ticket 02's second criterion, checked as a consequence rather than by
     * reading the type. The distinctive strings below are the identifiers of the
     * calls that went in; if any of them survives into the manager's payload,
     * this surface has become the per-call report the ticket exists to prevent.
     */
    const view = teamCoachingView([
      call({
        crmCallAnalysisId: "ANALYSIS-SECRET",
        activityId: "ACTIVITY-SECRET",
        repUserId: "REP-SECRET",
        talkRatioBps: 9_000,
        objections: [{ theme: "price", quote: "QUOTE-SECRET", handling: "unanswered" }],
        competitorKeys: ["Northwind"],
      }),
      call({ repUserId: "REP-OTHER-SECRET", nextStepCommitted: false }),
    ]);

    const serialised = JSON.stringify(view);
    for (const identifier of [
      "ANALYSIS-SECRET",
      "ACTIVITY-SECRET",
      "REP-SECRET",
      "REP-OTHER-SECRET",
      "QUOTE-SECRET",
    ])
      expect(serialised).not.toContain(identifier);
  });

  it("says how many people a prompt touches without saying which", () => {
    const view = teamCoachingView([
      call({ repUserId: "rep-1", talkRatioBps: 9_000 }),
      call({ repUserId: "rep-2", talkRatioBps: 9_100 }),
      call({ repUserId: "rep-2", talkRatioBps: 3_000 }),
    ]);

    expect(view.prompts).toContainEqual(
      expect.objectContaining({
        kind: "talking-more-than-listening",
        callsAffected: 2,
        repsAffected: 2,
      }),
    );
  });

  it("counts a competitor once per call, not once per mention", () => {
    // A customer who says a name eleven times in one call is one competitive
    // situation; counting utterances makes a single angry call look like a shift.
    const view = teamCoachingView([
      call({ competitorKeys: ["Northwind", "Northwind"] }),
      call({ competitorKeys: ["Northwind"] }),
      call({ competitorKeys: ["Contoso"] }),
    ]);

    expect(view.competitorMentions).toEqual([
      { competitorKey: "Northwind", calls: 2 },
      { competitorKey: "Contoso", calls: 1 },
    ]);
  });

  it("reports objections as raised against unanswered, not as a bare count", () => {
    // A call with five objections all answered went better than a call with one
    // that was ignored, so the count on its own says almost nothing.
    const view = teamCoachingView([
      call({
        objections: [
          { theme: "price", quote: "too expensive", handling: "addressed" },
          { theme: "price", quote: "still too expensive", handling: "unanswered" },
        ],
      }),
    ]);

    expect(view.objectionsByTheme).toEqual([{ theme: "price", raised: 2, unanswered: 1 }]);
  });

  it("leaves the ratios unavailable rather than zero when no call was diarised", () => {
    const view = teamCoachingView([
      call({ talkRatioBps: null, questionShareBps: null }),
      call({ talkRatioBps: null, questionShareBps: null }),
    ]);

    expect(view.medianTalkRatioBps).toBeNull();
    expect(view.medianQuestionShareBps).toBeNull();
  });
});

describe("coachingPrompts", () => {
  it("does not fire the talk-ratio prompt on a call nobody could measure", () => {
    // An undiarised call has no talk ratio. Treating that as zero — or as high —
    // coaches somebody on a number that was never computed.
    expect(coachingPrompts([call({ talkRatioBps: null })])).toEqual([]);
  });

  it("does not fire the next-step prompt while most calls do end in one", () => {
    const calls = [call(), call(), call(), call({ nextStepCommitted: false })];
    expect(coachingPrompts(calls).map((prompt) => prompt.kind)).not.toContain(
      "calls-ending-without-a-next-step",
    );
  });

  it("fires it once most calls do not", () => {
    const calls = [call(), call({ nextStepCommitted: false }), call({ nextStepCommitted: false })];
    expect(coachingPrompts(calls).map((prompt) => prompt.kind)).toContain(
      "calls-ending-without-a-next-step",
    );
  });

  it("tells a rep the same thing it tells their manager about the same calls", () => {
    /**
     * A rep told one thing and a manager told another about the same calls will
     * find out, and the tool loses the only thing it had.
     */
    const calls = [call({ talkRatioBps: 9_000 }), call({ talkRatioBps: 9_500 })];
    expect(teamCoachingView(calls).prompts).toEqual(coachingPrompts(calls));
  });
});

describe("repTrend", () => {
  it("groups a rep's calls by the week they happened in", () => {
    const trend = repTrend([
      call({ occurredAt: new Date("2026-08-18T09:00:00.000Z") }),
      call({ occurredAt: new Date("2026-08-20T09:00:00.000Z") }),
      call({ occurredAt: new Date("2026-08-25T09:00:00.000Z") }),
    ]);

    expect(trend.map((point) => [point.weekStart.toISOString().slice(0, 10), point.calls])).toEqual(
      [
        ["2026-08-17", 2],
        ["2026-08-24", 1],
      ],
    );
  });

  it("omits a week with no calls rather than drawing it as a zero", () => {
    // A week off is not a week the rep talked none of the time.
    const trend = repTrend([
      call({ occurredAt: new Date("2026-08-04T09:00:00.000Z") }),
      call({ occurredAt: new Date("2026-08-25T09:00:00.000Z") }),
    ]);

    expect(trend).toHaveLength(2);
  });

  it("starts a week on Monday, including for a Sunday call", () => {
    expect(startOfIsoWeek(new Date("2026-08-23T23:00:00.000Z")).toISOString()).toBe(
      "2026-08-17T00:00:00.000Z",
    );
  });
});

describe("median", () => {
  it("is unmoved by one long demo where a rep presented throughout", () => {
    // The team did not change, so the number the team is judged on must not.
    expect(median([3_000, 3_500, 4_000, 4_500, 5_000])).toBe(4_000);
    expect(median([3_000, 3_500, 4_000, 4_500, 10_000])).toBe(4_000);
  });

  it("ignores the calls that have no value rather than counting them as zero", () => {
    expect(median([null, 4_000, null, 6_000])).toBe(5_000);
  });

  it("is null when nothing was measurable", () => {
    expect(median([null, null])).toBeNull();
  });
});

describe("what the manager can see is stated to the rep", () => {
  it("names every field the manager surface actually returns", () => {
    /**
     * Ticket 02's third criterion. `MANAGER_VISIBILITY` is typed as a record over
     * the view's own keys, so a field added without a sentence stops the module
     * compiling — and this asserts the other direction, that the disclosure
     * describes nothing the surface does not have.
     */
    const view = teamCoachingView([call()]);
    expect(Object.keys(view).sort()).toEqual(Object.keys(MANAGER_VISIBILITY).sort());
  });

  it("hands the rep both halves of the answer", () => {
    const disclosure = visibilityDisclosure();

    expect(disclosure.managerCanSee).toHaveLength(Object.keys(MANAGER_VISIBILITY).length);
    expect(disclosure.managerCannotSee).toEqual([...MANAGER_CANNOT_SEE]);
    expect(disclosure.summary).toContain("your own calls");
  });

  it("keeps the promise that there is no per-person number to rank on", () => {
    /**
     * `MANAGER_CANNOT_SEE` claims there is no leaderboard because there is
     * nothing to build one from. That claim is only true while the manager view
     * exposes no per-person figure — which is what the identifier test above
     * checks, and what this ties the sentence to.
     */
    const view = teamCoachingView([
      call({ repUserId: "rep-1", talkRatioBps: 9_000 }),
      call({ repUserId: "rep-2", talkRatioBps: 1_000 }),
    ]);

    expect(JSON.stringify(view)).not.toContain("rep-1");
    expect(MANAGER_CANNOT_SEE.join(" ")).toContain("leaderboard");
  });
});
