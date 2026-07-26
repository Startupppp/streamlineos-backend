import { formatDateOnly } from "./period.helpers";
import { addDays, lastCompleteWeekRange } from "./exception-window";

describe("lastCompleteWeekRange", () => {
  it("returns the week immediately before the current one (Monday start)", () => {
    // Wednesday 2026-07-08 → current week is Mon 2026-07-06..Sun 2026-07-12,
    // so the last complete week is Mon 2026-06-29..Sun 2026-07-05.
    const { start, end } = lastCompleteWeekRange(new Date(2026, 6, 8), 1);
    expect(start).toBe("2026-06-29");
    expect(end).toBe("2026-07-05");
  });

  it("returns a 7-day window ending strictly before today", () => {
    const today = new Date(2026, 6, 8);
    const { start, end } = lastCompleteWeekRange(today, 1);
    const s = new Date(`${start}T00:00:00`);
    const e = new Date(`${end}T00:00:00`);
    expect((e.getTime() - s.getTime()) / 86_400_000).toBe(6);
    expect(end < formatDateOnly(today)).toBe(true);
  });

  it("respects a Sunday work-week start", () => {
    const { start, end } = lastCompleteWeekRange(new Date(2026, 6, 8), 0);
    expect(new Date(`${start}T00:00:00`).getDay()).toBe(0);
    expect(start).toBe("2026-06-28");
    expect(end).toBe("2026-07-04");
  });

  it("still returns the prior week when today is the first day of a week", () => {
    // Monday 2026-07-06 with Monday start → previous week 06-29..07-05.
    const { start, end } = lastCompleteWeekRange(new Date(2026, 6, 6), 1);
    expect(start).toBe("2026-06-29");
    expect(end).toBe("2026-07-05");
  });
});

describe("addDays", () => {
  it("adds days across month boundaries", () => {
    expect(addDays("2026-06-29", 6)).toBe("2026-07-05");
  });

  it("subtracts days with negative input", () => {
    expect(addDays("2026-07-05", -30)).toBe("2026-06-05");
  });
});
