import {
  DEFAULT_TERM_MONTHS,
  LifecycleRecordError,
  daysUntil,
  lifecycleFromClosedWonDeal,
  lifecycleOpenedSignal,
  renewalDateFor,
  type ClosedWonDeal,
} from "./lifecycle-record";

const WON_AT = new Date("2026-03-31T09:15:00Z");

function deal(overrides: Partial<ClosedWonDeal> = {}): ClosedWonDeal {
  return {
    dealId: "4021",
    organizationId: "org-1",
    partyId: "party-1",
    valueMinor: 1_200_000,
    currencyCode: "GBP",
    closedAt: WON_AT,
    termMonths: null,
    ...overrides,
  };
}

describe("a closed-won deal produces a lifecycle record", () => {
  it("carries the renewal date, the term and the value the deal was worth", () => {
    const record = lifecycleFromClosedWonDeal(deal({ termMonths: 12 }));

    expect(record).toMatchObject({
      renewalDate: "2027-03-31",
      termMonths: 12,
      contractValueMinor: 1_200_000,
      currencyCode: "GBP",
      stage: "active",
      originDealId: "4021",
    });
  });

  it("says when the term was assumed rather than stated", () => {
    expect(lifecycleFromClosedWonDeal(deal()).termSource).toBe("default");
    expect(lifecycleFromClosedWonDeal(deal()).termMonths).toBe(DEFAULT_TERM_MONTHS);
    expect(lifecycleFromClosedWonDeal(deal({ termMonths: 24 })).termSource).toBe("deal");
  });

  it("treats a nonsense term as no term at all rather than as a contract", () => {
    expect(lifecycleFromClosedWonDeal(deal({ termMonths: 0 })).termSource).toBe("default");
    expect(lifecycleFromClosedWonDeal(deal({ termMonths: 4_000 })).termSource).toBe("default");
    expect(lifecycleFromClosedWonDeal(deal({ termMonths: 1.5 })).termSource).toBe("default");
  });

  it("refuses to open a lifecycle anchored to nobody", () => {
    expect(() => lifecycleFromClosedWonDeal(deal({ partyId: "" }))).toThrow(LifecycleRecordError);
  });

  it("tells a reader in the summary when the date rests on an assumption", () => {
    expect(lifecycleOpenedSignal(lifecycleFromClosedWonDeal(deal())).summary).toContain("assumed");
    expect(
      lifecycleOpenedSignal(lifecycleFromClosedWonDeal(deal({ termMonths: 12 }))).summary,
    ).not.toContain("assumed");
  });
});

describe("a term renews on the day it was sold on", () => {
  it("keeps the day of the month across a year", () => {
    expect(renewalDateFor(new Date("2026-03-03T00:00:00Z"), 12)).toBe("2027-03-03");
  });

  it("keeps it across a part-year term too", () => {
    expect(renewalDateFor(new Date("2026-01-15T00:00:00Z"), 3)).toBe("2026-04-15");
  });

  it("clamps back to the last of the month rather than rolling into the next one", () => {
    // A January 31st contract on a one-month term renews in February, not March.
    expect(renewalDateFor(new Date("2026-01-31T00:00:00Z"), 1)).toBe("2026-02-28");
  });

  it("lands on the leap day where there is one", () => {
    expect(renewalDateFor(new Date("2027-01-31T00:00:00Z"), 1)).toBe("2027-02-28");
    expect(renewalDateFor(new Date("2028-01-31T00:00:00Z"), 1)).toBe("2028-02-29");
  });

  it("does not move with the clock the process happens to be running on", () => {
    // A late-evening close in UTC and the same instant read in another zone must
    // produce the same renewal date, which is why everything here is UTC.
    expect(renewalDateFor(new Date("2026-03-31T23:30:00Z"), 12)).toBe("2027-03-31");
  });
});

describe("how far off a renewal is", () => {
  it("counts whole days from today, not from the current instant", () => {
    expect(daysUntil("2026-06-10", new Date("2026-06-01T23:59:00Z"))).toBe(9);
    expect(daysUntil("2026-06-10", new Date("2026-06-01T00:01:00Z"))).toBe(9);
  });

  it("goes negative once the date has gone by, rather than clamping to nothing", () => {
    expect(daysUntil("2026-05-20", new Date("2026-06-01T12:00:00Z"))).toBe(-12);
  });

  it("refuses a date it cannot read instead of returning a number built on NaN", () => {
    expect(() => daysUntil("not-a-date", new Date())).toThrow(LifecycleRecordError);
  });
});
