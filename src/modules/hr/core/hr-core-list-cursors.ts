import { BadRequestException } from "@nestjs/common";
import { z } from "zod";
import type { DataScope } from "../../access/access.types";

const CURSOR_VERSION = 1;

const peopleCursorSchema = z
  .object({
    version: z.literal(CURSOR_VERSION),
    personId: z.number().int().positive(),
    orgId: z.string().min(1),
    actorUserId: z.string().min(1),
    scope: z.enum(["all", "own", "team", "none"]),
    search: z.string().nullable(),
  })
  .strict();

const employmentCursorSchema = z
  .object({
    version: z.literal(CURSOR_VERSION),
    employmentId: z.number().int().positive(),
    orgId: z.string().min(1),
    actorUserId: z.string().min(1),
    scope: z.enum(["all", "own", "team", "none"]),
  })
  .strict();

const timelinePositionSchema = z
  .object({
    createdAt: z.string().datetime(),
    sourceRecordId: z.number().int().positive(),
  })
  .strict();

const timelineCursorSchema = z
  .object({
    version: z.literal(CURSOR_VERSION),
    asOf: z.string().datetime(),
    orgId: z.string().min(1),
    actorUserId: z.string().min(1),
    employmentId: z.number().int().positive(),
    scope: z.enum(["all", "own", "team", "none"]),
    positions: z
      .object({
        history: timelinePositionSchema.optional(),
        change: timelinePositionSchema.optional(),
        audit: timelinePositionSchema.optional(),
      })
      .strict(),
  })
  .strict();

export type PeopleListCursor = {
  personId: number;
  orgId: string;
  actorUserId: string;
  scope: DataScope;
  search: string | null;
};

export type EmploymentListCursor = {
  employmentId: number;
  orgId: string;
  actorUserId: string;
  scope: DataScope;
};

export type TimelinePosition = z.infer<typeof timelinePositionSchema>;
export type TimelineCursor = z.infer<typeof timelineCursorSchema>;
export type TimelineCursorScope = Pick<
  TimelineCursor,
  "orgId" | "actorUserId" | "employmentId" | "scope"
>;

type PeopleListCursorScope = Omit<PeopleListCursor, "personId">;
type EmploymentListCursorScope = Omit<EmploymentListCursor, "employmentId">;

function invalidPeopleCursor(): never {
  throw new BadRequestException({
    code: "INVALID_PEOPLE_CURSOR",
    message: "The people list cursor is invalid or expired.",
  });
}

function invalidEmploymentCursor(): never {
  throw new BadRequestException({
    code: "INVALID_EMPLOYMENT_CURSOR",
    message: "The employment list cursor is invalid or expired.",
  });
}

function invalidTimelineCursor(): never {
  throw new BadRequestException({
    code: "INVALID_EMPLOYEE_TIMELINE_CURSOR",
    message: "The employee timeline cursor is invalid or expired.",
  });
}

export function encodePeopleListCursor(cursor: PeopleListCursor): string {
  return Buffer.from(
    JSON.stringify({ version: CURSOR_VERSION, ...cursor }),
    "utf8",
  ).toString("base64url");
}

export function decodePeopleListCursor(
  encodedCursor: string,
  expectedScope: PeopleListCursorScope,
): PeopleListCursor {
  try {
    const parsedPayload: unknown = JSON.parse(
      Buffer.from(encodedCursor, "base64url").toString("utf8"),
    );
    const cursor = peopleCursorSchema.parse(parsedPayload);
    if (
      cursor.orgId !== expectedScope.orgId ||
      cursor.actorUserId !== expectedScope.actorUserId ||
      cursor.scope !== expectedScope.scope ||
      cursor.search !== expectedScope.search
    )
      return invalidPeopleCursor();
    return {
      personId: cursor.personId,
      orgId: cursor.orgId,
      actorUserId: cursor.actorUserId,
      scope: cursor.scope,
      search: cursor.search,
    };
  } catch {
    return invalidPeopleCursor();
  }
}

export function encodeEmploymentListCursor(cursor: EmploymentListCursor): string {
  return Buffer.from(
    JSON.stringify({
      version: CURSOR_VERSION,
      ...cursor,
    }),
    "utf8",
  ).toString("base64url");
}

export function decodeEmploymentListCursor(
  encodedCursor: string,
  expectedScope: EmploymentListCursorScope,
): EmploymentListCursor {
  try {
    const parsedPayload: unknown = JSON.parse(
      Buffer.from(encodedCursor, "base64url").toString("utf8"),
    );
    const cursor = employmentCursorSchema.parse(parsedPayload);
    if (
      cursor.orgId !== expectedScope.orgId ||
      cursor.actorUserId !== expectedScope.actorUserId ||
      cursor.scope !== expectedScope.scope
    )
      return invalidEmploymentCursor();
    return {
      employmentId: cursor.employmentId,
      orgId: cursor.orgId,
      actorUserId: cursor.actorUserId,
      scope: cursor.scope,
    };
  } catch {
    return invalidEmploymentCursor();
  }
}

export function encodeTimelineCursor(cursor: TimelineCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeTimelineCursor(
  encodedCursor: string | undefined,
  expectedScope: TimelineCursorScope,
): TimelineCursor {
  if (!encodedCursor) {
    return {
      version: CURSOR_VERSION,
      asOf: new Date().toISOString(),
      ...expectedScope,
      positions: {},
    };
  }

  try {
    const parsedPayload: unknown = JSON.parse(
      Buffer.from(encodedCursor, "base64url").toString("utf8"),
    );
    const cursor = timelineCursorSchema.parse(parsedPayload);
    if (
      new Date(cursor.asOf).getTime() > Date.now() + 60_000 ||
      cursor.orgId !== expectedScope.orgId ||
      cursor.actorUserId !== expectedScope.actorUserId ||
      cursor.employmentId !== expectedScope.employmentId ||
      cursor.scope !== expectedScope.scope
    )
      return invalidTimelineCursor();
    return cursor;
  } catch {
    return invalidTimelineCursor();
  }
}
