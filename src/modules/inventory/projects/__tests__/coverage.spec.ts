import { assessCoverage } from "../lib/coverage";

/**
 * B1 — the at-risk rule, against a fixed clock.
 *
 * Every case here is a real decision somebody makes on a site: is this line
 * covered, is it short, and if it is short does anybody need to do something
 * today. The clock is injected, so these do not start failing in December.
 */
const NOW = new Date("2026-09-01T09:00:00Z");

const base = {
  requiredQty: "100",
  reservedQty: "0",
  fulfilledQty: "0",
  availableQty: "500",
  requiredBy: null as string | null,
  leadTimeDays: null as number | null,
};

describe("assessCoverage — shortfall", () => {
  it("subtracts both what is held and what has already gone", () => {
    const r = assessCoverage({ ...base, reservedQty: "30", fulfilledQty: "20" }, NOW);
    expect(r.shortfallQty).toBe("50.0000");
  });

  it("is zero, never negative, when more is covered than was asked for", () => {
    const r = assessCoverage({ ...base, reservedQty: "80", fulfilledQty: "40" }, NOW);
    expect(r.shortfallQty).toBe("0");
    expect(r.atRisk).toBe(false);
    expect(r.riskReason).toBeNull();
  });

  it("a fully reserved line is not at risk even on its due date", () => {
    const r = assessCoverage(
      { ...base, reservedQty: "100", requiredBy: "2026-09-01", leadTimeDays: 30 },
      NOW,
    );
    expect(r.atRisk).toBe(false);
  });
});

describe("assessCoverage — SHORT_NO_STOCK", () => {
  it("is at risk when the shelf cannot close the gap, whatever the date says", () => {
    const r = assessCoverage({ ...base, availableQty: "10", requiredBy: null }, NOW);
    expect(r.atRisk).toBe(true);
    expect(r.riskReason).toBe("SHORT_NO_STOCK");
  });

  it("counts availability against the shortfall, not against the requirement", () => {
    // 100 wanted, 90 already held, 10 short — and 20 on the shelf covers it.
    const r = assessCoverage({ ...base, reservedQty: "90", availableQty: "20" }, NOW);
    expect(r.atRisk).toBe(false);
  });

  it("treats exactly-enough as enough", () => {
    const r = assessCoverage({ ...base, availableQty: "100" }, NOW);
    expect(r.riskReason).toBeNull();
  });
});

describe("assessCoverage — SHORT_AND_DUE", () => {
  it("is at risk when the date is inside the lead time and nothing is held", () => {
    const r = assessCoverage(
      { ...base, availableQty: "500", requiredBy: "2026-09-20", leadTimeDays: 30 },
      NOW,
    );
    expect(r.atRisk).toBe(true);
    expect(r.riskReason).toBe("SHORT_AND_DUE");
  });

  it("is not at risk when the date is comfortably beyond the lead time", () => {
    const r = assessCoverage(
      { ...base, availableQty: "500", requiredBy: "2026-12-01", leadTimeDays: 7 },
      NOW,
    );
    expect(r.atRisk).toBe(false);
    expect(r.riskReason).toBeNull();
  });

  it("with no lead time, only a date at or before today counts", () => {
    expect(
      assessCoverage({ ...base, requiredBy: "2026-09-02", leadTimeDays: null }, NOW).atRisk,
    ).toBe(false);
    expect(
      assessCoverage({ ...base, requiredBy: "2026-09-01", leadTimeDays: null }, NOW).atRisk,
    ).toBe(true);
  });

  it("a short line with no date and enough stock is not at risk", () => {
    const r = assessCoverage({ ...base, requiredBy: null, availableQty: "500" }, NOW);
    expect(r.atRisk).toBe(false);
  });

  it("ignores an unparseable date rather than throwing", () => {
    const r = assessCoverage({ ...base, requiredBy: "not-a-date", availableQty: "500" }, NOW);
    expect(r.atRisk).toBe(false);
  });
});

describe("assessCoverage — decimals", () => {
  it("does not drift on quantities with four places", () => {
    const r = assessCoverage(
      { ...base, requiredQty: "10.5000", reservedQty: "3.2500", fulfilledQty: "1.2500" },
      NOW,
    );
    expect(r.shortfallQty).toBe("6.0000");
  });
});
