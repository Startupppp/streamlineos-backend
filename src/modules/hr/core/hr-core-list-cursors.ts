import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

const CURSOR_VERSION = 1;

const peopleCursorSchema = z
  .object({
    version: z.literal(CURSOR_VERSION),
    personId: z.number().int().positive(),
  })
  .strict();

const employmentCursorSchema = z
  .object({
    version: z.literal(CURSOR_VERSION),
    employmentId: z.number().int().positive(),
  })
  .strict();

export type PeopleListCursor = {
  personId: number;
};

export type EmploymentListCursor = {
  employmentId: number;
};

export function encodePeopleListCursor(cursor: PeopleListCursor): string {
  return Buffer.from(
    JSON.stringify({ version: CURSOR_VERSION, personId: cursor.personId }),
    "utf8",
  ).toString("base64url");
}

export function decodePeopleListCursor(encodedCursor: string): PeopleListCursor {
  try {
    const parsedPayload: unknown = JSON.parse(
      Buffer.from(encodedCursor, "base64url").toString("utf8"),
    );
    const cursor = peopleCursorSchema.parse(parsedPayload);
    return { personId: cursor.personId };
  } catch {
    throw new BadRequestException({
      code: "INVALID_PEOPLE_CURSOR",
      message: "The people list cursor is invalid or expired.",
    });
  }
}

export function encodeEmploymentListCursor(cursor: EmploymentListCursor): string {
  return Buffer.from(
    JSON.stringify({
      version: CURSOR_VERSION,
      employmentId: cursor.employmentId,
    }),
    "utf8",
  ).toString("base64url");
}

export function decodeEmploymentListCursor(
  encodedCursor: string,
): EmploymentListCursor {
  try {
    const parsedPayload: unknown = JSON.parse(
      Buffer.from(encodedCursor, "base64url").toString("utf8"),
    );
    const cursor = employmentCursorSchema.parse(parsedPayload);
    return { employmentId: cursor.employmentId };
  } catch {
    throw new BadRequestException({
      code: "INVALID_EMPLOYMENT_CURSOR",
      message: "The employment list cursor is invalid or expired.",
    });
  }
}
