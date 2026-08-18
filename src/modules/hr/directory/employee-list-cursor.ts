import { BadRequestException } from "@nestjs/common";

const CURSOR_VERSION = 1;

export type EmployeeListCursor = {
  name: string;
  employeeUserId: string;
};

export function encodeEmployeeListCursor(cursor: EmployeeListCursor): string {
  return Buffer.from(
    JSON.stringify({
      v: CURSOR_VERSION,
      name: cursor.name,
      employeeUserId: cursor.employeeUserId,
    }),
    "utf8",
  ).toString("base64url");
}

export function decodeEmployeeListCursor(value: string): EmployeeListCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { v?: unknown }).v !== CURSOR_VERSION ||
      typeof (parsed as { name?: unknown }).name !== "string" ||
      typeof (parsed as { employeeUserId?: unknown }).employeeUserId !== "string" ||
      (parsed as { employeeUserId: string }).employeeUserId.length === 0
    ) {
      throw new Error("invalid cursor payload");
    }

    return {
      name: (parsed as { name: string }).name,
      employeeUserId: (parsed as { employeeUserId: string }).employeeUserId,
    };
  } catch {
    throw new BadRequestException({
      code: "INVALID_EMPLOYEE_CURSOR",
      message: "The employee list cursor is invalid or expired.",
    });
  }
}
