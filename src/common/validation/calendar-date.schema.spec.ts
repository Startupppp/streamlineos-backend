import {
  calendarDate,
  optionalCalendarDate,
  clearableCalendarDate,
  instant,
  optionalInstant,
  clearableInstant,
} from "./calendar-date.schema";

describe("calendar date contract", () => {
  it("accepts an ISO calendar date", () => {
    expect(calendarDate.parse("2026-10-01")).toBe("2026-10-01");
  });

  it("refuses the empty string a date picker sends when it was never touched", () => {
    expect(calendarDate.safeParse("").success).toBe(false);
  });

  it("refuses a day-first date rather than letting postgres decide", () => {
    expect(calendarDate.safeParse("01/10/2026").success).toBe(false);
  });

  it("turns an untouched optional date picker into an absent field", () => {
    expect(optionalCalendarDate.parse("")).toBeUndefined();
  });

  it("keeps a real optional date", () => {
    expect(optionalCalendarDate.parse("2026-10-01")).toBe("2026-10-01");
  });

  it("leaves an omitted optional date absent", () => {
    expect(optionalCalendarDate.parse(undefined)).toBeUndefined();
  });

  it("reads a cleared date field as null so the column is emptied", () => {
    expect(clearableCalendarDate.parse("")).toBeNull();
  });

  it("distinguishes clearing a date from not sending one", () => {
    expect(clearableCalendarDate.parse(null)).toBeNull();
    expect(clearableCalendarDate.parse(undefined)).toBeUndefined();
  });

  it("accepts a date-only value for a timestamp column", () => {
    expect(instant.parse("2026-10-01")).toBe("2026-10-01");
  });

  it("accepts an offset-bearing date-time", () => {
    expect(instant.parse("2026-10-01T09:30:00+05:30")).toBe(
      "2026-10-01T09:30:00+05:30",
    );
  });

  it("accepts a zulu date-time", () => {
    expect(instant.parse("2026-10-01T09:30:00Z")).toBe("2026-10-01T09:30:00Z");
  });

  it("refuses free text for a timestamp column", () => {
    expect(instant.safeParse("next tuesday").success).toBe(false);
  });

  it("turns an untouched optional timestamp into an absent field", () => {
    expect(optionalInstant.parse("")).toBeUndefined();
  });

  it("reads a cleared timestamp field as null", () => {
    expect(clearableInstant.parse("")).toBeNull();
  });
});
