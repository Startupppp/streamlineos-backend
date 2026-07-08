import { isWithinQuietHours, parseHhMm, quietHoursEndAt } from "./quiet-hours.util";

describe("parseHhMm", () => {
  it("parses HH:MM into minutes", () => {
    expect(parseHhMm("22:30")).toBe(1350);
    expect(parseHhMm("00:00")).toBe(0);
  });

  it("returns null for invalid input", () => {
    expect(parseHhMm("bad")).toBeNull();
    expect(parseHhMm(null)).toBeNull();
    expect(parseHhMm("25:00")).toBeNull();
  });
});

describe("isWithinQuietHours", () => {
  const cfg = { start: "22:00", end: "07:00", timezone: "UTC", includeWeekends: true };

  it("is within an overnight window at 23:00", () => {
    expect(isWithinQuietHours(new Date("2024-01-02T23:00:00Z"), cfg)).toBe(true);
  });

  it("is outside the window at midday", () => {
    expect(isWithinQuietHours(new Date("2024-01-02T12:00:00Z"), cfg)).toBe(false);
  });

  it("honours weekend exclusion", () => {
    const weekend = new Date("2024-01-06T23:00:00Z"); // Saturday
    expect(isWithinQuietHours(weekend, { ...cfg, includeWeekends: false })).toBe(false);
    expect(isWithinQuietHours(weekend, cfg)).toBe(true);
  });

  it("respects timezone offset", () => {
    // 23:00 UTC is 18:00 in America/New_York (EST) — outside a 22:00-07:00 local window.
    expect(isWithinQuietHours(new Date("2024-01-02T23:00:00Z"), { ...cfg, timezone: "America/New_York" })).toBe(false);
  });

  it("returns false when quiet hours are unset", () => {
    expect(isWithinQuietHours(new Date(), { start: null, end: null, timezone: "UTC", includeWeekends: true })).toBe(false);
  });
});

describe("quietHoursEndAt", () => {
  it("computes the next end boundary across midnight", () => {
    const end = quietHoursEndAt(new Date("2024-01-02T23:00:00Z"), { start: "22:00", end: "07:00", timezone: "UTC", includeWeekends: true });
    expect(end?.toISOString()).toBe("2024-01-03T07:00:00.000Z");
  });
});
