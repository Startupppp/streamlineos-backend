import { NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import { decodeTupleCursor, encodeTupleCursor } from "../../../common/pagination/cursor";
import { hrReportingLineBulkJobRows, hrReportingLineBulkJobs } from "../../../db/schema";
import { toCsv } from "../../inventory/import-export/csv.util";
import { REPORTING_LINE_ERROR_CODES as CODES } from "../../directory/reporting-line.types";
import { peopleByEmploymentIds, type PersonRef } from "./reporting-manager-people";
import { BULK_JOB_ROWS_PAGE_CAP, type BulkJob, type BulkJobRow } from "./dto/reporting-lines-bulk.schemas";
import type { ManagerRef } from "./dto/reporting-lines-shared.schemas";

export const BULK_JOB_LIST_PAGE = 20;
/** Addendum 1 Q7: confirmation is required once this many rows would be written. */
export const BULK_CONFIRMATION_THRESHOLD = 10;

export const jobFields = {
  id: hrReportingLineBulkJobs.id,
  status: hrReportingLineBulkJobs.status,
  jobReason: hrReportingLineBulkJobs.jobReason,
  effectiveFrom: hrReportingLineBulkJobs.effectiveFrom,
  rowCount: hrReportingLineBulkJobs.rowCount,
  readyCount: hrReportingLineBulkJobs.readyCount,
  warningCount: hrReportingLineBulkJobs.warningCount,
  errorCount: hrReportingLineBulkJobs.errorCount,
  committedCount: hrReportingLineBulkJobs.committedCount,
  createdBy: hrReportingLineBulkJobs.createdBy,
  createdAt: hrReportingLineBulkJobs.createdAt,
  committedAt: hrReportingLineBulkJobs.committedAt,
  cursorAt: sql<string>`to_char(${hrReportingLineBulkJobs.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`,
  rowReasonRequiredCount: sql<number>`(
    SELECT count(*)::int FROM hr_reporting_line_bulk_job_rows r
    WHERE r.org_id = ${hrReportingLineBulkJobs.orgId} AND r.job_id = ${hrReportingLineBulkJobs.id}
      AND r.status IN ('READY', 'WARNING') AND r.row_reason IS NULL
      AND ',' || coalesce(r.codes, '') || ',' LIKE ${`%,${CODES.CHANGE_REASON_REQUIRED},%`}
  )`,
};

export const rowFields = {
  rowNumber: hrReportingLineBulkJobRows.rowNumber,
  employeeEmail: hrReportingLineBulkJobRows.employeeEmail,
  employeeEmploymentId: hrReportingLineBulkJobRows.employeeEmploymentId,
  requestedPrimaryManagerEmail: hrReportingLineBulkJobRows.requestedPrimaryManagerEmail,
  requestedPrimaryManagerEmploymentId: hrReportingLineBulkJobRows.requestedPrimaryManagerEmploymentId,
  currentPrimaryManagerEmploymentId: hrReportingLineBulkJobRows.currentPrimaryManagerEmploymentId,
  secondaryManagerEmail1: hrReportingLineBulkJobRows.secondaryManagerEmail1,
  secondaryManagerEmail2: hrReportingLineBulkJobRows.secondaryManagerEmail2,
  secondaryManagerEmail3: hrReportingLineBulkJobRows.secondaryManagerEmail3,
  effectiveFrom: hrReportingLineBulkJobRows.effectiveFrom,
  rowReason: hrReportingLineBulkJobRows.rowReason,
  changesLast24h: hrReportingLineBulkJobRows.changesLast24h,
  status: hrReportingLineBulkJobRows.status,
  codes: hrReportingLineBulkJobRows.codes,
  message: hrReportingLineBulkJobRows.message,
};

export type JobRow = Awaited<ReturnType<typeof readJob>>;
export type StoredRow = Awaited<ReturnType<typeof readJobRows>>[number];

export function codesOf(row: { codes: string | null }): string[] {
  return row.codes ? row.codes.split(",").filter((code) => code !== "") : [];
}

export function secondaryEmailsOf(row: {
  secondaryManagerEmail1: string | null;
  secondaryManagerEmail2: string | null;
  secondaryManagerEmail3: string | null;
}): string[] {
  return [row.secondaryManagerEmail1, row.secondaryManagerEmail2, row.secondaryManagerEmail3].flatMap((email) => (email ? [email] : []));
}

export function affectedCount(job: { readyCount: number; warningCount: number }): number {
  return job.readyCount + job.warningCount;
}

/**
 * `createdBy` narrows every job read to one author: a caller whose employees scope is not org-wide
 * sees, reads and commits only the jobs they previewed (undefined = org-wide).
 */
function ownedBy(createdBy: string | undefined) {
  return createdBy === undefined ? undefined : eq(hrReportingLineBulkJobs.createdBy, createdBy);
}

export async function readJob(db: DbOrTx, orgId: string, jobId: string, createdBy?: string) {
  const [job] = await db
    .select(jobFields)
    .from(hrReportingLineBulkJobs)
    .where(
      and(
        eq(hrReportingLineBulkJobs.orgId, orgId),
        eq(hrReportingLineBulkJobs.id, jobId),
        isNull(hrReportingLineBulkJobs.deletedAt),
        ownedBy(createdBy),
      ),
    )
    .limit(1);
  if (!job) throw new NotFoundException("Bulk reporting change not found.");
  return job;
}

/** Every row of a job; a job holds at most 500, so this is bounded by the create cap. */
export function readJobRows(db: DbOrTx, orgId: string, jobId: string, after = 0, limit = 500) {
  return db
    .select(rowFields)
    .from(hrReportingLineBulkJobRows)
    .where(
      and(
        eq(hrReportingLineBulkJobRows.orgId, orgId),
        eq(hrReportingLineBulkJobRows.jobId, jobId),
        gt(hrReportingLineBulkJobRows.rowNumber, after),
      ),
    )
    .orderBy(asc(hrReportingLineBulkJobRows.rowNumber))
    .limit(limit);
}

function refOf(person: PersonRef | undefined): ManagerRef | null {
  if (!person) return null;
  return { userId: person.userId, name: person.name, email: person.email, designation: person.designation, state: person.state };
}

export function summaryOf(job: JobRow) {
  const affected = affectedCount(job);
  const requiresConfirmation = job.status === "PREVIEWED" && affected >= BULK_CONFIRMATION_THRESHOLD;
  return {
    jobId: job.id,
    status: job.status,
    jobReason: job.jobReason,
    rowCount: job.rowCount,
    readyCount: job.readyCount,
    warningCount: job.warningCount,
    errorCount: job.errorCount,
    committedCount: job.committedCount,
    requiresConfirmation,
    confirmationPhrase: requiresConfirmation ? `CONFIRM ${affected}` : null,
    rowReasonRequiredCount: job.status === "PREVIEWED" ? Number(job.rowReasonRequiredCount) : 0,
    createdAt: job.createdAt.toISOString(),
    committedAt: job.committedAt?.toISOString() ?? null,
  };
}

export async function jobView(db: DbOrTx, orgId: string, jobId: string, rowCursor?: string, createdBy?: string): Promise<BulkJob> {
  const job = await readJob(db, orgId, jobId, createdBy);
  const after = Number(decodeTupleCursor(rowCursor, 1)?.[0] ?? 0);
  const fetched = await readJobRows(db, orgId, jobId, Number.isSafeInteger(after) ? after : 0, BULK_JOB_ROWS_PAGE_CAP + 1);
  const page = fetched.slice(0, BULK_JOB_ROWS_PAGE_CAP);
  const people = await peopleByEmploymentIds(
    db,
    orgId,
    page.flatMap((row) =>
      [row.employeeEmploymentId, row.requestedPrimaryManagerEmploymentId, row.currentPrimaryManagerEmploymentId].flatMap((id) =>
        id === null ? [] : [id],
      ),
    ),
  );
  const rows: BulkJobRow[] = page.map((row) => {
    const codes = codesOf(row);
    return {
      rowNumber: row.rowNumber,
      employeeEmail: row.employeeEmail,
      employee: row.employeeEmploymentId === null ? null : refOf(people.get(row.employeeEmploymentId)),
      currentPrimary: row.currentPrimaryManagerEmploymentId === null ? null : refOf(people.get(row.currentPrimaryManagerEmploymentId)),
      requestedPrimary: row.requestedPrimaryManagerEmploymentId === null ? null : refOf(people.get(row.requestedPrimaryManagerEmploymentId)),
      secondaryChanges: secondaryEmailsOf(row),
      changesLast24h: row.changesLast24h,
      requiresRowReason: codes.includes(CODES.CHANGE_REASON_REQUIRED) && !row.rowReason,
      status: row.status,
      codes,
      message: row.message,
    };
  });
  const last = page[page.length - 1];
  return {
    ...summaryOf(job),
    rows,
    nextRowCursor: fetched.length > BULK_JOB_ROWS_PAGE_CAP && last ? encodeTupleCursor([String(last.rowNumber)]) : null,
  };
}

export async function listJobs(db: DbOrTx, orgId: string, cursor: string | undefined, createdBy?: string, limit = BULK_JOB_LIST_PAGE) {
  const parts = decodeTupleCursor(cursor, 2);
  const valid = parts && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/.test(parts[0] ?? "") && /^[0-9a-f-]{36}$/i.test(parts[1] ?? "");
  const rows = await db
    .select(jobFields)
    .from(hrReportingLineBulkJobs)
    .where(
      and(
        eq(hrReportingLineBulkJobs.orgId, orgId),
        isNull(hrReportingLineBulkJobs.deletedAt),
        ownedBy(createdBy),
        valid && parts
          ? sql`(${hrReportingLineBulkJobs.createdAt}, ${hrReportingLineBulkJobs.id}) < ((${parts[0]}::timestamp AT TIME ZONE 'UTC'), ${parts[1]}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(hrReportingLineBulkJobs.createdAt), desc(hrReportingLineBulkJobs.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(summaryOf),
    nextCursor: rows.length > limit && last ? encodeTupleCursor([last.cursorAt, last.id]) : null,
  };
}

const FAILURE_STATUSES = ["ERROR", "SKIPPED", "FAILED"] as const;

export async function failuresCsv(db: DbOrTx, orgId: string, jobId: string, createdBy?: string): Promise<string> {
  await readJob(db, orgId, jobId, createdBy);
  const rows = await db
    .select(rowFields)
    .from(hrReportingLineBulkJobRows)
    .where(
      and(
        eq(hrReportingLineBulkJobRows.orgId, orgId),
        eq(hrReportingLineBulkJobRows.jobId, jobId),
        inArray(hrReportingLineBulkJobRows.status, [...FAILURE_STATUSES]),
      ),
    )
    .orderBy(asc(hrReportingLineBulkJobRows.rowNumber))
    .limit(500);
  return toCsv(
    ["rowNumber", "employeeEmail", "primaryManagerEmail", "status", "codes", "message"],
    rows.map((row) => ({
      rowNumber: row.rowNumber,
      employeeEmail: row.employeeEmail,
      primaryManagerEmail: row.requestedPrimaryManagerEmail ?? "",
      status: row.status,
      codes: codesOf(row).join(" "),
      message: row.message ?? "",
    })),
  );
}
