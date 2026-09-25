import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AuditService } from "../../../common/audit/audit.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { AccessService } from "../../access/access.service";
import { hrReportingLineBulkJobRows, hrReportingLineBulkJobs } from "../../../db/schema";
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
import { resolveEmployeesScope } from "./employees-scope";
import {
  BULK_CONFIRMATION_THRESHOLD,
  affectedCount,
  codesOf,
  failuresCsv,
  jobView,
  listJobs,
  readJob,
  readJobRows,
} from "./reporting-line-bulk-jobs-read";
import { classifyBulkRow, planBulkRows, rejectFileCycles, type PlannedRow } from "./reporting-line-bulk-jobs-plan";
import { applyBulkRows, recordBulkOutcomes } from "./reporting-line-bulk-jobs-apply";
import type { BulkJob, CommitBulkJobInput, CreateBulkJobInput } from "./dto/reporting-lines-bulk.schemas";

/** A preview older than this describes a hierarchy that may have moved on; it must be re-run. */
export const BULK_JOB_PREVIEW_TTL_HOURS = 24;
const COMMITTED_EVENT = "hr.reporting_line_bulk_job.committed";

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
    private readonly access: AccessService,
  ) {}

  /**
   * Job visibility: a caller whose employees scope is org-wide sees every job; anyone narrower sees
   * only the jobs they previewed, since a job's rows name people outside their scope.
   */
  private async jobAuthor(actor: CurrentUserContext): Promise<string | undefined> {
    return (await resolveEmployeesScope(this.access, actor)).unrestricted ? undefined : actor.userId;
  }

  async preview(actor: CurrentUserContext, body: CreateBulkJobInput): Promise<BulkJob> {
    const orgId = actor.orgId;
    const defaultDate = body.effectiveFrom ?? (await orgBusinessDate(this.db, orgId));
    const planned = await planBulkRows(this.db, await resolveEmployeesScope(this.access, actor), body, defaultDate);
    rejectFileCycles(planned);

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
        const job = await readJob(tx, orgId, jobId, await this.jobAuthor(actor));
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

        const outcomes = await applyBulkRows(tx, this.relationships, actor, job.jobReason, jobId, rows, supplied);
        await recordBulkOutcomes(tx, orgId, jobId, outcomes);
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
      },
      { orgId },
    );
    return jobView(this.db, orgId, jobId);
  }

  async list(actor: CurrentUserContext, cursor: string | undefined) {
    return listJobs(this.db, actor.orgId, cursor, await this.jobAuthor(actor));
  }

  async get(actor: CurrentUserContext, jobId: string, rowCursor: string | undefined): Promise<BulkJob> {
    return jobView(this.db, actor.orgId, jobId, rowCursor, await this.jobAuthor(actor));
  }

  async failures(actor: CurrentUserContext, jobId: string): Promise<string> {
    return failuresCsv(this.db, actor.orgId, jobId, await this.jobAuthor(actor));
  }

}
