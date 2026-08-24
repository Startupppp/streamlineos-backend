process.env.APP_URL ??= "http://localhost:1000";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAttendanceRegularizationSchema,
} from "./dto/attendance.schemas";
import { updateLeaveSchema } from "./dto/leaves.schemas";

const readSource = (fileName: string) =>
  readFileSync(join(__dirname, fileName), "utf8");

/** Local calendar date, matching what the schema compares against. */
const localDateShift = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

describe("HR time transition invariants", () => {
  it("accepts only the dedicated revert-to-pending contract", () => {
    expect(updateLeaveSchema.safeParse({ status: "PENDING" }).success).toBe(true);
    expect(updateLeaveSchema.safeParse({ status: "APPROVED" }).success).toBe(false);
    expect(updateLeaveSchema.safeParse({ status: "REJECTED" }).success).toBe(false);
    expect(updateLeaveSchema.safeParse({ status: "PENDING", reason: "extra" }).success).toBe(false);
  });

  it("validates regularization correction shape before persistence", () => {
    const recent = localDateShift(-3);

    expect(
      createAttendanceRegularizationSchema.safeParse({
        attendanceDate: recent,
        reason: "Correct an omitted attendance punch",
      }).success,
    ).toBe(false);
    expect(
      createAttendanceRegularizationSchema.safeParse({
        attendanceDate: recent,
        requestedCheckIn: `${recent}T10:00:00.000Z`,
        requestedCheckOut: `${recent}T09:00:00.000Z`,
        reason: "Correct an invalid attendance punch",
      }).success,
    ).toBe(false);
    expect(
      createAttendanceRegularizationSchema.safeParse({
        attendanceDate: recent,
        requestedCheckIn: `${recent}T09:00:00.000Z`,
        requestedCheckOut: `${recent}T18:00:00.000Z`,
        reason: "Correct an omitted attendance punch",
      }).success,
    ).toBe(true);
  });

  it("bounds a regularization to a real, recent date the times fall on", () => {
    const shift = localDateShift;
    const reason = "Correct an omitted attendance punch";
    const parse = (attendanceDate: string, checkIn: string) =>
      createAttendanceRegularizationSchema.safeParse({
        attendanceDate,
        requestedCheckIn: checkIn,
        reason,
      }).success;

    const future = shift(5);
    expect(parse(future, `${future}T09:00:00.000Z`)).toBe(false);

    const tooOld = shift(-90);
    expect(parse(tooOld, `${tooOld}T09:00:00.000Z`)).toBe(false);

    expect(parse("2026-02-31", `${shift(-1)}T09:00:00.000Z`)).toBe(false);

    const recent = shift(-2);
    expect(parse(recent, "2019-01-01T09:00:00.000Z")).toBe(false);
    expect(parse(recent, `${recent}T09:00:00.000Z`)).toBe(true);
  });

  it("keeps leave transitions conditional, versioned, and balance-locked", () => {
    const approval = readSource("leaves-approval.service.ts");
    const write = readSource("leaves-write.service.ts");
    expect(approval).toContain('.for("update")');
    expect(approval).toContain("eq(leaveRequests.rowVersion, current.rowVersion)");
    expect(approval).toContain(".returning({ id: leaveRequests.id })");
    expect(write).toContain("eq(leaveRequests.rowVersion, current.rowVersion)");
    expect(write).toContain("pg_advisory_xact_lock");
  });

  it("keeps regularization creation and decisions transactional", () => {
    const source = readSource("attendance-regularization.service.ts");
    expect(source).toContain("pg_advisory_xact_lock");
    expect(source).toContain("tx,");
    expect(source).toContain("eq(hrAttendanceRegularizations.status, \"PENDING\")");
    expect(source).toContain(".returning({ id: hrAttendanceRegularizations.id })");
    expect(source).not.toContain(".catch(() => null)");
  });

  it("keeps leave page GET data free of write calls", () => {
    const source = readSource("leaves-page.service.ts");
    expect(source).not.toMatch(/\.insert\s*\(/);
    expect(source).not.toMatch(/\.update\s*\(/);
    expect(source).not.toMatch(/\.delete\s*\(/);
  });
});
