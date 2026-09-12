import {
  addDays,
  addMonths,
  assertIsoDate,
  FiscalCalendarError,
  fiscalYearFor,
  isWithin,
  monthlyPeriodsFor,
  nextFiscalYear,
} from "./fiscal-calendar";

describe("date arithmetic", () => {
  it("rejects a malformed or impossible date", () => {
    expect(() => assertIsoDate("2026-8-25")).toThrow(FiscalCalendarError);
    expect(() => assertIsoDate("25/08/2026")).toThrow(FiscalCalendarError);
    expect(() => assertIsoDate("2026-02-30")).toThrow(FiscalCalendarError);
    expect(() => assertIsoDate("2025-02-29")).toThrow(FiscalCalendarError);
  });

  it("accepts a real leap day", () => {
    expect(assertIsoDate("2028-02-29")).toBe("2028-02-29");
  });

  it("clamps the day when adding months", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-03-31", 1)).toBe("2026-04-30");
  });

  it("crosses year boundaries", () => {
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
  });
});

describe("fiscal year determination", () => {
  it("puts 2026-08-25 in India's FY 2026-27 (PRD 12 acceptance 1)", () => {
    const fy = fiscalYearFor("2026-08-25", 4, 1, "span");
    expect(fy).toEqual({ name: "2026-27", startsOn: "2026-04-01", endsOn: "2027-03-31" });
  });

  it("puts a March date in the previous India fiscal year", () => {
    const fy = fiscalYearFor("2026-03-31", 4, 1, "span");
    expect(fy).toEqual({ name: "2025-26", startsOn: "2025-04-01", endsOn: "2026-03-31" });
  });

  it("treats 1 April as the first day of the new year, not the last of the old", () => {
    expect(fiscalYearFor("2026-04-01", 4, 1, "span").name).toBe("2026-27");
    expect(fiscalYearFor("2026-03-31", 4, 1, "span").name).toBe("2025-26");
  });

  it("names a calendar-year pack by its single year (PRD 12 acceptance 2)", () => {
    const fy = fiscalYearFor("2026-08-25", 1, 1, "calendar");
    expect(fy).toEqual({ name: "2026", startsOn: "2026-01-01", endsOn: "2026-12-31" });
  });

  it("handles Australia's 1 July start", () => {
    expect(fiscalYearFor("2026-08-25", 7, 1, "span")).toEqual({
      name: "2026-27",
      startsOn: "2026-07-01",
      endsOn: "2027-06-30",
    });
    expect(fiscalYearFor("2026-06-30", 7, 1, "span").name).toBe("2025-26");
  });

  it("spans a leap year without losing 29 February", () => {
    const fy = fiscalYearFor("2028-01-15", 4, 1, "span");
    expect(fy).toEqual({ name: "2027-28", startsOn: "2027-04-01", endsOn: "2028-03-31" });
    expect(isWithin("2028-02-29", fy.startsOn, fy.endsOn)).toBe(true);
  });

  it("rejects an out-of-range start", () => {
    expect(() => fiscalYearFor("2026-08-25", 13, 1, "span")).toThrow(FiscalCalendarError);
    expect(() => fiscalYearFor("2026-08-25", 4, 31, "span")).toThrow(FiscalCalendarError);
  });

  it("chains to the following year with no gap", () => {
    const first = fiscalYearFor("2026-08-25", 4, 1, "span");
    const second = nextFiscalYear(first, "span");
    expect(second).toEqual({ name: "2027-28", startsOn: "2027-04-01", endsOn: "2028-03-31" });
    expect(addDays(first.endsOn, 1)).toBe(second.startsOn);
  });
});

describe("period generation", () => {
  const indiaFy = fiscalYearFor("2026-08-25", 4, 1, "span");

  it("produces twelve periods", () => {
    expect(monthlyPeriodsFor(indiaFy)).toHaveLength(12);
  });

  it("covers 1 April to 31 March exactly, with no gap or overlap", () => {
    const periods = monthlyPeriodsFor(indiaFy);
    expect(periods[0].startsOn).toBe("2026-04-01");
    expect(periods[11].endsOn).toBe("2027-03-31");

    for (let i = 1; i < periods.length; i++) {
      expect(periods[i].startsOn).toBe(addDays(periods[i - 1].endsOn, 1));
    }
  });

  it("names periods by their calendar month", () => {
    const periods = monthlyPeriodsFor(indiaFy);
    expect(periods[0].name).toBe("April 2026");
    expect(periods[9].name).toBe("January 2027");
    expect(periods[11].name).toBe("March 2027");
  });

  it("sequences from 1 to 12", () => {
    expect(monthlyPeriodsFor(indiaFy).map((p) => p.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });

  it("places every day of the year in exactly one period", () => {
    const periods = monthlyPeriodsFor(indiaFy);
    for (const date of ["2026-04-01", "2026-08-25", "2027-02-28", "2027-03-31"]) {
      const matches = periods.filter((p) => isWithin(date, p.startsOn, p.endsOn));
      expect(matches).toHaveLength(1);
    }
  });

  it("includes 29 February in a leap fiscal year", () => {
    const periods = monthlyPeriodsFor(fiscalYearFor("2028-01-15", 4, 1, "span"));
    const february = periods.find((p) => p.name === "February 2028");
    expect(february?.endsOn).toBe("2028-02-29");
  });

  it("covers a calendar-year pack end to end", () => {
    const periods = monthlyPeriodsFor(fiscalYearFor("2026-06-01", 1, 1, "calendar"));
    expect(periods[0].startsOn).toBe("2026-01-01");
    expect(periods[11].endsOn).toBe("2026-12-31");
  });
});
