import {
  DEFAULT_TERM_MONTHS,
  addMonths,
  calendarDateOf,
  daysBetween,
  formatIsoDate,
  parseIsoDate,
  renewalDate,
  termMonthsFrom,
} from "./lifecycle-terms";

/**
 * The renewal date is the one number in this feature a person acts on, and it
 * goes into a `date` column the whole book sorts by. Every case here names a way
 * it could be silently wrong.
 */
describe("addMonths", () => {
  /**
   * The failure this file exists for. `new Date("2026-01-31").setMonth(+1)`
   * produces 3 March; Postgres's `+ interval '1 month'` produces 28 February. A
   * renewal book where the application and the database disagree about the same
   * contract is worse than either answer alone.
   */
  it("clamps to the end of a shorter month instead of rolling over", () => {
    expect(addMonths({ year: 2026, month: 1, day: 31 }, 1)).toEqual({
      year: 2026,
      month: 2,
      day: 28,
    });
  });

  it("knows February has 29 days in a leap year", () => {
    expect(addMonths({ year: 2028, month: 1, day: 31 }, 1)).toEqual({
      year: 2028,
      month: 2,
      day: 29,
    });
  });

  /**
   * The clamp must not remember. Walking a month at a time would land 31 January
   * on 28 February and then on 28 March, quietly moving a two-month term three
   * days earlier than it was agreed.
   */
  it("anchors on the start date rather than walking month by month", () => {
    expect(addMonths({ year: 2026, month: 1, day: 31 }, 2)).toEqual({
      year: 2026,
      month: 3,
      day: 31,
    });
  });

  it("carries into the following year", () => {
    expect(addMonths({ year: 2026, month: 8, day: 27 }, 12)).toEqual({
      year: 2027,
      month: 8,
      day: 27,
    });
  });

  it("carries across several years", () => {
    expect(addMonths({ year: 2026, month: 11, day: 5 }, 26)).toEqual({
      year: 2029,
      month: 1,
      day: 5,
    });
  });
});

describe("parseIsoDate", () => {
  it("reads a stored date column", () => {
    expect(parseIsoDate("2026-08-27")).toEqual({ year: 2026, month: 8, day: 27 });
  });

  /**
   * Null rather than a throw, and null rather than a guess. A refusal is a value
   * the caller has to handle; a coerced `new Date("nonsense")` is an Invalid
   * Date that propagates into a column as `null` and loses a contract's renewal.
   */
  it.each([
    ["", "empty"],
    ["27/08/2026", "not ISO"],
    ["2026-13-01", "month 13"],
    ["2026-02-30", "a February that does not exist"],
    ["2026-08-27T00:00:00Z", "a timestamp rather than a date"],
  ])("refuses %s (%s)", (input, _why) => {
    expect(parseIsoDate(input)).toBeNull();
  });

  it("rejects 29 February in a non-leap year and accepts it in a leap one", () => {
    expect(parseIsoDate("2026-02-29")).toBeNull();
    expect(parseIsoDate("2028-02-29")).toEqual({ year: 2028, month: 2, day: 29 });
  });
});

describe("renewalDate", () => {
  it("adds the term to the start", () => {
    expect(renewalDate("2026-08-27", 12)).toBe("2027-08-27");
  });

  it("pads a single-digit month and day back to the column's format", () => {
    expect(renewalDate("2026-08-27", 5)).toBe("2027-01-27");
  });

  /**
   * A term outside the bounds answers null rather than producing a date, so the
   * one place that decides what to do about it is the origin rule — not four
   * callers each inventing a different fallback.
   */
  it.each([0, -1, 121, 1.5, Number.NaN])("refuses a term of %s months", (months) => {
    expect(renewalDate("2026-08-27", months)).toBeNull();
  });

  it("refuses an unusable start date", () => {
    expect(renewalDate("not-a-date", 12)).toBeNull();
  });
});

describe("termMonthsFrom", () => {
  it("reads a term the tenant stated on the deal", () => {
    expect(termMonthsFrom({ termMonths: 24 })).toBe(24);
  });

  /** CSV import and JSON both put numbers in as strings. */
  it("reads a numeric string", () => {
    expect(termMonthsFrom({ termMonths: "36" })).toBe(36);
  });

  /**
   * The load-bearing case. A nonsense term in an untyped JSON blob must not be
   * able to stop a won deal producing a lifecycle at all — that would trade a
   * typo for losing the revenue from the book entirely.
   */
  it.each([
    [null, "no custom data"],
    [{}, "no term stated"],
    [{ termMonths: 0 }, "zero"],
    [{ termMonths: -12 }, "negative"],
    [{ termMonths: 1000 }, "longer than a decade"],
    [{ termMonths: 12.5 }, "fractional"],
    [{ termMonths: "annual" }, "words"],
    ["not an object", "not an object at all"],
  ])("falls back to the default for %p (%s)", (customData, _why) => {
    expect(termMonthsFrom(customData)).toBe(DEFAULT_TERM_MONTHS);
  });
});

describe("daysBetween", () => {
  it("counts forward and backward symmetrically", () => {
    const a = { year: 2026, month: 8, day: 27 };
    const b = { year: 2026, month: 9, day: 27 };
    expect(daysBetween(a, b)).toBe(31);
    expect(daysBetween(b, a)).toBe(-31);
  });

  it("counts the leap day", () => {
    expect(
      daysBetween({ year: 2028, month: 2, day: 28 }, { year: 2028, month: 3, day: 1 }),
    ).toBe(2);
    expect(
      daysBetween({ year: 2026, month: 2, day: 28 }, { year: 2026, month: 3, day: 1 }),
    ).toBe(1);
  });

  it("counts a century that is not a leap year", () => {
    // 1900 was not a leap year; 2000 was. A naive `%4` rule gets one of these wrong.
    expect(
      daysBetween({ year: 1900, month: 2, day: 28 }, { year: 1900, month: 3, day: 1 }),
    ).toBe(1);
    expect(
      daysBetween({ year: 2000, month: 2, day: 28 }, { year: 2000, month: 3, day: 1 }),
    ).toBe(2);
  });
});

describe("calendarDateOf", () => {
  /**
   * UTC, deliberately. Reading the local components would make the date a
   * contract starts on depend on which region the API node happens to be in, so
   * two nodes would open the same term one day apart.
   */
  it("reads the UTC calendar date, not the process's local one", () => {
    expect(formatIsoDate(calendarDateOf(new Date("2026-08-27T23:30:00.000Z")))).toBe(
      "2026-08-27",
    );
    expect(formatIsoDate(calendarDateOf(new Date("2026-08-28T00:30:00.000Z")))).toBe(
      "2026-08-28",
    );
  });
});
