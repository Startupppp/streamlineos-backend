import { BadRequestException } from "@nestjs/common";
import { encodeCursor } from "../../common/pagination/cursor";
import {
  decodePayrollIdCursor,
  decodePayrollNumberTextCursor,
  decodePayrollTimestampCursor,
  payrollCursorPosition,
} from "./payroll-cursor";

describe("payroll scoped cursors", () => {
  const scope = ["filings", "org-1", "OPEN"] as const;

  it("round-trips every ordering component and the unique id", () => {
    const createdAt = new Date("2026-09-01T10:00:00.000Z");
    const cursor = encodeCursor(
      payrollCursorPosition(scope, [createdAt.toISOString()], 42),
    );

    expect(decodePayrollTimestampCursor(cursor, scope)).toEqual({
      createdAt,
      id: 42,
    });
  });

  it.each([
    ["malformed", "not-a-cursor", scope],
    ["cross-tenant", encodeCursor(payrollCursorPosition(["filings", "org-2", "OPEN"], [1], 1)), scope],
    ["filter change", encodeCursor(payrollCursorPosition(["filings", "org-1", "CLOSED"], [1], 1)), scope],
  ])("rejects a %s cursor before query construction", (_label, cursor, expectedScope) => {
    expect(() => decodePayrollIdCursor(cursor, expectedScope)).toThrow(
      BadRequestException,
    );
  });

  it("rejects a cursor whose outer order tuple disagrees with its scoped payload", () => {
    const cursor = encodeCursor({
      sortValue: JSON.stringify([99, "Basic"]),
      id: JSON.stringify([["components", "org-1"], [10, "Basic"], 7]),
    });

    expect(() =>
      decodePayrollNumberTextCursor(cursor, ["components", "org-1"]),
    ).toThrow(BadRequestException);
  });
});
