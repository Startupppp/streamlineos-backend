import {
  MIN_RENEWAL_HISTORY,
  evaluateRenewalTriggers,
  renewalLeadTime,
  type CompletedRenewalCycle,
  type LifecycleForTrigger,
  type RenewalLeadTime,
} from "./renewal-triggers";

const NOW = new Date("2026-06-01T00:00:00Z");
const DAY_MS = 86_400_000;

function cycle(days: number, endedDaysAgo = 30): CompletedRenewalCycle {
  const closedAt = new Date(NOW.getTime() - endedDaysAgo * DAY_MS);
  return { openedAt: new Date(closedAt.getTime() - days * DAY_MS), closedAt };
}

function lifecycle(overrides: Partial<LifecycleForTrigger> = {}): LifecycleForTrigger {
  return {
    customerLifecycleId: "lc-1",
    partyId: "party-1",
    customerName: "Acme",
    stage: "active",
    termMonths: 12,
    contractValueMinor: 2_400_000,
    currencyCode: "GBP",
    renewalDate: "2026-12-01",
    hasOpenOpportunity: false,
    latestHealth: null,
    ...overrides,
  };
}

const HISTORY_LEAD: RenewalLeadTime = { days: 30, source: "history", sampleCount: 5 };

describe("the lead time comes from the tenant's own renewal cycle", () => {
  it("covers the slow tail of their own behaviour rather than the typical case", () => {
    const lead = renewalLeadTime([cycle(20), cycle(22), cycle(25), cycle(28), cycle(70)], 12);

    // A mean would be 33 and would fire too late for the renewal that took 70
    // days — which is exactly the one that needed the most warning.
    expect(lead.source).toBe("history");
    expect(lead.days).toBe(70);
  });

  it("gives a fast-moving business a short lead time and a slow one a long one", () => {
    const fast = renewalLeadTime([cycle(9), cycle(11), cycle(12)], 12);
    const slow = renewalLeadTime([cycle(100), cycle(110), cycle(120)], 12);

    expect(fast.days).toBeLessThan(slow.days);
    expect(fast.days).toBeGreaterThanOrEqual(14);
  });

  it("falls back to a share of the term until there is enough history, and says so", () => {
    const thin = renewalLeadTime(
      Array.from({ length: MIN_RENEWAL_HISTORY - 1 }, () => cycle(40)),
      12,
    );

    expect(thin.source).toBe("term-fallback");
    expect(thin.sampleCount).toBe(0);
    expect(thin.days).toBe(90);
  });

  it("falls back to something that describes a monthly contract rather than an annual one", () => {
    expect(renewalLeadTime([], 1).days).toBe(14);
    expect(renewalLeadTime([], 12).days).toBe(90);
  });

  it("replaces the fallback the moment the tenant has been through enough renewals", () => {
    const history = Array.from({ length: MIN_RENEWAL_HISTORY }, () => cycle(21));

    expect(renewalLeadTime(history, 12).source).toBe("history");
    expect(renewalLeadTime(history, 12).days).toBe(21);
  });
});

describe("a renewal inside the tenant's own window becomes an opportunity", () => {
  it("opens one when the renewal falls inside the lead time and not before", () => {
    const far = evaluateRenewalTriggers({
      now: NOW,
      leadTime: HISTORY_LEAD,
      lifecycles: [lifecycle({ renewalDate: "2026-09-01" })],
    });
    const near = evaluateRenewalTriggers({
      now: NOW,
      leadTime: HISTORY_LEAD,
      lifecycles: [lifecycle({ renewalDate: "2026-06-20" })],
    });

    expect(far).toEqual([]);
    expect(near[0]?.kind).toBe("renewal.due");
    expect(near[0]?.opportunity).toMatchObject({
      valueMinor: 2_400_000,
      expectedCloseDate: "2026-06-20",
    });
  });

  it("still opens one for a renewal that has already gone by unworked", () => {
    const triggers = evaluateRenewalTriggers({
      now: NOW,
      leadTime: HISTORY_LEAD,
      lifecycles: [lifecycle({ renewalDate: "2026-05-01" })],
    });

    expect(triggers[0]?.kind).toBe("renewal.due");
    expect(triggers[0]?.signal.summary).toContain("nobody worked it");
  });

  it("records which of the two lead times produced the decision", () => {
    const [fromHistory] = evaluateRenewalTriggers({
      now: NOW,
      leadTime: HISTORY_LEAD,
      lifecycles: [lifecycle({ renewalDate: "2026-06-20" })],
    });
    const [fromFallback] = evaluateRenewalTriggers({
      now: NOW,
      leadTime: { days: 90, source: "term-fallback", sampleCount: 0 },
      lifecycles: [lifecycle({ renewalDate: "2026-06-20" })],
    });

    expect(fromHistory?.signal.evidence).toMatchObject({
      leadTimeSource: "history",
      leadTimeSampleCount: 5,
    });
    expect(fromFallback?.signal.evidence).toMatchObject({ leadTimeSource: "term-fallback" });
  });

  it("leaves a customer alone when somebody is already working an opportunity", () => {
    expect(
      evaluateRenewalTriggers({
        now: NOW,
        leadTime: HISTORY_LEAD,
        lifecycles: [lifecycle({ renewalDate: "2026-06-20", hasOpenOpportunity: true })],
      }),
    ).toEqual([]);
  });

  it("does not open a second opportunity for a lifecycle already in its renewal", () => {
    expect(
      evaluateRenewalTriggers({
        now: NOW,
        leadTime: HISTORY_LEAD,
        lifecycles: [lifecycle({ renewalDate: "2026-06-20", stage: "renewal_open" })],
      }),
    ).toEqual([]);
  });

  it("leaves a finished lifecycle alone", () => {
    for (const stage of ["renewed", "churned"] as const)
      expect(
        evaluateRenewalTriggers({
          now: NOW,
          leadTime: HISTORY_LEAD,
          lifecycles: [lifecycle({ renewalDate: "2026-06-20", stage })],
        }),
      ).toEqual([]);
  });
});

describe("a customer in trouble becomes an opportunity before their renewal date does", () => {
  const failing = {
    score: 22,
    band: "critical" as const,
    computedAt: new Date(NOW.getTime() - DAY_MS),
  };

  it("opens a save regardless of how far off the renewal is", () => {
    const [trigger] = evaluateRenewalTriggers({
      now: NOW,
      leadTime: HISTORY_LEAD,
      lifecycles: [lifecycle({ renewalDate: "2027-01-01", latestHealth: failing })],
    });

    expect(trigger?.kind).toBe("churn.risk");
    expect(trigger?.nextStage).toBe("at_risk");
    expect(trigger?.signal.evidence).toMatchObject({ healthScore: 22, healthBand: "critical" });
  });

  it("asks for it to close inside the tenant's own cycle rather than at the renewal date", () => {
    const [trigger] = evaluateRenewalTriggers({
      now: NOW,
      leadTime: HISTORY_LEAD,
      lifecycles: [lifecycle({ renewalDate: "2027-01-01", latestHealth: failing })],
    });

    expect(trigger?.opportunity.expectedCloseDate).toBe("2026-07-01");
  });

  it("leaves a merely wobbly customer alone", () => {
    expect(
      evaluateRenewalTriggers({
        now: NOW,
        leadTime: HISTORY_LEAD,
        lifecycles: [
          lifecycle({
            renewalDate: "2027-01-01",
            latestHealth: { score: 55, band: "at_risk", computedAt: NOW },
          }),
        ],
      }),
    ).toEqual([]);
  });

  it("says nothing about a customer who has never been scored", () => {
    expect(
      evaluateRenewalTriggers({
        now: NOW,
        leadTime: HISTORY_LEAD,
        lifecycles: [lifecycle({ renewalDate: "2027-01-01", latestHealth: null })],
      }),
    ).toEqual([]);
  });

  it("produces one opportunity, not two, for a customer who is both due and failing", () => {
    const triggers = evaluateRenewalTriggers({
      now: NOW,
      leadTime: HISTORY_LEAD,
      lifecycles: [lifecycle({ renewalDate: "2026-06-20", latestHealth: failing })],
    });

    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.kind).toBe("renewal.due");
  });
});

describe("what a trigger is allowed to do on its own", () => {
  it("only ever asks for something a single write takes back", () => {
    const triggers = evaluateRenewalTriggers({
      now: NOW,
      leadTime: HISTORY_LEAD,
      lifecycles: [
        lifecycle({ renewalDate: "2026-06-20" }),
        lifecycle({
          customerLifecycleId: "lc-2",
          partyId: "party-2",
          renewalDate: "2027-01-01",
          latestHealth: { score: 10, band: "critical", computedAt: NOW },
        }),
      ],
    });

    // Nothing here reaches a customer, so nothing here needs a hold: the message
    // that eventually does goes out through the outbound loop's own.
    expect(triggers.map((trigger) => trigger.signal.reversibility)).toEqual([
      "instant",
      "instant",
    ]);
  });
});
