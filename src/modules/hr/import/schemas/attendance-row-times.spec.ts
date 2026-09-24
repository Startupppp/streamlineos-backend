import { attendanceRowSchema, todayInTimeZone } from "./entity-row-schemas";

/**
 * HRMS-E2E-005b. QA's fixture previewed `19:00 -> 09:00` as valid: nothing
 * compared the two times, so a negative working day reached the attendance
 * ledger that every hours-worked and payable-days read then counts.
 */
describe("attendance import times", () => {
  const row = { employeeEmail: "employee@example.com", date: "2026-09-21" };

  it("accepts a day that runs forwards", () => {
    expect(attendanceRowSchema.safeParse({ ...row, checkIn: "09:30", checkOut: "18:00" }).success).toBe(true);
  });

  it("rejects a check-out that precedes check-in", () => {
    const result = attendanceRowSchema.safeParse({ ...row, checkIn: "19:00", checkOut: "09:00" });
    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues[0]?.message).toContain("later than check-in");
  });

  it("rejects a check-out equal to check-in", () => {
    expect(attendanceRowSchema.safeParse({ ...row, checkIn: "09:00", checkOut: "09:00" }).success).toBe(false);
  });

  it("accepts a row that carries only one of the two times", () => {
    expect(attendanceRowSchema.safeParse({ ...row, checkIn: "09:30" }).success).toBe(true);
    expect(attendanceRowSchema.safeParse({ ...row, checkOut: "18:00" }).success).toBe(true);
  });

  it("rejects a time that is not a 24-hour wall clock", () => {
    expect(attendanceRowSchema.safeParse({ ...row, checkIn: "9:30 AM" }).success).toBe(false);
    expect(attendanceRowSchema.safeParse({ ...row, checkIn: "25:00" }).success).toBe(false);
  });
});

describe("attendance import future-date check", () => {
  it("reads the calendar day in the organisation's zone, not the host's", () => {
    // 2026-09-24T19:00Z is already the 25th in Kolkata and still the 24th in UTC.
    const instant = new Date("2026-09-24T19:00:00Z");
    expect(todayInTimeZone("Asia/Kolkata", instant)).toBe("2026-09-25");
    expect(todayInTimeZone("UTC", instant)).toBe("2026-09-24");
  });

  it("rejects tomorrow", () => {
    const tomorrow = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const result = attendanceRowSchema.safeParse({
      employeeEmail: "employee@example.com",
      date: tomorrow,
    });
    expect(result.success).toBe(false);
  });

  it("accepts today in the organisation's zone", () => {
    const result = attendanceRowSchema.safeParse({
      employeeEmail: "employee@example.com",
      date: todayInTimeZone(),
    });
    expect(result.success).toBe(true);
  });
});
