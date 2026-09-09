import {
  SWEEP_EXPECTED_WITHIN_HOURS,
  sweepStaleness,
} from "../sign-sweep-staleness";

/**
 * SIGN-P1-02. The same four cases `alert-sign-sweep-stale.mjs --self-test`
 * covers, held against the TypeScript copy the admin screen reads.
 *
 * Two implementations exist because a `.mjs` alert script and the Nest runtime
 * cannot share a module. Two implementations are exactly how a judgement drifts,
 * so both are pinned to the same cases — and if one of these files changes, the
 * other has to.
 */

const NOW = new Date("2026-09-09T12:00:00.000Z");
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000);

describe("sweepStaleness", () => {
  it("is ok for a run inside the window", () => {
    expect(sweepStaleness({ ranAt: hoursAgo(1), error: null }, NOW)).toBe("ok");
    expect(sweepStaleness({ ranAt: hoursAgo(SWEEP_EXPECTED_WITHIN_HOURS - 1), error: null }, NOW)).toBe("ok");
  });

  it("is stale once the window has passed", () => {
    expect(sweepStaleness({ ranAt: hoursAgo(SWEEP_EXPECTED_WITHIN_HOURS + 1), error: null }, NOW)).toBe("stale");
  });

  it("reports never_run separately from stale", () => {
    /**
     * The state SignOS was actually in, and the one a `ran_at < …` query
     * cannot see. It calls for a different action than a stopped scheduler —
     * the scheduler was never pointed here at all — so it is not folded in.
     */
    expect(sweepStaleness(null, NOW)).toBe("never_run");
    expect(sweepStaleness({ ranAt: null, error: null }, NOW)).toBe("never_run");
  });

  it("reports a recorded failure however recent the run", () => {
    /** A sweep that ran a minute ago and threw is not healthy. */
    expect(sweepStaleness({ ranAt: hoursAgo(0.01), error: "no tenant context" }, NOW)).toBe("errored");
  });

  it("treats an unparseable timestamp as never run, not as fresh", () => {
    /** `NaN > window` is false, so the naive comparison would answer "ok". */
    expect(sweepStaleness({ ranAt: "not a date", error: null }, NOW)).toBe("never_run");
  });

  it("accepts an ISO string as well as a Date", () => {
    expect(sweepStaleness({ ranAt: hoursAgo(1).toISOString(), error: null }, NOW)).toBe("ok");
  });

  it("does not alert on ordinary daily jitter", () => {
    /**
     * A sweep scheduled daily that lands 25 hours after the last one is late,
     * not broken. An alert that fires on that is one nobody reads.
     */
    expect(SWEEP_EXPECTED_WITHIN_HOURS).toBeGreaterThan(24);
    expect(sweepStaleness({ ranAt: hoursAgo(25), error: null }, NOW)).toBe("ok");
  });
});
