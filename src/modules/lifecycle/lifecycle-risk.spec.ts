import {
  AT_RISK_THRESHOLD,
  DEFAULT_SIGNAL_IMPACT,
  MAX_RENEWAL_PRESSURE,
  OVERDUE_RENEWAL_PRESSURE,
  RENEWAL_PRESSURE_WINDOW_DAYS,
  SIGNAL_WINDOW_DAYS,
  WATCH_THRESHOLD,
  clampImpact,
  decayFactor,
  impactFor,
  renewalPressure,
  riskBand,
  riskScore,
} from "./lifecycle-risk";
import { LIFECYCLE_SIGNAL_KINDS } from "../../db/schema/crm/lifecycle";

const NOW = new Date("2026-08-27T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY);

/** A renewal far enough out that the calendar contributes nothing. */
const FAR_RENEWAL = "2027-08-27";

describe("decayFactor", () => {
  it("weighs today's evidence in full", () => {
    expect(decayFactor(0)).toBe(1);
  });

  /**
   * The property, not a value: the score must fall as evidence ages, or a
   * customer who had one bad week is flagged forever and the ranking stops
   * separating anybody.
   */
  it("falls monotonically across the window", () => {
    const factors = [0, 15, 30, 45, 60, 75, 89].map(decayFactor);
    for (let i = 1; i < factors.length; i += 1) {
      expect(factors[i]!).toBeLessThan(factors[i - 1]!);
    }
  });

  /**
   * Exactly zero at the edge, not asymptotically near it. This is why the decay
   * is linear rather than a half-life: a signal outside the window has to
   * contribute nothing at all, so the windowed query in `rescore` and this
   * function agree about which rows matter.
   */
  it("reaches exactly zero at the window edge and stays there", () => {
    expect(decayFactor(SIGNAL_WINDOW_DAYS)).toBe(0);
    expect(decayFactor(SIGNAL_WINDOW_DAYS + 400)).toBe(0);
  });

  /**
   * Clock skew between nodes and a rep filing something they have already agreed
   * both produce a future timestamp. Discounting it would drop the newest
   * evidence there is.
   */
  it("weighs a future observation in full rather than discounting it", () => {
    expect(decayFactor(-5)).toBe(1);
  });
});

describe("renewalPressure", () => {
  it("adds nothing while the renewal is beyond the pressure window", () => {
    expect(renewalPressure(FAR_RENEWAL, "active", NOW)).toBe(0);
  });

  it("rises as the renewal approaches, bounded by MAX_RENEWAL_PRESSURE", () => {
    const inDays = (days: number): string =>
      new Date(NOW.getTime() + days * DAY).toISOString().slice(0, 10);

    // Just inside the window contributes nothing at all — 15 points spread over
    // 60 days rounds to zero for the first fortnight of it, and that is correct:
    // the calendar should not start nudging the ordering two months out.
    expect(renewalPressure(inDays(RENEWAL_PRESSURE_WINDOW_DAYS - 1), "active", NOW)).toBe(0);

    const far = renewalPressure(inDays(45), "active", NOW);
    const near = renewalPressure(inDays(5), "active", NOW);

    expect(far).toBeGreaterThan(0);
    expect(near).toBeGreaterThan(far);
    expect(near).toBeLessThanOrEqual(MAX_RENEWAL_PRESSURE);
  });

  /**
   * A renewal date in the past on a still-active contract is not proximity — it
   * is a term nobody renewed and nobody closed. Either it is lost revenue or the
   * book is not being maintained, and both deserve the top of the calendar's
   * range.
   */
  it("treats a renewal date that has passed as the strongest calendar signal", () => {
    expect(renewalPressure("2026-08-01", "active", NOW)).toBe(OVERDUE_RENEWAL_PRESSURE);
  });

  /**
   * The failure this guard prevents: a churned contract's renewal date is
   * permanently in the past, so without the status check every dead customer
   * would sit at the top of the at-risk list forever.
   */
  it.each(["churned", "cancelled"])("contributes nothing once the contract is %s", (status) => {
    expect(renewalPressure("2026-08-01", status, NOW)).toBe(0);
  });

  it("contributes nothing when the stored date is unreadable", () => {
    expect(renewalPressure("whenever", "active", NOW)).toBe(0);
  });
});

describe("riskScore", () => {
  const score = (signals: { impact: number; observedAt: Date }[], renewalOn = FAR_RENEWAL) =>
    riskScore({ signals, renewalOn, status: "active", asOf: NOW });

  it("is zero for a customer nothing has been observed about", () => {
    expect(score([])).toBe(0);
  });

  it("weighs a fresh escalation more than an old one", () => {
    const fresh = score([{ impact: 40, observedAt: daysAgo(1) }]);
    const old = score([{ impact: 40, observedAt: daysAgo(80) }]);
    expect(fresh).toBeGreaterThan(old);
  });

  it("ignores evidence older than the window entirely", () => {
    expect(score([{ impact: 90, observedAt: daysAgo(SIGNAL_WINDOW_DAYS + 1) }])).toBe(0);
  });

  /**
   * The reason impacts are signed. A model that can only accumulate harm has no
   * way to represent a customer who escalated in spring and signed an expansion
   * in summer, and would keep flagging them until the escalation aged out.
   */
  it("lets good news pull the score back down", () => {
    const bad = [{ impact: 60, observedAt: daysAgo(2) }];
    const recovered = [...bad, { impact: -40, observedAt: daysAgo(1) }];
    expect(score(recovered)).toBeLessThan(score(bad));
  });

  /**
   * Clamped at both ends. Below zero there is no column to hold it and no
   * ordering it could express; above 100 a wall of bad news would make every
   * troubled customer indistinguishable from every other.
   */
  it("never leaves 0..100 however much evidence piles up", () => {
    const allBad = Array.from({ length: 20 }, () => ({ impact: 100, observedAt: NOW }));
    const allGood = Array.from({ length: 20 }, () => ({ impact: -100, observedAt: NOW }));
    expect(score(allBad)).toBe(100);
    expect(score(allGood)).toBe(0);
  });

  /**
   * The calendar orders a quiet book without ever inventing an alarm in it: two
   * customers with no signals differ by their renewal dates, and neither reaches
   * the watch band on proximity alone.
   */
  it("orders a signal-free book by renewal proximity without raising a band", () => {
    const soon = riskScore({
      signals: [],
      renewalOn: new Date(NOW.getTime() + 3 * DAY).toISOString().slice(0, 10),
      status: "active",
      asOf: NOW,
    });
    const later = score([]);

    expect(soon).toBeGreaterThan(later);
    expect(riskBand(soon)).toBe("healthy");
  });

  it("returns a whole number, because the column is an integer", () => {
    const value = score([{ impact: 37, observedAt: daysAgo(13) }]);
    expect(Number.isInteger(value)).toBe(true);
  });
});

describe("riskBand", () => {
  it("splits at the stated thresholds and nowhere else", () => {
    expect(riskBand(WATCH_THRESHOLD - 1)).toBe("healthy");
    expect(riskBand(WATCH_THRESHOLD)).toBe("watch");
    expect(riskBand(AT_RISK_THRESHOLD - 1)).toBe("watch");
    expect(riskBand(AT_RISK_THRESHOLD)).toBe("at-risk");
  });
});

describe("impactFor", () => {
  /**
   * Every kind needs a default. A kind added to the vocabulary without one would
   * silently file as zero — a signal that appears in the history, changes
   * nothing, and makes the score look broken to whoever filed it.
   */
  it("has a default for every kind in the vocabulary", () => {
    for (const kind of LIFECYCLE_SIGNAL_KINDS) {
      expect(DEFAULT_SIGNAL_IMPACT[kind]).toBeDefined();
    }
  });

  it("uses the kind's default when the caller states nothing", () => {
    expect(impactFor("champion-departed", null)).toBe(
      DEFAULT_SIGNAL_IMPACT["champion-departed"],
    );
  });

  it("prefers a stated impact, so a producer that measured something can say so", () => {
    expect(impactFor("usage-decline", 8)).toBe(8);
  });

  /** Zero is a real answer, not an absent one. */
  it("respects a stated zero rather than falling back to the default", () => {
    expect(impactFor("support-escalation", 0)).toBe(0);
  });

  it("clamps a stated impact into the range the column accepts", () => {
    expect(impactFor("note", 5000)).toBe(100);
    expect(impactFor("note", -5000)).toBe(-100);
    expect(clampImpact(12.6)).toBe(13);
  });

  /**
   * The direction of each default is the argument, not its magnitude. If a
   * renewal commitment ever stopped being evidence *against* churn the score
   * would rise when a customer confirmed they were staying.
   */
  it("keeps good news negative and bad news positive", () => {
    expect(DEFAULT_SIGNAL_IMPACT["renewal-commitment"]).toBeLessThan(0);
    expect(DEFAULT_SIGNAL_IMPACT["expansion-interest"]).toBeLessThan(0);
    expect(DEFAULT_SIGNAL_IMPACT["champion-departed"]).toBeGreaterThan(0);
    expect(DEFAULT_SIGNAL_IMPACT["usage-decline"]).toBeGreaterThan(0);
  });
});
