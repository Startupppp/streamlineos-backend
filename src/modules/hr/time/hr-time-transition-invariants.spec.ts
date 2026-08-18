process.env.APP_URL ??= "http://localhost:1000";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAttendanceRegularizationSchema,
} from "./dto/attendance.schemas";
import { updateLeaveSchema } from "./dto/leaves.schemas";

const readSource = (fileName: string) =>
  readFileSync(join(__dirname, fileName), "utf8");

describe("HR time transition invariants", () => {
  it("accepts only the dedicated revert-to-pending contract", () => {
    expect(updateLeaveSchema.safeParse({ status: "PENDING" }).success).toBe(true);
    expect(updateLeaveSchema.safeParse({ status: "APPROVED" }).success).toBe(false);
    expect(updateLeaveSchema.safeParse({ status: "REJECTED" }).success).toBe(false);
    expect(updateLeaveSchema.safeParse({ status: "PENDING", reason: "extra" }).success).toBe(false);
  });

  it("validates regularization correction shape before persistence", () => {
    expect(
      createAttendanceRegularizationSchema.safeParse({
        attendanceDate: "2026-08-13",
        reason: "Correct an omitted attendance punch",
      }).success,
    ).toBe(false);
    expect(
      createAttendanceRegularizationSchema.safeParse({
        attendanceDate: "2026-08-13",
        requestedCheckIn: "2026-08-13T10:00:00.000Z",
        requestedCheckOut: "2026-08-13T09:00:00.000Z",
        reason: "Correct an invalid attendance punch",
      }).success,
    ).toBe(false);
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
