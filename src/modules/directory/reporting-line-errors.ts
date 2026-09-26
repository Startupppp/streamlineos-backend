import { HttpException, HttpStatus } from "@nestjs/common";
import { isExclusionViolation, isUniqueViolationOn } from "../../common/db/postgres-error";
import { REPORTING_LINE_ERROR_CODES, type ReportingLineErrorCode } from "./reporting-line.types";

export const REPORTING_LINE_ERROR_STATUS: Record<ReportingLineErrorCode, HttpStatus> = {
  SELF_REFERENCE: HttpStatus.BAD_REQUEST,
  MANAGER_NOT_ELIGIBLE: HttpStatus.BAD_REQUEST,
  MANAGER_NOT_FOUND: HttpStatus.BAD_REQUEST,
  PRIMARY_CYCLE: HttpStatus.BAD_REQUEST,
  SECONDARY_DUPLICATES_PRIMARY: HttpStatus.BAD_REQUEST,
  SECONDARY_DUPLICATE: HttpStatus.BAD_REQUEST,
  SECONDARY_CAP_EXCEEDED: HttpStatus.BAD_REQUEST,
  TOP_LEVEL_WITH_MANAGER: HttpStatus.BAD_REQUEST,
  TOP_LEVEL_REASON_REQUIRED: HttpStatus.BAD_REQUEST,
  TOP_LEVEL_NOT_ALLOWED: HttpStatus.BAD_REQUEST,
  NO_DEFAULT_REPORTING_MANAGER: HttpStatus.BAD_REQUEST,
  CHANGE_REASON_REQUIRED: HttpStatus.BAD_REQUEST,
  ELEVATED_AUTHORITY_REQUIRED: HttpStatus.FORBIDDEN,
  INVALID_EFFECTIVE_DATE: HttpStatus.BAD_REQUEST,
  EMPLOYEE_NOT_FOUND: HttpStatus.NOT_FOUND,
  REQUEST_INVALID_TRANSITION: HttpStatus.CONFLICT,
  REQUEST_DUPLICATE_ACTIVE: HttpStatus.CONFLICT,
  MANAGER_COLUMN_CONFLICT: HttpStatus.BAD_REQUEST,
  MANAGER_ROW_FAILED: HttpStatus.BAD_REQUEST,
};

export interface ReportingLineIssue {
  code: ReportingLineErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** The one exception every reporting-line refusal is thrown as; `AllExceptionsFilter` renders `{ code, message, details? }`. */
export class ReportingLineException extends HttpException {
  readonly code: ReportingLineErrorCode;

  constructor(code: ReportingLineErrorCode, message: string, details?: Record<string, unknown>) {
    super({ code, message, ...(details ? { details } : {}) }, REPORTING_LINE_ERROR_STATUS[code]);
    this.code = code;
  }

  static of(issue: ReportingLineIssue): ReportingLineException {
    return new ReportingLineException(issue.code, issue.message, issue.details);
  }
}

/**
 * A concurrent writer that slipped past the advisory lock (or a caller writing outside it) meets
 * the exclusion constraint or the open-primary unique index; either way the employee already has a
 * line for those dates, which is a date problem the caller can fix, never a 500.
 */
export function rethrowReportingLineWriteError(error: unknown): never {
  if (isExclusionViolation(error) || isUniqueViolationOn(error, "uniq_hr_reporting_lines_open_primary"))
    throw new ReportingLineException(
      REPORTING_LINE_ERROR_CODES.INVALID_EFFECTIVE_DATE,
      "Another reporting-line change for this employee was saved at the same time. Reload and try again.",
    );
  if (isUniqueViolationOn(error, "uniq_hr_rm_requests_active"))
    throw new ReportingLineException(
      REPORTING_LINE_ERROR_CODES.REQUEST_DUPLICATE_ACTIVE,
      "There is already an open request to review this employee's manager.",
    );
  throw error;
}
