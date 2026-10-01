import { computeLeaveDays, computeOvertime, round2, isWeekend } from "./payroll-calc";

describe("round2", () => {
  it("rounds to 2 decimal places", () => {
    expect(round2(1.019)).toBe(1.02);
    expect(round2(1.011)).toBe(1.01);
    expect(round2(0)).toBe(0);
    expect(round2(3.14159)).toBe(3.14);
  });
});

describe("isWeekend", () => {
  it("returns true for Saturday", () => {
    expect(isWeekend("2024-01-06")).toBe(true);
  });

  it("returns true for Sunday", () => {
    expect(isWeekend("2024-01-07")).toBe(true);
  });

  it("returns false for weekday", () => {
    expect(isWeekend("2024-01-08")).toBe(false);
  });
});

describe("computeOvertime", () => {
  it("returns 0 when no entries", () => {
    expect(computeOvertime([], 8, 40)).toBe(0);
  });

  it("returns 0 when hours under both thresholds", () => {
    const entries = [
      { date: "2024-01-01", hours: 7 },
      { date: "2024-01-02", hours: 7 },
      { date: "2024-01-03", hours: 7 },
      { date: "2024-01-04", hours: 7 },
      { date: "2024-01-05", hours: 7 },
    ];
    expect(computeOvertime(entries, 8, 40)).toBe(0);
  });

  it("computes daily overtime only", () => {
    const entries = [
      { date: "2024-01-01", hours: 10 },
      { date: "2024-01-02", hours: 6 },
    ];
    expect(computeOvertime(entries, 8, 40)).toBe(2);
  });

  it("computes weekly overtime only (no daily OT)", () => {
    const entries = [
      { date: "2024-01-01", hours: 8 },
      { date: "2024-01-02", hours: 8 },
      { date: "2024-01-03", hours: 8 },
      { date: "2024-01-04", hours: 8 },
      { date: "2024-01-05", hours: 8 },
      { date: "2024-01-06", hours: 3 },
    ];
    expect(computeOvertime(entries, 8, 40)).toBe(3);
  });

  it("does not double-count daily OT in weekly OT", () => {
    const entries = [
      { date: "2024-01-01", hours: 10 },
      { date: "2024-01-02", hours: 10 },
      { date: "2024-01-03", hours: 10 },
      { date: "2024-01-04", hours: 10 },
      { date: "2024-01-05", hours: 10 },
    ];
    const dailyOt = 5 * 2;
    const weeklyOt = Math.max(0, 50 - 40 - dailyOt);
    expect(computeOvertime(entries, 8, 40)).toBe(round2(dailyOt + weeklyOt));
  });

  it("handles a period spanning partial ISO weeks", () => {
    const entries = [
      { date: "2024-01-05", hours: 9 },
      { date: "2024-01-08", hours: 9 },
    ];
    expect(computeOvertime(entries, 8, 40)).toBe(2);
  });

  it("handles rounding", () => {
    const entries = [{ date: "2024-01-01", hours: 8.005 }];
    const result = computeOvertime(entries, 8, 40);
    expect(result).toBe(round2(0.005));
  });
});

describe("computeLeaveDays — timezone independence (BUG-TS-BE-008)", () => {
  const ORIGINAL_TZ = process.env.TZ;
  afterAll(() => {
    process.env.TZ = ORIGINAL_TZ;
  });

  const leave = [
    // Spans the US spring-forward (2026-03-08) and the EU one (2026-03-29).
    { userId: "u1", startDate: "2026-03-06", endDate: "2026-03-31", isHalfDay: false },
  ];

  for (const zone of ["UTC", "America/New_York", "Europe/Berlin", "Asia/Kolkata", "Australia/Lord_Howe"]) {
    it(`counts the same inclusive days in ${zone}`, () => {
      process.env.TZ = zone;
      expect(computeLeaveDays(leave, "2026-03-01", "2026-03-31").get("u1")).toBe(26);
    });
  }

  it("clamps to the period and halves a half-day", () => {
    process.env.TZ = "America/New_York";
    expect(computeLeaveDays(leave, "2026-03-10", "2026-03-12").get("u1")).toBe(3);
    expect(
      computeLeaveDays([{ ...leave[0]!, isHalfDay: true }], "2026-03-10", "2026-03-11").get("u1"),
    ).toBe(1);
  });
});
