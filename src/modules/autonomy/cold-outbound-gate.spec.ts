import {
  COLD_BOUNCE_RATE_CEILING,
  COLD_COMPLAINT_RATE_CEILING,
  COLD_MIN_VOLUME_FOR_RATES,
  COLD_RAMP_SCHEDULE,
  coldBlockSummary,
  evaluateColdGate,
  rampCapFor,
  sameDomain,
  sharesReputation,
  warmupDay,
  type ColdTrackFacts,
} from "./cold-outbound-gate";
import { updateAutonomySettingsSchema } from "./dto/autonomy-review.schemas";

const NOW = new Date("2026-08-26T10:00:00.000Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 86_400_000);
}

/** A tenant that has done everything right, so each test can break one thing. */
function facts(overrides: Partial<ColdTrackFacts> = {}): ColdTrackFacts {
  return {
    now: NOW,
    enabled: true,
    pausedAt: null,
    domain: {
      domain: "acme-outreach.com",
      purpose: "cold",
      verifiedAt: daysAgo(30),
      warmupStartedAt: daysAgo(9),
    },
    transactionalDomain: "acme.com",
    sentToday: 0,
    recentSends: 0,
    recentBounces: 0,
    recentComplaints: 0,
    ...overrides,
  };
}

describe("evaluateColdGate — off by default", () => {
  /**
   * The first criterion, and the one a tenant is most likely to reach by
   * accident: everything else configured, nobody ever turned the track on.
   */
  it("refuses when the tenant has not explicitly enabled it", () => {
    expect(evaluateColdGate(facts({ enabled: false }))).toEqual({
      allow: false,
      reason: "not-enabled",
      pauseTrack: false,
    });
  });

  it("refuses on enablement before it complains about anything else", () => {
    expect(
      evaluateColdGate(facts({ enabled: false, domain: null, pausedAt: daysAgo(1) })),
    ).toEqual({ allow: false, reason: "not-enabled", pauseTrack: false });
  });

  it("allows a fully configured, enabled tenant", () => {
    expect(evaluateColdGate(facts())).toEqual({ allow: true, dailyCap: 900, warmupDay: 10 });
  });
});

describe("evaluateColdGate — a warmed domain is required before any volume", () => {
  it("refuses with no domain at all", () => {
    expect(evaluateColdGate(facts({ domain: null }))).toMatchObject({
      allow: false,
      reason: "no-cold-domain",
    });
  });

  it("refuses a domain registered for transactional mail", () => {
    expect(
      evaluateColdGate(
        facts({
          domain: {
            domain: "acme-outreach.com",
            purpose: "transactional",
            verifiedAt: daysAgo(30),
            warmupStartedAt: daysAgo(9),
          },
        }),
      ),
    ).toMatchObject({ allow: false, reason: "no-cold-domain" });
  });

  it("refuses an unverified domain", () => {
    expect(
      evaluateColdGate(
        facts({
          domain: {
            domain: "acme-outreach.com",
            purpose: "cold",
            verifiedAt: null,
            warmupStartedAt: daysAgo(9),
          },
        }),
      ),
    ).toMatchObject({ allow: false, reason: "domain-not-verified" });
  });

  it("refuses a verified domain whose warm-up never started", () => {
    expect(
      evaluateColdGate(
        facts({
          domain: {
            domain: "acme-outreach.com",
            purpose: "cold",
            verifiedAt: daysAgo(30),
            warmupStartedAt: null,
          },
        }),
      ),
    ).toMatchObject({ allow: false, reason: "warmup-not-started" });
  });

  it("refuses a warm-up dated in the future", () => {
    expect(
      evaluateColdGate(
        facts({
          domain: {
            domain: "acme-outreach.com",
            purpose: "cold",
            verifiedAt: daysAgo(30),
            warmupStartedAt: new Date(NOW.getTime() + 86_400_000),
          },
        }),
      ),
    ).toMatchObject({ allow: false, reason: "warmup-not-started" });
  });
});

describe("the ramp schedule", () => {
  it("counts the first day of the warm-up as day one", () => {
    expect(warmupDay(NOW, NOW)).toBe(1);
    expect(warmupDay(daysAgo(1), NOW)).toBe(2);
    expect(warmupDay(daysAgo(9), NOW)).toBe(10);
  });

  it("starts small and rises", () => {
    expect(rampCapFor(1)).toBe(20);
    expect(rampCapFor(2)).toBe(40);
    expect(rampCapFor(5)).toBe(180);
  });

  it("holds at the ceiling rather than rising for ever", () => {
    const ceiling = COLD_RAMP_SCHEDULE[COLD_RAMP_SCHEDULE.length - 1];
    expect(rampCapFor(COLD_RAMP_SCHEDULE.length)).toBe(ceiling);
    expect(rampCapFor(COLD_RAMP_SCHEDULE.length + 500)).toBe(ceiling);
  });

  it("rises monotonically — a ramp that dips is not a ramp", () => {
    for (let i = 1; i < COLD_RAMP_SCHEDULE.length; i += 1)
      expect(COLD_RAMP_SCHEDULE[i]).toBeGreaterThan(COLD_RAMP_SCHEDULE[i - 1]!);
  });

  it("sends nothing on day zero", () => {
    expect(rampCapFor(0)).toBe(0);
    expect(rampCapFor(-3)).toBe(0);
  });

  it("stops at the cap for the day the domain is on", () => {
    expect(evaluateColdGate(facts({ sentToday: 899 }))).toMatchObject({ allow: true });
    expect(evaluateColdGate(facts({ sentToday: 900 }))).toMatchObject({
      allow: false,
      reason: "daily-cap-reached",
    });
  });

  it("gives a brand new domain twenty, not two thousand", () => {
    const brandNew = facts({
      domain: {
        domain: "acme-outreach.com",
        purpose: "cold",
        verifiedAt: daysAgo(1),
        warmupStartedAt: NOW,
      },
      sentToday: 20,
    });
    expect(evaluateColdGate(brandNew)).toMatchObject({
      allow: false,
      reason: "daily-cap-reached",
    });
  });
});

describe("the track cannot borrow the transactional sending reputation", () => {
  it("compares domains case- and dot-insensitively", () => {
    expect(sameDomain("Acme.COM", "acme.com.")).toBe(true);
    expect(sameDomain("acme.com", "acme.net")).toBe(false);
    expect(sameDomain(null, "acme.com")).toBe(false);
  });

  it("refuses the transactional domain itself", () => {
    expect(
      evaluateColdGate(
        facts({
          domain: {
            domain: "acme.com",
            purpose: "cold",
            verifiedAt: daysAgo(30),
            warmupStartedAt: daysAgo(9),
          },
        }),
      ),
    ).toMatchObject({ allow: false, reason: "borrows-transactional-reputation" });
  });

  /**
   * The shape somebody sets up in good faith believing they have separated the
   * two: a subdomain still carries the organisational domain's reputation.
   */
  it("refuses a subdomain of the transactional domain", () => {
    expect(sharesReputation("cold.acme.com", "mail.acme.com")).toBe(true);
    expect(
      evaluateColdGate(
        facts({
          domain: {
            domain: "cold.acme.com",
            purpose: "cold",
            verifiedAt: daysAgo(30),
            warmupStartedAt: daysAgo(9),
          },
          transactionalDomain: "mail.acme.com",
        }),
      ),
    ).toMatchObject({ allow: false, reason: "borrows-transactional-reputation" });
  });

  it("allows a genuinely separate domain", () => {
    expect(sharesReputation("acme-outreach.com", "acme.com")).toBe(false);
    expect(evaluateColdGate(facts()).allow).toBe(true);
  });
});

describe("bounce and complaint thresholds pause the track with nobody deciding", () => {
  it("pauses above the bounce ceiling", () => {
    const verdict = evaluateColdGate(
      facts({ recentSends: 1000, recentBounces: 21, recentComplaints: 0 }),
    );
    expect(verdict).toEqual({ allow: false, reason: "bounce-rate", pauseTrack: true });
    expect(21 / 1000).toBeGreaterThan(COLD_BOUNCE_RATE_CEILING);
  });

  it("pauses above the complaint ceiling, which is far tighter", () => {
    const verdict = evaluateColdGate(
      facts({ recentSends: 1000, recentBounces: 0, recentComplaints: 2 }),
    );
    expect(verdict).toEqual({ allow: false, reason: "complaint-rate", pauseTrack: true });
    expect(2 / 1000).toBeGreaterThan(COLD_COMPLAINT_RATE_CEILING);
  });

  it("does not pause exactly at the ceiling", () => {
    expect(
      evaluateColdGate(facts({ recentSends: 1000, recentBounces: 20 })).allow,
    ).toBe(true);
  });

  it("refuses to judge a rate on too little volume", () => {
    // One bounce in three is 33% and means nothing.
    expect(
      evaluateColdGate(
        facts({ recentSends: COLD_MIN_VOLUME_FOR_RATES - 1, recentBounces: 20 }),
      ).allow,
    ).toBe(true);
  });

  it("judges the rate as soon as there is enough volume to mean something", () => {
    expect(
      evaluateColdGate(
        facts({ recentSends: COLD_MIN_VOLUME_FOR_RATES, recentBounces: 20 }),
      ),
    ).toMatchObject({ allow: false, reason: "bounce-rate", pauseTrack: true });
  });

  it("reports the burning domain rather than the daily cap it also hit", () => {
    expect(
      evaluateColdGate(
        facts({ recentSends: 1000, recentBounces: 100, sentToday: 5000 }),
      ),
    ).toMatchObject({ reason: "bounce-rate" });
  });

  it("stays refused once paused, without re-deciding", () => {
    expect(evaluateColdGate(facts({ pausedAt: daysAgo(1) }))).toEqual({
      allow: false,
      reason: "paused",
      pauseTrack: false,
    });
  });
});

describe("none of the above is overridable by a tenant", () => {
  it("keeps every threshold a module constant", () => {
    expect(COLD_BOUNCE_RATE_CEILING).toBe(0.02);
    expect(COLD_COMPLAINT_RATE_CEILING).toBe(0.001);
    expect(COLD_MIN_VOLUME_FOR_RATES).toBe(50);
    // One argument, and it is a reading of the world rather than a policy.
    expect(evaluateColdGate).toHaveLength(1);
  });

  it("rejects every settings key that would reach one of them", () => {
    const attempts = [
      { coldBounceCeiling: 0.5 },
      { coldComplaintCeiling: 0.5 },
      { coldDailyCap: 10_000 },
      { coldRampSchedule: [5000] },
      { coldOutboundEnabled: true },
    ];
    for (const attempt of attempts)
      expect(updateAutonomySettingsSchema.safeParse(attempt).success).toBe(false);
  });
});

describe("coldBlockSummary", () => {
  it("has a sentence for every reason", () => {
    const reasons = [
      "not-enabled",
      "paused",
      "no-cold-domain",
      "domain-not-verified",
      "warmup-not-started",
      "borrows-transactional-reputation",
      "daily-cap-reached",
      "bounce-rate",
      "complaint-rate",
    ] as const;
    for (const reason of reasons) expect(coldBlockSummary(reason).length).toBeGreaterThan(10);
  });
});
