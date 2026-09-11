import {
  averageHours,
  completeWeeksInRange,
  computeMargin,
  currencyBreakdown,
  daysBetween,
  expectedHoursForRange,
  hoursBetween,
  missingWeekdayCount,
  resolveDateRange,
  round1,
  round2,
  round3,
  utilizationRate,
  weekdayDatesInRange,
  writeOffRate,
} from "./report-metrics";

describe("report-metrics", () => {
  describe("rounding", () => {
    it("rounds to the requested precision", () => {
      expect(round1(1.25)).toBe(1.3);
      expect(round2(1.006)).toBe(1.01);
      expect(round3(0.33333)).toBe(0.333);
    });
  });

  describe("utilizationRate", () => {
    it("returns 0 when total hours is 0", () => {
      expect(utilizationRate(0, 0)).toBe(0);
      expect(utilizationRate(5, 0)).toBe(0);
    });

    it("returns billable / total rounded to 3 decimals", () => {
      expect(utilizationRate(30, 40)).toBe(0.75);
      expect(utilizationRate(1, 3)).toBe(0.333);
      expect(utilizationRate(40, 40)).toBe(1);
    });
  });

  describe("computeMargin", () => {
    it("is null when cost is unknown", () => {
      expect(computeMargin(1000, null)).toBeNull();
    });

    it("subtracts cost from billable, 2 decimals", () => {
      expect(computeMargin(1000, 400)).toBe(600);
      expect(computeMargin(10.55, 0.55)).toBe(10);
      expect(computeMargin(100, 150)).toBe(-50);
    });
  });

  describe("writeOffRate", () => {
    it("returns 0 when there are no hours", () => {
      expect(writeOffRate(0, 0)).toBe(0);
    });

    it("returns nonBillable / total rounded to 3 decimals", () => {
      expect(writeOffRate(8, 2)).toBe(0.2);
      expect(writeOffRate(2, 1)).toBe(0.333);
      expect(writeOffRate(0, 5)).toBe(1);
    });
  });

  describe("hoursBetween / daysBetween", () => {
    it("computes hour differences to 1 decimal", () => {
      const start = new Date("2026-07-01T10:00:00Z");
      expect(hoursBetween(start, new Date("2026-07-01T11:30:00Z"))).toBe(1.5);
      expect(hoursBetween(start, new Date("2026-07-02T10:00:00Z"))).toBe(24);
    });

    it("computes day differences to 1 decimal", () => {
      const start = new Date("2026-07-01T00:00:00Z");
      expect(daysBetween(start, new Date("2026-07-04T12:00:00Z"))).toBe(3.5);
    });
  });

  describe("averageHours", () => {
    it("returns null for an empty list", () => {
      expect(averageHours([])).toBeNull();
    });

    it("averages to 1 decimal", () => {
      expect(averageHours([1, 2, 3])).toBe(2);
      expect(averageHours([1.25, 2.35])).toBe(1.8);
    });
  });

  describe("completeWeeksInRange", () => {
    it("counts complete 7-day blocks in the inclusive range", () => {
      expect(completeWeeksInRange("2026-07-01", "2026-07-07")).toBe(1); // 7 days
      expect(completeWeeksInRange("2026-07-01", "2026-07-06")).toBe(0); // 6 days
      expect(completeWeeksInRange("2026-07-01", "2026-07-30")).toBe(4); // 30 days
    });

    it("returns 0 for inverted ranges", () => {
      expect(completeWeeksInRange("2026-07-10", "2026-07-01")).toBe(0);
    });
  });

  describe("expectedHoursForRange", () => {
    it("is null when weekly hours are not configured", () => {
      expect(expectedHoursForRange("2026-07-01", "2026-07-14", null)).toBeNull();
      expect(expectedHoursForRange("2026-07-01", "2026-07-14", Number.NaN)).toBeNull();
    });

    it("multiplies complete weeks by weekly hours", () => {
      expect(expectedHoursForRange("2026-07-01", "2026-07-14", 40)).toBe(80); // 2 weeks
      expect(expectedHoursForRange("2026-07-01", "2026-07-06", 40)).toBe(0); // < 1 week
    });
  });

  describe("weekdayDatesInRange / missingWeekdayCount", () => {
    it("lists Mon-Fri only", () => {
      // 2026-07-06 is a Monday; range Mon..Sun contains 5 weekdays.
      expect(weekdayDatesInRange("2026-07-06", "2026-07-12")).toEqual([
        "2026-07-06",
        "2026-07-07",
        "2026-07-08",
        "2026-07-09",
        "2026-07-10",
      ]);
    });

    it("is empty for weekend-only ranges", () => {
      expect(weekdayDatesInRange("2026-07-11", "2026-07-12")).toEqual([]);
    });

    it("counts weekdays without a worked entry", () => {
      const worked = new Set(["2026-07-06", "2026-07-08", "2026-07-11"]); // Sat worked, ignored
      expect(missingWeekdayCount("2026-07-06", "2026-07-12", worked)).toBe(3); // Tue, Thu, Fri
      expect(missingWeekdayCount("2026-07-11", "2026-07-12", new Set())).toBe(0);
    });
  });

  describe("resolveDateRange", () => {
    const now = new Date("2026-07-25T15:00:00Z");

    it("passes explicit dates through", () => {
      expect(resolveDateRange("2026-01-01", "2026-01-31", now)).toEqual({
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });
    });

    it("defaults to a 30-day window ending today", () => {
      expect(resolveDateRange(undefined, undefined, now)).toEqual({
        startDate: "2026-06-26",
        endDate: "2026-07-25",
      });
    });

    it("anchors a default start to a provided end", () => {
      expect(resolveDateRange(undefined, "2026-03-30", now)).toEqual({
        startDate: "2026-03-01",
        endDate: "2026-03-30",
      });
    });
  });

  describe("currencyBreakdown", () => {
    it("returns an empty list for no rows", () => {
      expect(currencyBreakdown([])).toEqual([]);
    });

    it("handles a single currency", () => {
      expect(
        currencyBreakdown([{ currency: "USD", billableAmount: 100, costAmount: 40 }]),
      ).toEqual([{ currency: "USD", billableAmount: 100, costAmount: 40, margin: 60 }]);
    });

    it("keeps costAmount and margin null when no row has cost data", () => {
      expect(
        currencyBreakdown([
          { currency: "USD", billableAmount: 100, costAmount: null },
          { currency: "USD", billableAmount: 50, costAmount: null },
        ]),
      ).toEqual([{ currency: "USD", billableAmount: 150, costAmount: null, margin: null }]);
    });

    it("sums mixed null/non-null cost rows as known cost", () => {
      expect(
        currencyBreakdown([
          { currency: "USD", billableAmount: 100, costAmount: null },
          { currency: "USD", billableAmount: 50, costAmount: 20 },
        ]),
      ).toEqual([{ currency: "USD", billableAmount: 150, costAmount: 20, margin: 130 }]);
    });

    it("keeps currencies separate and sorted", () => {
      expect(
        currencyBreakdown([
          { currency: "USD", billableAmount: 100, costAmount: 30 },
          { currency: "EUR", billableAmount: 200, costAmount: null },
          { currency: "USD", billableAmount: 25.55, costAmount: 0.01 },
        ]),
      ).toEqual([
        { currency: "EUR", billableAmount: 200, costAmount: null, margin: null },
        { currency: "USD", billableAmount: 125.55, costAmount: 30.01, margin: 95.54 },
      ]);
    });
  });
});

describe("expectedHoursForRange with holidays", () => {
  /** Four complete weeks, Monday to Sunday, so the base is a round number. */
  const START = "2026-06-01";
  const END = "2026-06-28";

  it("expects a full month when nothing is closed", () => {
    expect(expectedHoursForRange(START, END, 40)).toBe(160);
    expect(expectedHoursForRange(START, END, 40, [])).toBe(160);
  });

  /**
   * The bug this replaced: a week containing a public holiday still expected
   * forty hours, so the compliance report marked the whole company short for
   * Diwali. A report that flags everybody teaches people to ignore it.
   */
  it("deducts a weekday holiday at the daily equivalent", () => {
    expect(expectedHoursForRange(START, END, 40, ["2026-06-10"])).toBe(152);
    expect(expectedHoursForRange(START, END, 40, ["2026-06-10", "2026-06-11"])).toBe(144);
  });

  /** A Saturday holiday costs nobody any expected hours. */
  it("ignores a holiday that falls at the weekend", () => {
    expect(expectedHoursForRange(START, END, 40, ["2026-06-13"])).toBe(160);
    expect(expectedHoursForRange(START, END, 40, ["2026-06-14"])).toBe(160);
  });

  /** Two holiday rows can share a date; the day is only lost once. */
  it("counts a doubly-listed date once", () => {
    expect(expectedHoursForRange(START, END, 40, ["2026-06-10", "2026-06-10"])).toBe(152);
  });

  it("ignores holidays outside the range", () => {
    expect(expectedHoursForRange(START, END, 40, ["2026-05-25", "2026-07-06"])).toBe(160);
  });

  it("never returns a negative expectation", () => {
    const everyWeekday = [
      "2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05",
      "2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12",
      "2026-06-15", "2026-06-16", "2026-06-17", "2026-06-18", "2026-06-19",
      "2026-06-22", "2026-06-23", "2026-06-24", "2026-06-25", "2026-06-26",
    ];
    expect(expectedHoursForRange(START, END, 40, everyWeekday)).toBe(0);
  });

  it("still returns null when no weekly expectation is configured", () => {
    expect(expectedHoursForRange(START, END, null, ["2026-06-10"])).toBeNull();
  });
});
