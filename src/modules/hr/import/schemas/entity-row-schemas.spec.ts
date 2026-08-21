import { attendanceRowSchema } from "./entity-row-schemas";

describe("attendance import status contract", () => {
  const baseRow = {
    employeeEmail: "employee@example.com",
    date: "2026-08-01",
  };

  it.each([
    "PRESENT",
    "ON_BREAK",
    "CHECKED_OUT",
    "ABSENT",
    "HALF_DAY",
    "LATE",
    "WFH",
    "HALFDAY",
    "HOLIDAY_WORK",
    "LEAVE_WITHOUT_PAY",
  ])("accepts the supported %s status", (status) => {
    expect(attendanceRowSchema.parse({ ...baseRow, status }).status).toBe(status);
  });

  it("rejects an unrecognized status before the database check does", () => {
    expect(
      attendanceRowSchema.safeParse({ ...baseRow, status: "UNKNOWN" }).success,
    ).toBe(false);
  });
});
