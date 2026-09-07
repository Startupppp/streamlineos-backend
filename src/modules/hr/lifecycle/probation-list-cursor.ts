import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

const CURSOR_VERSION = 1;

const probationListCursorSchema = z
  .object({
    v: z.literal(CURSOR_VERSION),
    effectiveEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    probationReviewId: z.number().int().positive(),
  })
  .strict();

export type ProbationListCursor = {
  effectiveEndDate: string;
  probationReviewId: number;
};

export function encodeProbationListCursor(cursor: ProbationListCursor): string {
  return Buffer.from(
    JSON.stringify({
      v: CURSOR_VERSION,
      effectiveEndDate: cursor.effectiveEndDate,
      probationReviewId: cursor.probationReviewId,
    }),
    "utf8",
  ).toString("base64url");
}

export function decodeProbationListCursor(value: string): ProbationListCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const cursor = probationListCursorSchema.parse(parsed);

    return {
      effectiveEndDate: cursor.effectiveEndDate,
      probationReviewId: cursor.probationReviewId,
    };
  } catch {
    throw new BadRequestException({
      code: "INVALID_PROBATION_CURSOR",
      message: "The probation review cursor is invalid or expired.",
    });
  }
}
