import { sql } from "drizzle-orm";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { lockReportingLines } from "../../../common/hr/sync-canonical-reporting-line";
import { ReportingRelationshipService } from "../../directory/reporting-relationship.service";
import { ReportingLineException } from "../../directory/reporting-line-errors";
import { inForceOn, relationshipsBetween } from "../../directory/reporting-line-queries";
import { REPORTING_LINE_ERROR_CODES as CODES } from "../../directory/reporting-line.types";
import { peopleByEmails, peopleByEmploymentIds } from "./reporting-manager-people";
import { secondaryEmailsOf, type StoredRow } from "./reporting-line-bulk-jobs-read";

export async function applyBulkRows(
  tx: DbOrTx,
  relationships: ReportingRelationshipService,
  actor: CurrentUserContext,
  jobReason: string,
  jobId: string,
  rows: readonly StoredRow[],
  supplied: ReadonlyMap<number, string>,
): Promise<Array<{ rowNumber: number; status: "COMMITTED" | "FAILED"; codes: string | null; message: string | null; beforeLineId: number | null; afterLineId: number | null }>> {
  const orgId = actor.orgId;
  // Held for the whole commit (setRelationships takes it again, re-entrantly), so the current
  // primary read below for "unchanged" rows cannot move before it is written back.
  await lockReportingLines(tx, orgId);
  const managerIds = rows.flatMap((row) => (row.requestedPrimaryManagerEmploymentId === null ? [] : [row.requestedPrimaryManagerEmploymentId]));
  const keepIds = rows.flatMap((row) => (row.requestedPrimaryManagerEmploymentId === null && row.employeeEmploymentId !== null ? [row.employeeEmploymentId] : []));
  const days = rows.map((row) => row.effectiveFrom ?? "").filter((day) => day !== "").sort();
  const [managers, secondaries, current] = await Promise.all([
    peopleByEmploymentIds(tx, orgId, managerIds),
    peopleByEmails(tx, orgId, rows.flatMap(secondaryEmailsOf)),
    relationshipsBetween(tx, orgId, keepIds, days[0] ?? "", days[days.length - 1] ?? ""),
  ]);
  const outcomes = [];
  for (const row of rows) {
    // A blank primary keeps whoever is the primary manager NOW, not whoever it was at preview.
    const managerUserId =
      row.requestedPrimaryManagerEmploymentId !== null
        ? managers.get(row.requestedPrimaryManagerEmploymentId)?.userId || null
        : current.find((line) => line.primary && line.employmentId === row.employeeEmploymentId && inForceOn(line, row.effectiveFrom ?? ""))
            ?.managerUserId ?? null;
    const secondaryEmails = secondaryEmailsOf(row);
    try {
      if (row.employeeEmploymentId === null || managerUserId === null)
        throw new ReportingLineException(CODES.MANAGER_NOT_FOUND, "The employee or manager is no longer available.");
      const result = await tx.transaction((rowTx) =>
        relationships.setRelationships(rowTx, {
          orgId,
          actor,
          subjectEmploymentId: row.employeeEmploymentId ?? 0,
          primaryManagerUserId: managerUserId,
          secondary:
            secondaryEmails.length > 0
              ? secondaryEmails.flatMap((email) => {
                  const person = secondaries.get(email);
                  return person ? [{ managerUserId: person.userId }] : [];
                })
              : undefined,
          effectiveFrom: row.effectiveFrom ?? "",
          source: "BULK_REASSIGNMENT",
          reason: supplied.get(row.rowNumber) ?? row.rowReason ?? jobReason,
          bulkJobId: jobId,
        }),
      );
      outcomes.push({
        rowNumber: row.rowNumber,
        status: "COMMITTED" as const,
        codes: row.codes,
        message: null,
        beforeLineId: result.before.primary?.lineId ?? null,
        afterLineId: result.after.primary?.lineId ?? null,
      });
    } catch (error) {
      if (!(error instanceof ReportingLineException)) throw error;
      outcomes.push({ rowNumber: row.rowNumber, status: "FAILED" as const, codes: error.code, message: error.message, beforeLineId: null, afterLineId: null });
    }
  }
  return outcomes;
}

/** One statement for every row's outcome, instead of one UPDATE per row. */
export async function recordBulkOutcomes(
  tx: DbOrTx,
  orgId: string,
  jobId: string,
  outcomes: ReadonlyArray<{ rowNumber: number; status: string; codes: string | null; message: string | null; beforeLineId: number | null; afterLineId: number | null }>,
): Promise<void> {
  if (outcomes.length === 0) return;
  await tx.execute(sql`
    UPDATE hr_reporting_line_bulk_job_rows AS r
    SET status = o.status, codes = o.codes, message = o.message, before_line_id = o.before_line_id, after_line_id = o.after_line_id
    FROM unnest(
      ${sql.param(outcomes.map((o) => o.rowNumber))}::int[],
      ${sql.param(outcomes.map((o) => o.status))}::text[],
      ${sql.param(outcomes.map((o) => o.codes))}::text[],
      ${sql.param(outcomes.map((o) => o.message))}::text[],
      ${sql.param(outcomes.map((o) => o.beforeLineId))}::int[],
      ${sql.param(outcomes.map((o) => o.afterLineId))}::int[]
    ) AS o(row_number, status, codes, message, before_line_id, after_line_id)
    WHERE r.org_id = ${orgId} AND r.job_id = ${jobId}::uuid AND r.row_number = o.row_number
  `);
}
