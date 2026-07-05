import { formatDateOnly, weekRange } from "./period.helpers";

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
