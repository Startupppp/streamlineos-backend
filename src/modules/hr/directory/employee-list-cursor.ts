import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

const CURSOR_VERSION = 1;

const employeeListCursorSchema = z
  .object({
    v: z.literal(CURSOR_VERSION),
    name: z.string(),
    employeeUserId: z.string().min(1),
  })
  .strict();

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
    const cursor = employeeListCursorSchema.parse(parsed);

    return {
      name: cursor.name,
      employeeUserId: cursor.employeeUserId,
    };
  } catch {
    throw new BadRequestException({
      code: "INVALID_EMPLOYEE_CURSOR",
      message: "The employee list cursor is invalid or expired.",
    });
  }
}
