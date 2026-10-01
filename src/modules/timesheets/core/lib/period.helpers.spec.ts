import { formatDateOnly, utcDateOnly, weekRange } from "./period.helpers";

describe("formatDateOnly", () => {
  it("zero-pads month and day", () => {
    expect(formatDateOnly(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(formatDateOnly(new Date(2026, 11, 25))).toBe("2026-12-25");
  });
});

describe("weekRange", () => {
  it("returns a 7-day window starting on the configured work-week start (Monday)", () => {
    const { start, end } = weekRange(new Date(2026, 6, 8), 1);
    const s = new Date(`${start}T00:00:00`);
    const e = new Date(`${end}T00:00:00`);
    expect(s.getDay()).toBe(1);
    expect((e.getTime() - s.getTime()) / 86_400_000).toBe(6);
  });

  it("respects a Sunday work-week start", () => {
    const { start } = weekRange(new Date(2026, 6, 8), 0);
    expect(new Date(`${start}T00:00:00`).getDay()).toBe(0);
  });

  it("keeps the input date inside the returned window", () => {
    const target = new Date(2026, 6, 8);
    const { start, end } = weekRange(target, 1);
    expect(formatDateOnly(target) >= start).toBe(true);
    expect(formatDateOnly(target) <= end).toBe(true);
  });
});

describe("utcDateOnly", () => {
  const ORIGINAL_TZ = process.env.TZ;
  afterAll(() => {
    process.env.TZ = ORIGINAL_TZ;
  });

  // 23:00 UTC: every zone east of UTC has already rolled over to the 4th.
  const LATE_IN_THE_DAY = new Date("2026-10-03T23:00:00Z");

  for (const zone of ["UTC", "Asia/Kolkata", "Pacific/Kiritimati", "Pacific/Midway"]) {
    it(`reports the same day in ${zone}`, () => {
      process.env.TZ = zone;
      expect(utcDateOnly(LATE_IN_THE_DAY)).toBe("2026-10-03");
    });
  }

  it("zero-pads and keeps midnight UTC on its own day", () => {
    process.env.TZ = "UTC";
    expect(utcDateOnly(new Date("2026-01-05T00:00:00Z"))).toBe("2026-01-05");
    expect(utcDateOnly(new Date("2026-12-25T23:59:59Z"))).toBe("2026-12-25");
  });
});
