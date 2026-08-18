import { BadRequestException, ConflictException } from "@nestjs/common";
import { getPostgresErrorCode } from "../../common/db/postgres-error";

const PG_UNIQUE_VIOLATION = "23505";
const PG_EXCLUSION_VIOLATION = "23P01";

export const ENGAGEMENT_ERROR = {
  DATE_OVERLAP: "WORKER_ENGAGEMENT_DATE_OVERLAP",
  PRIMARY_EXISTS: "WORKER_PRIMARY_ENGAGEMENT_EXISTS",
  INVALID_DATES: "WORKER_ENGAGEMENT_INVALID_DATES",
  NOT_PLANNED: "WORKER_ENGAGEMENT_NOT_PLANNED",
  STALE: "WORKER_ENGAGEMENT_STALE",
  NOT_ACTIVE: "WORKER_ENGAGEMENT_NOT_ACTIVE",
} as const;

export function assertValidEngagementPeriod(
  startsOn: string,
  endsOn?: string | null,
): void {
  if (!endsOn || endsOn > startsOn) return;
  throw new BadRequestException({
    code: ENGAGEMENT_ERROR.INVALID_DATES,
    message: "End date must be after the start date.",
  });
}

export function throwEngagementWriteError(error: unknown): never {
  const code = getPostgresErrorCode(error);
  if (code === PG_UNIQUE_VIOLATION) {
    throw new ConflictException({
      code: ENGAGEMENT_ERROR.PRIMARY_EXISTS,
      message:
        "This worker already has an active primary engagement. Unmark Primary, or end the current primary engagement first.",
    });
  }
  if (code === PG_EXCLUSION_VIOLATION) {
    throw new ConflictException({
      code: ENGAGEMENT_ERROR.DATE_OVERLAP,
      message:
        "These dates overlap an existing planned or active engagement. Change the dates, or cancel or end the existing engagement first.",
    });
  }
  throw error;
}
