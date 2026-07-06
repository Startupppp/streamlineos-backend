import { addWorkingMinutes, type BusinessHoursConfig } from "./support-business-hours.util";

const NINE_TO_FIVE_WEEKDAYS: BusinessHoursConfig = {
  timezone: "UTC",
  weeklySchedule: {
    mon: { start: "09:00", end: "17:00" },
    tue: { start: "09:00", end: "17:00" },
    wed: { start: "09:00", end: "17:00" },
    thu: { start: "09:00", end: "17:00" },
    fri: { start: "09:00", end: "17:00" },
  },
  holidays: [],
  is24x7: false,
};

describe("addWorkingMinutes", () => {
  it("adds plain calendar time when no business hours are configured", () => {
    const from = new Date("2026-03-02T10:00:00.000Z"); // Monday
    const result = addWorkingMinutes(from, 120, null);
    expect(result.toISOString()).toBe("2026-03-02T12:00:00.000Z");
  });

  it("adds plain calendar time when business hours are marked 24x7", () => {
    const from = new Date("2026-03-02T10:00:00.000Z");
    const result = addWorkingMinutes(from, 120, { ...NINE_TO_FIVE_WEEKDAYS, is24x7: true });
    expect(result.toISOString()).toBe("2026-03-02T12:00:00.000Z");
  });

  it("stays within the same working day when there's enough time left", () => {
    const from = new Date("2026-03-02T10:00:00.000Z"); // Monday 10:00 UTC
    const result = addWorkingMinutes(from, 60, NINE_TO_FIVE_WEEKDAYS);
    expect(result.toISOString()).toBe("2026-03-02T11:00:00.000Z");
  });

  it("rolls over the weekend to the next Monday when the window is exceeded", () => {
    const from = new Date("2026-03-06T16:30:00.000Z"); // Friday 16:30 UTC (30 min left before 17:00)
    const result = addWorkingMinutes(from, 60, NINE_TO_FIVE_WEEKDAYS); // needs 30 more minutes
    // Friday consumes 30 min (16:30->17:00), remaining 30 min rolls to Monday 09:00 -> 09:30
    expect(result.toISOString()).toBe("2026-03-09T09:30:00.000Z");
  });

  it("skips a configured holiday", () => {
    const from = new Date("2026-03-02T16:00:00.000Z"); // Monday 16:00 UTC, 60 min left before 17:00
    const withHoliday: BusinessHoursConfig = { ...NINE_TO_FIVE_WEEKDAYS, holidays: ["2026-03-03"] }; // Tuesday off
    const result = addWorkingMinutes(from, 120, withHoliday); // 60 min today, 60 min needed after -> skip Tue -> Wed 09:00 + 60
    expect(result.toISOString()).toBe("2026-03-04T10:00:00.000Z");
  });

  it("jumps forward from a time before the working window starts", () => {
    const from = new Date("2026-03-02T05:00:00.000Z"); // Monday 05:00 UTC, before 09:00 window
    const result = addWorkingMinutes(from, 30, NINE_TO_FIVE_WEEKDAYS);
    expect(result.toISOString()).toBe("2026-03-02T09:30:00.000Z");
  });

  it("jumps to the next working day from a time after the working window ends", () => {
    const from = new Date("2026-03-02T20:00:00.000Z"); // Monday 20:00 UTC, after 17:00 window
    const result = addWorkingMinutes(from, 30, NINE_TO_FIVE_WEEKDAYS);
    expect(result.toISOString()).toBe("2026-03-03T09:30:00.000Z");
  });
});
