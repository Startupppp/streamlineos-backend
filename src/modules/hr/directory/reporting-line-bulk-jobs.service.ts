import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { OrgHierarchyCacheService } from "../../../common/cache/org-hierarchy-cache.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import {
  hrReportingLineBulkJobRows,
  hrReportingLineBulkJobs,
  type ReportingLineBulkRowStatus,
} from "../../../db/schema";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { ReportingRelationshipService } from "../../directory/reporting-relationship.service";
import { ReportingLineException } from "../../directory/reporting-line-errors";
import { relationshipsBetween } from "../../directory/reporting-line-queries";
import {
  REPORTING_LINE_ERROR_CODES as CODES,
  type RelationshipValidation,
  type SetRelationshipsCommand,
} from "../../directory/reporting-line.types";
import { orgBusinessDate } from "../time/attendance-business-date";
import { invalidateReportingReads } from "./reporting-lines.service";
import { peopleByEmails, peopleByEmploymentIds, peopleByUserIds, type PersonRef } from "./reporting-manager-people";
import {
  BULK_CONFIRMATION_THRESHOLD,
  affectedCount,
  codesOf,
  failuresCsv,
  jobView,
  listJobs,
  readJob,
  readJobRows,
  secondaryEmailsOf,
  type StoredRow,
} from "./reporting-line-bulk-jobs-read";
import type { BulkJob, CommitBulkJobInput, CreateBulkJobInput } from "./dto/reporting-lines-bulk.schemas";

/** A preview older than this describes a hierarchy that may have moved on; it must be re-run. */
export const BULK_JOB_PREVIEW_TTL_HOURS = 24;
const COMMITTED_EVENT = "hr.reporting_line_bulk_job.committed";

export interface PlannedRow {
  rowNumber: number;
  employeeEmail: string;
  employee: PersonRef | undefined;
  primaryManagerEmail: string | null;
  primaryManager: PersonRef | undefined;
  secondaryEmails: string[];
  secondary: Array<PersonRef | undefined>;
  effectiveFrom: string;
  reason: string | null;
  issues: Array<{ code: string; message: string }>;
}

function meaningful(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function classifyBulkRow(
  row: PlannedRow,
  validation: RelationshipValidation | undefined,
  currentOf: Map<number, { managerEmploymentId: number }>,
): Omit<typeof hrReportingLineBulkJobRows.$inferInsert, "orgId" | "jobId"> {
  const needsReasonOnly = validation?.issues.every((issue) => issue.code === CODES.CHANGE_REASON_REQUIRED) ?? false;
  const issues = [...row.issues, ...(validation && !needsReasonOnly ? validation.issues : [])];
  const warnings = validation?.warnings ?? [];
  const reasonCodes = validation && !validation.ok && needsReasonOnly ? [CODES.CHANGE_REASON_REQUIRED] : [];
  const status: ReportingLineBulkRowStatus =
    issues.length > 0 ? "ERROR" : warnings.length > 0 || reasonCodes.length > 0 ? "WARNING" : "READY";
  const codes = [...new Set([...issues.map((issue) => issue.code), ...reasonCodes, ...warnings])];
  const employmentId = row.employee?.employmentId ?? null;
  return {
    rowNumber: row.rowNumber,
    employeeEmail: row.employeeEmail,
    employeeEmploymentId: employmentId,
    requestedPrimaryManagerEmail: row.primaryManagerEmail,
    requestedPrimaryManagerEmploymentId: validation?.primaryManagerEmploymentId ?? row.primaryManager?.employmentId ?? null,
    currentPrimaryManagerEmploymentId: employmentId === null ? null : currentOf.get(employmentId)?.managerEmploymentId ?? null,
    secondaryManagerEmail1: row.secondaryEmails[0] ?? null,
    secondaryManagerEmail2: row.secondaryEmails[1] ?? null,
    secondaryManagerEmail3: row.secondaryEmails[2] ?? null,
    effectiveFrom: row.effectiveFrom,
    rowReason: row.reason,
    changesLast24h: validation?.primaryChangesLast24h ?? 0,
    status,
    codes: codes.length > 0 ? codes.join(",") : null,
    message: issues[0]?.message ?? (reasonCodes.length > 0 ? "Give this employee an individual reason before committing." : null),
  };
}

/**
 * HRM-15 §7.6 bulk reassignment: a preview is persisted as a job with one row per employee, and a
 * commit writes only the rows the preview accepted, each through the canonical relationship
 * service in its own savepoint so one refusal fails one row, never half of one employee's lines.
 */
@Injectable()
export class ReportingLineBulkJobsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly dispatch: NotificationDispatchService,
    private readonly relationships: ReportingRelationshipService,
    private readonly hierarchyCache: OrgHierarchyCacheService,
    private readonly cache: CacheService,
  ) {}

  async preview(actor: CurrentUserContext, body: CreateBulkJobInput): Promise<BulkJob> {
    const orgId = actor.orgId;
    const defaultDate = body.effectiveFrom ?? (await orgBusinessDate(this.db, orgId));
    const planned = await this.plan(orgId, body, defaultDate);

    const employmentIds = planned.flatMap((row) => (row.employee?.employmentId ? [row.employee.employmentId] : []));
    const current = (await relationshipsBetween(this.db, orgId, employmentIds, defaultDate, defaultDate)).filter((line) => line.primary);
    const currentOf = new Map(current.map((line) => [line.employmentId, line]));

    const commands: Array<{ row: PlannedRow; command: SetRelationshipsCommand }> = [];
    for (const row of planned) {
      const employmentId = row.employee?.employmentId ?? null;
      if (row.issues.length > 0 || employmentId === null) continue;
      const managerUserId = row.primaryManager?.userId ?? currentOf.get(employmentId)?.managerUserId ?? null;
      if (!managerUserId) {
        row.issues.push({ code: CODES.MANAGER_NOT_FOUND, message: "Name a primary manager: this employee has none to keep." });
        continue;
      }
      commands.push({
        row,
        command: {
          orgId,
          actor,
          subjectEmploymentId: employmentId,
          primaryManagerUserId: managerUserId,
          secondary: row.secondaryEmails.length > 0 ? row.secondary.flatMap((person) => (person ? [{ managerUserId: person.userId }] : [])) : undefined,
          effectiveFrom: row.effectiveFrom,
          source: "BULK_REASSIGNMENT",
          reason: row.reason ?? body.jobReason,
        },
      });
    }
    const validations = await this.relationships.validateMany(
      orgId,
      commands.map((entry) => ({ ...entry.command, reason: entry.row.reason })),
    );
    const validationOf = new Map<number, RelationshipValidation>();
    commands.forEach((entry, index) => {
      const validation = validations[index];
      if (validation) validationOf.set(entry.row.rowNumber, validation);
    });

    const stored = planned.map((row) => classifyBulkRow(row, validationOf.get(row.rowNumber), currentOf));
    const counts = { READY: 0, WARNING: 0, ERROR: 0 };
    for (const row of stored) if (row.status === "READY" || row.status === "WARNING" || row.status === "ERROR") counts[row.status] += 1;

    const jobId = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const [job] = await tx
          .insert(hrReportingLineBulkJobs)
          .values({
            orgId,
            jobReason: body.jobReason,
            effectiveFrom: body.effectiveFrom ?? null,
            rowCount: stored.length,
            readyCount: counts.READY,
            warningCount: counts.WARNING,
            errorCount: counts.ERROR,
            createdBy: actor.userId,
          })
          .returning({ id: hrReportingLineBulkJobs.id });
        if (!job) throw new ConflictException("The bulk reporting change could not be recorded.");
        await tx.insert(hrReportingLineBulkJobRows).values(stored.map((row) => ({ ...row, orgId, jobId: job.id })));
        return job.id;
      },
      { orgId },
    );
    return jobView(this.db, orgId, jobId);
  }

  async commit(actor: CurrentUserContext, jobId: string, body: CommitBulkJobInput): Promise<BulkJob> {
    const orgId = actor.orgId;
    await runInTenantTransaction(
      this.db,
      async (tx) => {
        const job = await readJob(tx, orgId, jobId);
        if (job.status !== "PREVIEWED")
          throw new ConflictException({ code: "CONFLICT", message: `This bulk change is already ${job.status.toLowerCase()}.` });
        if (job.createdAt.getTime() < Date.now() - BULK_JOB_PREVIEW_TTL_HOURS * 3_600_000) {
          await tx.update(hrReportingLineBulkJobs).set({ status: "EXPIRED" }).where(and(eq(hrReportingLineBulkJobs.orgId, orgId), eq(hrReportingLineBulkJobs.id, jobId)));
          throw new ConflictException({ code: "CONFLICT", message: "This preview has expired. Upload the file again to preview it." });
        }
        const affected = affectedCount(job);
        if (affected >= BULK_CONFIRMATION_THRESHOLD && body.confirmationPhrase !== `CONFIRM ${affected}`)
          throw new BadRequestException({
            code: "CONFIRMATION_REQUIRED",
            message: `Type CONFIRM ${affected} to apply this change to ${affected} employees.`,
            details: { confirmationPhrase: `CONFIRM ${affected}` },
          });

        const rows = (await readJobRows(tx, orgId, jobId)).filter((row) => row.status === "READY" || row.status === "WARNING");
        const supplied = new Map((body.rowReasons ?? []).map((entry) => [entry.rowNumber, entry.reason]));
        const missing = rows.filter((row) => codesOf(row).includes(CODES.CHANGE_REASON_REQUIRED) && !(supplied.get(row.rowNumber) ?? row.rowReason));
        if (missing.length > 0)
          throw new ReportingLineException(
            CODES.CHANGE_REASON_REQUIRED,
            "Give an individual reason for every employee whose manager has changed repeatedly today.",
            { rowNumbers: missing.map((row) => row.rowNumber) },
          );

        const claimed = await tx
          .update(hrReportingLineBulkJobs)
          .set({ status: "COMMITTING" })
          .where(and(eq(hrReportingLineBulkJobs.orgId, orgId), eq(hrReportingLineBulkJobs.id, jobId), eq(hrReportingLineBulkJobs.status, "PREVIEWED")))
          .returning({ id: hrReportingLineBulkJobs.id });
        if (claimed.length === 0) throw new ConflictException({ code: "CONFLICT", message: "This bulk change is already being applied." });

        const outcomes = await this.apply(tx, actor, job.jobReason, jobId, rows, supplied);
        await this.recordOutcomes(tx, orgId, jobId, outcomes);
        const committed = outcomes.filter((outcome) => outcome.status === "COMMITTED").length;
        await tx
          .update(hrReportingLineBulkJobs)
          .set({ status: "COMMITTED", committedCount: committed, committedBy: actor.userId, committedAt: new Date() })
          .where(and(eq(hrReportingLineBulkJobs.orgId, orgId), eq(hrReportingLineBulkJobs.id, jobId)));
        await this.audit.logCritical({
          action: COMMITTED_EVENT,
          userId: actor.userId,
          orgId,
          targetType: "reporting_line_bulk_job",
          targetId: jobId,
          metadata: { jobReason: job.jobReason, attempted: rows.length, committed, failed: rows.length - committed },
        });
        await this.dispatch.emit({
          eventKey: COMMITTED_EVENT,
          orgId,
          actorUserId: actor.userId,
          notifySelf: true,
          targetUserIds: [actor.userId],
          entityType: "reporting_line_bulk_job",
          entityId: jobId,
          title: "Bulk reporting change applied",
          message: `${committed} of ${rows.length} reporting changes were applied.`,
          link: `/hr/employees/reporting-changes/${jobId}`,
          dedupeKey: `hr-rl-bulk-job:committed:${jobId}`,
        });
        if (committed > 0) await invalidateReportingReads(this.hierarchyCache, this.cache, orgId);
      },
      { orgId },
    );
    return jobView(this.db, orgId, jobId);
  }

  list(actor: CurrentUserContext, cursor: string | undefined) {
    return listJobs(this.db, actor.orgId, cursor);
  }

  get(actor: CurrentUserContext, jobId: string, rowCursor: string | undefined): Promise<BulkJob> {
    return jobView(this.db, actor.orgId, jobId, rowCursor);
  }

  failures(actor: CurrentUserContext, jobId: string): Promise<string> {
    return failuresCsv(this.db, actor.orgId, jobId);
  }

  /** Both request shapes become one row list, with every person resolved in two statements. */
  private async plan(orgId: string, body: CreateBulkJobInput, defaultDate: string): Promise<PlannedRow[]> {
    if ("employeeUserIds" in body) {
      const people = await peopleByUserIds(this.db, orgId, [...body.employeeUserIds, body.primaryManagerUserId]);
      const manager = people.get(body.primaryManagerUserId);
      const seen = new Set<string>();
      return body.employeeUserIds.map((userId, index) => {
        const employee = people.get(userId);
        const row: PlannedRow = {
          rowNumber: index + 1,
          employeeEmail: employee?.email ?? userId,
          employee,
          primaryManagerEmail: manager?.email ?? null,
          primaryManager: manager,
          secondaryEmails: [],
          secondary: [],
          effectiveFrom: defaultDate,
          reason: null,
          issues: [],
        };
        this.checkPeople(row, seen, true);
        return row;
      });
    }
    const emails = body.rows.flatMap((row) => [
      row.employeeEmail,
      ...[row.primaryManagerEmail, row.secondaryManagerEmail1, row.secondaryManagerEmail2, row.secondaryManagerEmail3].flatMap((email) => (email ? [email] : [])),
    ]);
    const people = await peopleByEmails(this.db, orgId, emails);
    const seen = new Set<string>();
    return body.rows.map((input, index) => {
      const secondaryEmails = [input.secondaryManagerEmail1, input.secondaryManagerEmail2, input.secondaryManagerEmail3].flatMap((email) => (email ? [email] : []));
      const row: PlannedRow = {
        rowNumber: index + 1,
        employeeEmail: input.employeeEmail,
        employee: people.get(input.employeeEmail),
        primaryManagerEmail: input.primaryManagerEmail ?? null,
        primaryManager: input.primaryManagerEmail ? people.get(input.primaryManagerEmail) : undefined,
        secondaryEmails,
        secondary: secondaryEmails.map((email) => people.get(email)),
        effectiveFrom: input.effectiveFrom ?? defaultDate,
        reason: meaningful(input.reason),
        issues: [],
      };
      this.checkPeople(row, seen, input.primaryManagerEmail !== undefined);
      return row;
    });
  }

  private checkPeople(row: PlannedRow, seen: Set<string>, primaryNamed: boolean): void {
    if (!row.employee?.employmentId)
      row.issues.push({ code: CODES.EMPLOYEE_NOT_FOUND, message: `${row.employeeEmail} is not an employee of this organization.` });
    else if (seen.has(row.employee.userId))
      row.issues.push({ code: CODES.SECONDARY_DUPLICATE, message: "This employee appears more than once in the file." });
    if (row.employee) seen.add(row.employee.userId);
    if (primaryNamed && !row.primaryManager)
      row.issues.push({ code: CODES.MANAGER_NOT_FOUND, message: `${row.primaryManagerEmail ?? "The manager"} is not a member of this organization.` });
    row.secondary.forEach((person, index) => {
      if (!person)
        row.issues.push({ code: CODES.MANAGER_NOT_FOUND, message: `${row.secondaryEmails[index] ?? "A secondary manager"} is not a member of this organization.` });
    });
  }

  private async apply(
    tx: DbOrTx,
    actor: CurrentUserContext,
    jobReason: string,
    jobId: string,
    rows: readonly StoredRow[],
    supplied: ReadonlyMap<number, string>,
  ): Promise<Array<{ rowNumber: number; status: "COMMITTED" | "FAILED"; codes: string | null; message: string | null; beforeLineId: number | null; afterLineId: number | null }>> {
    const orgId = actor.orgId;
    const managerIds = rows.flatMap((row) => [row.requestedPrimaryManagerEmploymentId, row.currentPrimaryManagerEmploymentId].flatMap((id) => (id === null ? [] : [id])));
    const [managers, secondaries] = await Promise.all([
      peopleByEmploymentIds(tx, orgId, managerIds),
      peopleByEmails(tx, orgId, rows.flatMap(secondaryEmailsOf)),
    ]);
    const outcomes = [];
    for (const row of rows) {
      const managerEmploymentId = row.requestedPrimaryManagerEmploymentId ?? row.currentPrimaryManagerEmploymentId;
      const managerUserId = managerEmploymentId === null ? null : managers.get(managerEmploymentId)?.userId || null;
      const secondaryEmails = secondaryEmailsOf(row);
      try {
        if (row.employeeEmploymentId === null || managerUserId === null)
          throw new ReportingLineException(CODES.MANAGER_NOT_FOUND, "The employee or manager is no longer available.");
        const result = await tx.transaction((rowTx) =>
          this.relationships.setRelationships(rowTx, {
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
  private async recordOutcomes(
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
}
