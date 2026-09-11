import type { CallAnalysisVisibility } from "./call-analysis-visibility";
import {
  COACHING_MIN_COHORT,
  coachingDigest,
  type CoachableAnalysis,
  type CoachingCandidate,
} from "./call-coaching";

/**
 * The property on trial: a manager's aggregate must not reconstruct an analysis
 * the rep has not released.
 *
 * There are two ways it could, and both are asserted rather than argued.
 *
 * The direct way is counting an embargoed row. The subtle one is differencing —
 * a manager who watches the digest across a day sees the cohort grow by one and
 * every band shift, and one released analysis plus that delta reproduces the
 * withheld one. The test named "changes nothing but the embargoed count" is the
 * one that closes it: adding a withheld analysis must move exactly one number,
 * and that number carries no metric.
 *
 * The third way, a cohort so small the aggregate IS the calls, is closed by
 * suppression below the minimum rather than by a caveat in a docblock.
 */

const VISIBLE: CallAnalysisVisibility = { visible: true, reason: "own-call", opensAt: null };
const EMBARGOED: CallAnalysisVisibility = {
  visible: false,
  reason: "rep-window",
  opensAt: new Date("2026-08-21T09:00:00.000Z"),
};

const analysis = (over: Partial<CoachableAnalysis> = {}): CoachableAnalysis => ({
  talkRatioBps: 5200,
  repTurnCount: 10,
  repQuestionCount: 3,
  objectionHandlings: [],
  competitorsNamed: [],
  nextStepCommitted: false,
  ...over,
});

const seen = (over: Partial<CoachableAnalysis> = {}): CoachingCandidate => ({
  analysis: analysis(over),
  visibility: VISIBLE,
});

const withheld = (over: Partial<CoachableAnalysis> = {}): CoachingCandidate => ({
  analysis: analysis(over),
  visibility: EMBARGOED,
});

/** A cohort exactly at the minimum, so a single addition crosses no threshold. */
const cohort = (): CoachingCandidate[] =>
  Array.from({ length: COACHING_MIN_COHORT }, () => seen());

describe("an embargoed analysis is not in the aggregate", () => {
  it("changes nothing but the embargoed count when one is added", () => {
    const without = coachingDigest(cohort());
    const withOne = coachingDigest([
      ...cohort(),
      /**
       * Deliberately extreme and unlike the rest: an 89% talk ratio, an
       * unaddressed objection, a named rival and a committed next step. If any
       * of it reached a band, a handling count, a competitor row or the
       * next-step rate, the numbers below would differ and a manager could read
       * this rep's call out of the difference.
       */
      withheld({
        talkRatioBps: 8900,
        repTurnCount: 20,
        repQuestionCount: 0,
        objectionHandlings: ["unaddressed"],
        competitorsNamed: ["Acme"],
        nextStepCommitted: true,
      }),
    ]);

    expect(withOne.embargoed).toBe(1);
    expect(without.embargoed).toBe(0);
    expect({ ...withOne, embargoed: 0 }).toEqual({ ...without, embargoed: 0 });
  });

  it("reports a cohort of only the visible analyses", () => {
    const digest = coachingDigest([...cohort(), withheld(), withheld()]);

    expect(digest.cohort).toBe(COACHING_MIN_COHORT);
    expect(digest.embargoed).toBe(2);
  });
});

describe("a cohort too small to summarise is not summarised", () => {
  /**
   * A mean over two calls IS those two calls: one released analysis plus the
   * aggregate reproduces the other exactly. Below the minimum the digest reports
   * its own size and nothing else.
   */
  it("suppresses every metric below the minimum cohort", () => {
    const digest = coachingDigest(
      Array.from({ length: COACHING_MIN_COHORT - 1 }, () =>
        seen({ talkRatioBps: 9000, objectionHandlings: ["unaddressed"], competitorsNamed: ["Acme"] }),
      ),
    );

    expect(digest.suppressed).toBe(true);
    expect(digest.cohort).toBe(COACHING_MIN_COHORT - 1);
    expect(digest.talkRatio).toBeNull();
    expect(digest.questionRate).toBeNull();
    expect(digest.objectionHandling).toBeNull();
    expect(digest.competitors).toBeNull();
    expect(digest.nextStepCommittedBps).toBeNull();
  });

  /**
   * Suppression is a shaped answer, not an exception and not an empty body. A
   * manager with a small team has to be able to tell "not enough calls yet" from
   * "this endpoint is broken", and a client that has to infer that from a thrown
   * error will infer it wrong.
   */
  it("still says how many calls there were, and how many are withheld", () => {
    const digest = coachingDigest([seen(), withheld()]);

    expect(digest.suppressed).toBe(true);
    expect(digest.cohort).toBe(1);
    expect(digest.embargoed).toBe(1);
  });

  it("summarises at exactly the minimum", () => {
    expect(coachingDigest(cohort()).suppressed).toBe(false);
  });
});

describe("what the digest reports, and how", () => {
  it("emits every band including the empty ones", () => {
    const digest = coachingDigest(cohort());

    // Bands are counts over a fixed set of labels. Emitting only the non-empty
    // ones would make "nobody on this team is over 80%" — the good news — look
    // identical to a band the serialiser dropped.
    expect(digest.talkRatio?.map((band) => band.label)).toEqual([
      "under-35pct",
      "35-50pct",
      "50-65pct",
      "65-80pct",
      "over-80pct",
    ]);
    expect(digest.talkRatio?.find((band) => band.label === "over-80pct")?.calls).toBe(0);
    expect(digest.talkRatio?.find((band) => band.label === "50-65pct")?.calls).toBe(
      COACHING_MIN_COHORT,
    );
  });

  /**
   * A transcript with no speaker attribution has no talk ratio — the metric arc
   * is all-or-nothing in the database. Those calls are counted separately rather
   * than dropped: a digest over eleven calls that quietly banded four of them is
   * a chart with a hole nobody can see.
   */
  it("counts calls with no speaker metrics instead of banding them", () => {
    const digest = coachingDigest([
      ...cohort(),
      seen({ talkRatioBps: null, repTurnCount: null, repQuestionCount: null }),
    ]);

    expect(digest.cohort).toBe(COACHING_MIN_COHORT + 1);
    expect(digest.withoutSpeakerMetrics).toBe(1);
    expect(
      digest.talkRatio?.reduce((total, band) => total + band.calls, 0),
    ).toBe(COACHING_MIN_COHORT);
  });

  /** Naming a rival nine times on one call is one call, not nine mentions. */
  it("counts a competitor once per call, however often it was named", () => {
    const digest = coachingDigest([
      ...cohort(),
      seen({ competitorsNamed: ["Acme", "acme", " ACME "] }),
      seen({ competitorsNamed: ["Acme"] }),
    ]);

    expect(digest.competitors).toEqual([{ name: "Acme", calls: 2 }]);
  });

  it("reports the next-step rate in basis points, never a float", () => {
    const digest = coachingDigest([
      seen({ nextStepCommitted: true }),
      seen({ nextStepCommitted: true }),
      seen({ nextStepCommitted: true }),
      seen({ nextStepCommitted: false }),
      seen({ nextStepCommitted: false }),
      seen({ nextStepCommitted: false }),
    ]);

    // 3 of 6. Integer basis points, so nothing downstream has to agree on
    // rounding a rate that will be shown next to a count.
    expect(digest.nextStepCommittedBps).toBe(5000);
    expect(Number.isInteger(digest.nextStepCommittedBps)).toBe(true);
  });

  /**
   * A rep with no turns has no question rate. Dividing would be 0/0, which lands
   * in the lowest band and reads as "asked no questions" — a coaching
   * conversation started by an arithmetic accident.
   */
  it("does not band a question rate it cannot compute", () => {
    const digest = coachingDigest([
      ...cohort(),
      seen({ talkRatioBps: 0, repTurnCount: 0, repQuestionCount: 0 }),
    ]);

    expect(
      digest.questionRate?.reduce((total, band) => total + band.calls, 0),
    ).toBe(COACHING_MIN_COHORT);
  });

  /**
   * The structural guarantee, asserted end to end rather than trusted to the
   * type. `CoachableAnalysis` has no quote field, no next-step text and no
   * identifier, so verbatim customer speech cannot reach a manager's aggregate —
   * this walks the serialised digest to prove nothing resembling one is in it.
   */
  it("carries no free text out of any call", () => {
    const digest = coachingDigest([
      ...cohort(),
      seen({ objectionHandlings: ["deflected"], competitorsNamed: ["Acme"], nextStepCommitted: true }),
    ]);

    const strings: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === "string") strings.push(node);
      else if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === "object") Object.values(node).forEach(walk);
    };
    walk(digest);

    // Band labels, objection handlings and rival names — a closed vocabulary
    // plus proper nouns. Nothing a customer said, and nothing longer than a name.
    for (const value of strings) expect(value.length).toBeLessThanOrEqual(40);
    expect(strings).toContain("Acme");
    expect(strings.some((value) => value.includes(" "))).toBe(false);
  });
});
