import { BadRequestException, ConflictException } from "@nestjs/common";
import {
  isExclusionViolation,
  isUniqueViolation,
  isUniqueViolationOn,
} from "../../common/db/postgres-error";

export const ENGAGEMENT_ERROR = {
  DATE_OVERLAP: "WORKER_ENGAGEMENT_DATE_OVERLAP",
  PRIMARY_EXISTS: "WORKER_PRIMARY_ENGAGEMENT_EXISTS",
  INVALID_DATES: "WORKER_ENGAGEMENT_INVALID_DATES",
  NOT_PLANNED: "WORKER_ENGAGEMENT_NOT_PLANNED",
  STALE: "WORKER_ENGAGEMENT_STALE",
  NOT_ACTIVE: "WORKER_ENGAGEMENT_NOT_ACTIVE",
} as const;

export const WORKER_ERROR = {
  NUMBER_RESERVED: "WORKER_NUMBER_RESERVED",
  PERSON_ALREADY_WORKER: "WORKER_PERSON_ALREADY_EXISTS",
} as const;

export const WORKER_NUMBER_UNIQUE_CONSTRAINTS = [
  "uniq_workers_org_number",
  "uniq_workers_active_org_number",
];

export function workerNumberReservedMessage(workerNumber: string): string {
  return `Worker number "${workerNumber}" is already used in this organization and stays reserved even after a worker is archived. Enter a different worker number.`;
}

export function throwWorkerCreateError(
  error: unknown,
  workerNumber: string | null | undefined,
): never {
  if (isUniqueViolationOn(error, ...WORKER_NUMBER_UNIQUE_CONSTRAINTS))
    throw new ConflictException({
      code: WORKER_ERROR.NUMBER_RESERVED,
      message: workerNumberReservedMessage(workerNumber ?? ""),
    });
  if (isUniqueViolation(error))
    throw new ConflictException({
      code: WORKER_ERROR.PERSON_ALREADY_WORKER,
      message: "This person is already a worker in this organization.",
    });
  throw error;
}

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
  if (isUniqueViolation(error)) {
    throw new ConflictException({
      code: ENGAGEMENT_ERROR.PRIMARY_EXISTS,
      message:
        "This worker already has an active primary engagement. Unmark Primary, or end the current primary engagement first.",
    });
  }
  if (isExclusionViolation(error)) {
    throw new ConflictException({
      code: ENGAGEMENT_ERROR.DATE_OVERLAP,
      message:
        "These dates overlap an existing planned or active engagement. Change the dates, or cancel or end the existing engagement first.",
    });
  }
  throw error;
}
