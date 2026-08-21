import { BadRequestException } from "@nestjs/common";

const CURSOR_VERSION = 1;

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
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { v?: unknown }).v !== CURSOR_VERSION ||
      typeof (parsed as { effectiveEndDate?: unknown }).effectiveEndDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(
        (parsed as { effectiveEndDate: string }).effectiveEndDate,
      ) ||
      typeof (parsed as { probationReviewId?: unknown }).probationReviewId !== "number" ||
      !Number.isSafeInteger(
        (parsed as { probationReviewId: number }).probationReviewId,
      ) ||
      (parsed as { probationReviewId: number }).probationReviewId <= 0
    ) {
      throw new Error("invalid cursor payload");
    }

    return {
      effectiveEndDate: (parsed as { effectiveEndDate: string }).effectiveEndDate,
      probationReviewId: (parsed as { probationReviewId: number }).probationReviewId,
    };
  } catch {
    throw new BadRequestException({
      code: "INVALID_PROBATION_CURSOR",
      message: "The probation review cursor is invalid or expired.",
    });
  }
}
