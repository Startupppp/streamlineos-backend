/** One page of a job's rows, for the detail view. The job's counts are exact. */
export const JOB_ROWS_PAGE_LIMIT = 100;

/**
 * The error report is a download, so it is not paged at 100 like a list — a
 * report truncated to a screenful is not a report. It is still bounded, and
 * says when it hit the bound.
 */
export const ERROR_REPORT_LIMIT = 5_000;

export const SIGNING_RECIPIENT_TYPES = ["signer", "approver", "in_person_host", "internal_reviewer"];
export const ACTIVE_JOB_STATUSES = ["pending", "validating", "running"] as const;
