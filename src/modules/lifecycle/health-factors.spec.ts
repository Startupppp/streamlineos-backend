import {
  HEALTH_WINDOW_DAYS,
  engagementFactor,
  healthWindow,
  sentimentFactor,
  supportFactor,
  usageFactor,
} from "./health-factors";

/**
 * The measurement rules, exercised at the boundary that actually matters: the
 * line between "we measured nothing" and "we measured, and it was nothing".
 *
 * Every case below names the way the score lies if the rule is inverted, because
 * both inversions are plausible-looking one-line changes and both are how a
 * health score comes to say the opposite of the truth.
 */

const AS_OF = new Date("2026-08-27T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(AS_OF.getTime() - days * DAY);

const ENGAGEMENT_WINDOW = healthWindow(HEALTH_WINDOW_DAYS.engagement, AS_OF);
const SUPPORT_WINDOW = healthWindow(HEALTH_WINDOW_DAYS.support, AS_OF);
const SENTIMENT_WINDOW = healthWindow(HEALTH_WINDOW_DAYS.sentiment, AS_OF);
const USAGE_WINDOW = healthWindow(HEALTH_WINDOW_DAYS.usage, AS_OF);

describe("the windows", () => {
  /**
   * Support and sentiment are read over twice the span of engagement and usage
   * because tickets and survey verdicts are sparse. Collapsing them to one
   * window would make the sparse pair permanently missing or the dense pair
   * permanently forgiving — the reason each factor row stores its own.
   */
  it("does not give the four inputs the same memory", () => {
    expect(HEALTH_WINDOW_DAYS.support).toBeGreaterThan(HEALTH_WINDOW_DAYS.engagement);
    expect(HEALTH_WINDOW_DAYS.sentiment).toBeGreaterThan(HEALTH_WINDOW_DAYS.usage);
  });

  it("spans back from the moment it was asked", () => {
    const window = healthWindow(90, AS_OF);
    expect(window.to).toEqual(AS_OF);
    expect(window.from).toEqual(daysAgo(90));
    expect(window.days).toBe(90);
  });
});

describe("engagement", () => {
  /**
   * The asymmetry, first direction. A tenant that has not adopted the timeline
   * has no activity for anybody; reporting that as silence would drop every one
   * of its customers into the critical band on the day they sign up.
   */
  it("is missing, not silent, when the organisation records no activity at all", () => {
    const factor = engagementFactor(
      { sourceInUse: false, activityCount: 0, contactDays: 0, lastActivityAt: null },
      ENGAGEMENT_WINDOW,
    );
    expect(factor.status).toBe("missing");
    expect(factor.status === "missing" && factor.reason).toBe("no-source");
  });

  /**
   * The asymmetry, second direction, and the one that is easy to get wrong. In
   * a tenant that DOES record activity, a customer with none is not an
   * unmeasured customer — silence is the measurement, and treating it as a gap
   * would hide the customers who have gone quiet, which is the single strongest
   * warning the timeline produces.
   */
  it("scores silence as silence when the organisation does record activity", () => {
    const factor = engagementFactor(
      { sourceInUse: true, activityCount: 0, contactDays: 0, lastActivityAt: null },
      ENGAGEMENT_WINDOW,
    );
    expect(factor.status).toBe("measured");
    expect(factor.status === "measured" && factor.value).toBe(0);
  });

  it("is perfect for recent contact at the expected cadence", () => {
    const factor = engagementFactor(
      {
        sourceInUse: true,
        activityCount: 11,
        contactDays: 6,
        lastActivityAt: daysAgo(1),
      },
      ENGAGEMENT_WINDOW,
    );
    expect(factor.status === "measured" && factor.value).toBe(100);
  });

  /**
   * Counting rows rather than days would score one ingested mail thread as a
   * quarter of daily contact. The distinct-day count is what makes cadence mean
   * recurrence rather than volume.
   */
  it("does not let a burst of rows on one day look like a cadence", () => {
    const burst = engagementFactor(
      {
        sourceInUse: true,
        activityCount: 40,
        contactDays: 1,
        lastActivityAt: daysAgo(1),
      },
      ENGAGEMENT_WINDOW,
    );
    const spread = engagementFactor(
      {
        sourceInUse: true,
        activityCount: 6,
        contactDays: 6,
        lastActivityAt: daysAgo(1),
      },
      ENGAGEMENT_WINDOW,
    );
    expect(burst.status === "measured" && burst.value).toBeLessThan(
      spread.status === "measured" ? spread.value : 0,
    );
  });

  /**
   * Recency alone is not engagement. A customer emailed once yesterday after
   * three months of nothing should not outrank one in steady contact — this is
   * what the two-half average buys.
   */
  it("halves the score for one recent touch after a quiet quarter", () => {
    const factor = engagementFactor(
      {
        sourceInUse: true,
        activityCount: 1,
        contactDays: 1,
        lastActivityAt: daysAgo(0),
      },
      ENGAGEMENT_WINDOW,
    );
    // recency 100, cadence 1 of 6 expected → 17 → (100+17)/2
    expect(factor.status === "measured" && factor.value).toBe(59);
  });

  it("gives contact older than the window no recency at all", () => {
    const factor = engagementFactor(
      {
        sourceInUse: true,
        activityCount: 0,
        contactDays: 0,
        lastActivityAt: daysAgo(120),
      },
      ENGAGEMENT_WINDOW,
    );
    expect(factor.status === "measured" && factor.value).toBe(0);
    expect(factor.detail.daysSinceLastActivity).toBe(120);
  });
});

describe("support", () => {
  it("is missing when no ticket in the organisation is anchored to a customer", () => {
    const factor = supportFactor(
      { sourceInUse: false, opened: 0, urgent: 0, slaBreached: 0, openNow: 0 },
      SUPPORT_WINDOW,
    );
    expect(factor.status === "missing" && factor.reason).toBe("no-source");
  });

  /**
   * The mirror of the engagement case: in a tenant that runs a helpdesk, a
   * customer with no tickets has had no service failures, and that is a
   * measurement and a good one. Reporting it as a gap would make every
   * trouble-free customer unscoreable.
   */
  it("scores a customer with no service failures as healthy, not unmeasured", () => {
    const factor = supportFactor(
      { sourceInUse: true, opened: 0, urgent: 0, slaBreached: 0, openNow: 0 },
      SUPPORT_WINDOW,
    );
    expect(factor.status).toBe("measured");
    expect(factor.status === "measured" && factor.value).toBe(100);
  });

  /**
   * A heavy user files tickets. Without the volume cap they would outrank a
   * customer with a single unresolved breach of an urgent commitment, which
   * inverts the thing the input is for.
   */
  it("caps volume so a heavy user does not outrank a breached commitment", () => {
    const chatty = supportFactor(
      { sourceInUse: true, opened: 40, urgent: 0, slaBreached: 0, openNow: 2 },
      SUPPORT_WINDOW,
    );
    const breached = supportFactor(
      { sourceInUse: true, opened: 2, urgent: 2, slaBreached: 2, openNow: 2 },
      SUPPORT_WINDOW,
    );
    expect(chatty.status === "measured" && chatty.value).toBe(70);
    expect(breached.status === "measured" && breached.value).toBeLessThan(
      chatty.status === "measured" ? chatty.value : 0,
    );
  });

  it("bottoms out rather than going negative", () => {
    const factor = supportFactor(
      { sourceInUse: true, opened: 20, urgent: 10, slaBreached: 10, openNow: 8 },
      SUPPORT_WINDOW,
    );
    expect(factor.status === "measured" && factor.value).toBe(0);
  });
});

describe("sentiment", () => {
  it("is missing when nothing in the organisation has ever been analysed", () => {
    const factor = sentimentFactor(
      { sourceInUse: false, positive: 0, neutral: 0, negative: 0, observedEver: false },
      SENTIMENT_WINDOW,
    );
    expect(factor.status === "missing" && factor.reason).toBe("no-source");
  });

  /**
   * Never asked is not neutral. `cs-health.service.ts` scores both as 50, so a
   * customer nobody has ever surveyed is stored identically to one whose survey
   * came back neutral — and the gap in the data never gets fixed, because
   * nothing ever reports one.
   */
  it("separates never-asked from asked-and-neutral", () => {
    const neverAsked = sentimentFactor(
      { sourceInUse: true, positive: 0, neutral: 0, negative: 0, observedEver: false },
      SENTIMENT_WINDOW,
    );
    const neutral = sentimentFactor(
      { sourceInUse: true, positive: 0, neutral: 4, negative: 0, observedEver: true },
      SENTIMENT_WINDOW,
    );

    expect(neverAsked.status === "missing" && neverAsked.reason).toBe("no-observations");
    expect(neutral.status).toBe("measured");
    expect(neutral.status === "measured" && neutral.value).toBe(50);
  });

  /**
   * And a third fact: analysed, but not recently. A customer who was cheerful
   * eight months ago is not currently cheerful, and the fix for that gap —
   * talk to them — is different from the fix for never having asked.
   */
  it("calls an old verdict stale rather than current", () => {
    const factor = sentimentFactor(
      { sourceInUse: true, positive: 0, neutral: 0, negative: 0, observedEver: true },
      SENTIMENT_WINDOW,
    );
    expect(factor.status === "missing" && factor.reason).toBe("stale");
  });

  it("is the mean verdict over the window", () => {
    const factor = sentimentFactor(
      { sourceInUse: true, positive: 2, neutral: 1, negative: 1, observedEver: true },
      SENTIMENT_WINDOW,
    );
    // (2*100 + 1*50 + 1*0) / 4 = 62.5
    expect(factor.status === "measured" && factor.value).toBe(63);
    expect(factor.status === "measured" && factor.observations).toBe(4);
  });
});

describe("usage", () => {
  it("is missing when nobody in the organisation has ever filed a usage observation", () => {
    const factor = usageFactor(
      { sourceInUse: false, observationCount: 0, declineImpact: 0, observedEver: false },
      USAGE_WINDOW,
    );
    expect(factor.status === "missing" && factor.reason).toBe("no-source");
  });

  /**
   * The most important refusal in the file. There is no product telemetry in
   * this schema, so an unobserved customer is unobserved — scoring them 100
   * would make every customer nobody is watching look excellent, which is
   * exactly the population this feature exists to surface.
   */
  it("refuses to read no observation as healthy usage", () => {
    const factor = usageFactor(
      { sourceInUse: true, observationCount: 0, declineImpact: 0, observedEver: false },
      USAGE_WINDOW,
    );
    expect(factor.status).toBe("missing");
    expect(factor.status === "missing" && factor.reason).toBe("no-observations");
  });

  it("calls an observation older than the window stale rather than absent", () => {
    const factor = usageFactor(
      { sourceInUse: true, observationCount: 0, declineImpact: 0, observedEver: true },
      USAGE_WINDOW,
    );
    expect(factor.status === "missing" && factor.reason).toBe("stale");
  });

  it("subtracts the decline that was actually stated", () => {
    const factor = usageFactor(
      { sourceInUse: true, observationCount: 1, declineImpact: 30, observedEver: true },
      USAGE_WINDOW,
    );
    expect(factor.status === "measured" && factor.value).toBe(70);
    expect(factor.detail.declineImpact).toBe(30);
  });

  it("bottoms out at zero rather than going negative on a pile of declines", () => {
    const factor = usageFactor(
      { sourceInUse: true, observationCount: 5, declineImpact: 150, observedEver: true },
      USAGE_WINDOW,
    );
    expect(factor.status === "measured" && factor.value).toBe(0);
  });
});
