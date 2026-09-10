import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { signBulkSendJobs, signBulkSendRows, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { SignAuditService } from "./sign-audit.service";
import { SignSettingsService } from "./sign-settings.service";
import { SignNotificationsService } from "./sign-notifications.service";
import { SignIntegrationsService } from "./sign-integrations.service";
import { SignTemplatesService, parseTemplateSnapshot } from "./sign-templates.service";
import { SignEnvelopesService } from "./sign-envelopes.service";
import type { CreateBulkSendJobInput } from "./dto/e-sign.schemas";

const SIGNING_RECIPIENT_TYPES = ["signer", "approver", "in_person_host", "internal_reviewer"];
const ACTIVE_JOB_STATUSES = ["pending", "validating", "running"] as const;

interface MappedRow {
  rowNumber: number;
  raw: Record<string, unknown>;
  name?: string;
  email?: string;
  phone?: string;
  error?: string;
}

/**
 * One page of a job's rows. The detail view shows these in row order; a longer
 * job is reported by count rather than silently ending at the hundredth row.
 */
const BULK_ROW_PAGE = 100;

/**
 * The error report's own cap, which is not the row page.
 *
 * A bulk send that fails wholesale fails in the thousands, and the whole point
 * of the report is to be able to fix and re-run those rows. Capping it at the
 * row page meant the report was a window over the first hundred rows rather
 * than a list of what went wrong.
 */
const BULK_ERROR_REPORT_CAP = 2_000;

@Injectable()
export class SignBulkSendService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: SignAuditService,
    private readonly settings: SignSettingsService,
    private readonly notifications: SignNotificationsService,
    private readonly templates: SignTemplatesService,
    private readonly envelopes: SignEnvelopesService,
    private readonly integrations: SignIntegrationsService,
  ) {}

  private mapRows(rows: Record<string, unknown>[], columnMapping: Record<string, string>): MappedRow[] {
    return rows.map((raw, index) => {
      const nameCol = columnMapping.name;
      const emailCol = columnMapping.email;
      const phoneCol = columnMapping.phone;
      const name = nameCol ? String(raw[nameCol] ?? "").trim() : "";
      const email = emailCol ? String(raw[emailCol] ?? "").trim() : "";
      const phone = phoneCol ? String(raw[phoneCol] ?? "").trim() : undefined;

      let error: string | undefined;
      if (!name) error = "Missing name";
      else if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) error = "Missing or invalid email";

      return { rowNumber: index + 1, raw, name: name || undefined, email: email || undefined, phone, error };
    });
  }

  /**
   * A bulk send completes what it can, and that is a restoration rather than a
   * change of intent.
   *
   * `sign_bulk_send_jobs` carries `successCount` and `failedCount`, every row
   * carries its own `status` and `errorMessage`, and `getErrorReport` exists to
   * hand an operator the rows that failed so they can be fixed and re-run. That
   * is the shape of an operation designed to finish partially — and the loop in
   * `process` has always had a per-row `try`/`catch` that records one failure
   * and moves on. What defeated it was the transaction boundary, not the
   * design: every row lived in the one request transaction, so the first
   * unhandled failure discarded the rows that `catch` had carefully recorded
   * along with the envelopes they described.
   *
   * All-or-nothing was never really available. It would mean deleting the
   * counters, the per-row status and the error report — and it could not be
   * honoured regardless, because the invitation emails are the irreversible
   * half of the operation and no transaction has ever covered them. Rolling
   * back was not restoring the world; it was destroying the only record of what
   * had already been sent.
   */
  async createJob(orgId: string, userId: string, input: CreateBulkSendJobInput) {
    /*
     * Validation and job creation stay atomic together: a job row without its
     * rows, or rows without their job, is worse than no job at all. Everything
     * past this point is per-row.
     *
     * It needs an explicit transaction because the route carries
     * `@NoTenantTransaction()`, so there is no ambient context and `this.db`
     * would otherwise reach the pool with no `app.current_org_id` GUC — denied
     * by RLS rather than silently cross-tenant, but denied all the same.
     */
    const { job, mapped, roleName } = await runInNewTenantTransaction(this.db, orgId, async () => {
      const template = await this.templates.get(orgId, input.templateId);
      if (template.status !== "published") throw new BadRequestException("Only published templates can be used for bulk send");

      const snapshot = parseTemplateSnapshot(template.templateJson);
      const signingRoles = snapshot.roles.filter((r) => SIGNING_RECIPIENT_TYPES.includes(r.recipientType));
      if (signingRoles.length !== 1) {
        throw new BadRequestException("Bulk send requires a template with exactly one signer role (mail-merge style)");
      }

      const orgSettings = await this.settings.getOrCreate(orgId);
      if (input.rows.length > orgSettings.bulkSendMaxRowsPerJob) {
        throw new BadRequestException(`Bulk send is limited to ${orgSettings.bulkSendMaxRowsPerJob} rows per job for this organization`);
      }

      const activeJobs = await this.db.query.signBulkSendJobs.findMany({
        where: and(eq(signBulkSendJobs.orgId, orgId), inArray(signBulkSendJobs.status, [...ACTIVE_JOB_STATUSES])),
      });
      if (activeJobs.length >= orgSettings.bulkSendMaxActiveJobs) {
        throw new BadRequestException(`This organization already has ${orgSettings.bulkSendMaxActiveJobs} active bulk send jobs`);
      }

      const rows = this.mapRows(input.rows, input.columnMapping);

      const [created] = await this.db
        .insert(signBulkSendJobs)
        .values({
          orgId,
          templateId: input.templateId,
          senderUserId: userId,
          status: input.dryRun ? "validating" : "pending",
          columnMappingJson: input.columnMapping,
          totalCount: rows.length,
        })
        .returning();

      await this.db.insert(signBulkSendRows).values(
        rows.map((row) => ({
          jobId: created.id,
          rowNumber: row.rowNumber,
          rawDataJson: row.raw,
          status: row.error ? ("failed" as const) : ("pending" as const),
          errorMessage: row.error,
        })),
      );

      await this.audit.record({
        orgId,
        actorType: "internal_user",
        actorUserId: userId,
        eventType: "bulk_job_created",
        eventMessage: `Bulk send job created from template "${template.name}" (${rows.length} rows${input.dryRun ? ", dry run" : ""})`,
      });

      return { job: created, mapped: rows, roleName: signingRoles[0].roleName };
    });

    if (input.dryRun) {
      const preview = mapped.slice(0, 5);
      const failedCount = mapped.filter((r) => r.error).length;
      const updated = await runInNewTenantTransaction(this.db, orgId, async () => {
        const [row] = await this.db
          .update(signBulkSendJobs)
          .set({ status: "completed", completedAt: new Date(), successCount: mapped.length - failedCount, failedCount })
          .where(eq(signBulkSendJobs.id, job.id))
          .returning();
        return row;
      });
      return { job: updated, preview, dryRun: true };
    }

    await this.process(orgId, userId, job.id, input.templateId, roleName, mapped);
    const finalJob = await runInNewTenantTransaction(this.db, orgId, () => this.getJob(orgId, job.id));
    return { job: finalJob.job, dryRun: false };
  }

  /**
   * One transaction per row, and the row's outcome written in a second one.
   *
   * The second transaction is the point of the whole change, and it is easy to
   * mistake for redundancy. On the failure path the row's own transaction has
   * already rolled back by the time the error is caught, so a status write
   * issued inside it would be discarded together with the work it exists to
   * report — leaving a row that failed sitting at `pending` with no error
   * message and a `failedCount` that never learned about it. When the failure
   * was `idle_in_transaction_session_timeout` the session is gone outright, and
   * only a fresh connection can record anything at all.
   *
   * What is deliberately NOT solved here: `dispatch.send` sends the invitation
   * after its own inner block, so the email still goes out inside the row's
   * transaction. That send is shared with the single-envelope route and moving
   * it is a change to `dispatch.send`, not to this file. The blast radius is
   * what changed — a pooled connection is held across one email rather than
   * five thousand, and the 60s idle guard now scopes to a single row, so a hung
   * provider costs that row and the job continues.
   */
  private async process(orgId: string, userId: string, jobId: number, templateId: number, roleName: string, rows: MappedRow[]) {
    await runInNewTenantTransaction(this.db, orgId, () =>
      this.db.update(signBulkSendJobs).set({ status: "running" }).where(eq(signBulkSendJobs.id, jobId)),
    );

    let successCount = 0;
    let failedCount = 0;

    try {
      for (const row of rows) {
        if (row.error) {
          failedCount++;
          continue;
        }

        /*
         * `templates.instantiate` and `envelopes.send` both reach `this.db`,
         * which the tenant-aware proxy routes into whichever transaction is
         * ambient — so this one covers the envelope, its recipients and the
         * outbox row `dispatch.send` writes, and commits them before the next
         * row begins.
         */
        let envelopeId: number | null = null;
        let failure: string | null = null;
        try {
          envelopeId = await runInNewTenantTransaction(this.db, orgId, async () => {
            const envelope = await this.templates.instantiate(orgId, userId, templateId, {
              recipients: [{ roleName, name: row.name!, email: row.email, phone: row.phone }],
            });
            await this.envelopes.send(orgId, envelope.id, { orgId, userId });
            return envelope.id;
          });
        } catch (error) {
          failure = error instanceof Error ? error.message : "Failed to create envelope";
        }

        await runInNewTenantTransaction(this.db, orgId, async () => {
          const patch =
            failure === null
              ? { status: "success" as const, envelopeId, updatedAt: new Date() }
              : { status: "failed" as const, errorMessage: failure, updatedAt: new Date() };
          await this.db
            .update(signBulkSendRows)
            .set(patch)
            .where(and(eq(signBulkSendRows.jobId, jobId), eq(signBulkSendRows.rowNumber, row.rowNumber)));
        });

        if (failure === null) successCount++;
        else failedCount++;
      }
    } catch (error) {
      /*
       * Partial success needs a terminal state for a run that did not finish.
       * Nothing rolls the job row back any more, so a throw escaping here would
       * leave it `running` for ever — and `running` is one of
       * `ACTIVE_JOB_STATUSES`, so it would also hold one of the organisation's
       * active-job slots permanently, refusing later jobs. `failed` has been in
       * `signBulkJobStatusEnum` from the start with nothing to set it; this is
       * the case it was for. The counts are written as they actually stand, so
       * the rows that did send are still reported as sent.
       */
      await runInNewTenantTransaction(this.db, orgId, () =>
        this.db
          .update(signBulkSendJobs)
          .set({ status: "failed", completedAt: new Date(), successCount, failedCount })
          .where(eq(signBulkSendJobs.id, jobId)),
      );
      throw error;
    }

    await runInNewTenantTransaction(this.db, orgId, async () => {
      await this.db
        .update(signBulkSendJobs)
        .set({ status: "completed", completedAt: new Date(), successCount, failedCount })
        .where(eq(signBulkSendJobs.id, jobId));

      await this.audit.record({
        orgId,
        actorType: "system",
        eventType: "bulk_job_completed",
        eventMessage: `Bulk send job completed: ${successCount} sent, ${failedCount} failed`,
      });
    });

    /*
     * The completion email is a network call and the run is over, so it is sent
     * outside any transaction. The sender is resolved inside one first: with no
     * ambient context `this.db` reaches the pool with no tenant GUC.
     */
    const sender = await runInNewTenantTransaction(this.db, orgId, () =>
      this.db.query.users.findFirst({ where: eq(users.id, userId) }),
    );
    if (sender?.email) {
      await this.notifications.sendBulkJobCompleted(sender.email, sender.name ?? "there", jobId, rows.length, successCount, failedCount);
    }

    this.integrations.emitBulkSendCompleted(orgId, userId, jobId, { totalCount: rows.length, successCount, failedCount });
  }

  async listJobs(orgId: string) {
    return this.db.query.signBulkSendJobs.findMany({
      where: eq(signBulkSendJobs.orgId, orgId),
      orderBy: (j, { desc }) => [desc(j.createdAt)],
      limit: 50,
    });
  }

  async getJob(orgId: string, jobId: number) {
    const job = await this.db.query.signBulkSendJobs.findFirst({ where: and(eq(signBulkSendJobs.id, jobId), eq(signBulkSendJobs.orgId, orgId)) });
    if (!job) throw new NotFoundException("Bulk send job not found");
    const rows = await this.db.query.signBulkSendRows.findMany({ where: eq(signBulkSendRows.jobId, jobId), orderBy: (r, { asc }) => [asc(r.rowNumber)], limit: BULK_ROW_PAGE });
    /*
     * The cap is real and a bulk send is exactly where it is passed, so the
     * caller is told how many rows there are rather than being handed a
     * hundred and left to assume that is all of them.
     */
    const [counted] = await this.db
      .select({ n: sql<string>`count(*)` })
      .from(signBulkSendRows)
      .where(eq(signBulkSendRows.jobId, jobId));
    return { job, rows, rowTotal: Number(counted?.n ?? 0) };
  }

  async cancel(orgId: string, jobId: number, actor: { userId: string }) {
    const { job } = await this.getJob(orgId, jobId);
    if (!(ACTIVE_JOB_STATUSES as readonly string[]).includes(job.status)) {
      throw new ForbiddenException("Only pending or in-progress jobs can be cancelled");
    }
    const [updated] = await this.db
      .update(signBulkSendJobs)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(eq(signBulkSendJobs.id, jobId))
      .returning();

    await this.audit.record({
      orgId,
      actorType: "internal_user",
      actorUserId: actor.userId,
      eventType: "bulk_job_cancelled",
      eventMessage: `Bulk send job ${jobId} cancelled`,
    });
    return updated;
  }

  /**
   * The failures, all of them, filtered in SQL.
   *
   * This used to call `getJob` and filter its result in JavaScript. `getJob`
   * returns the first hundred rows **by row number**, so the report described
   * only failures in rows 1–100: a five-hundred-row job whose failures were
   * rows 200–450 came back as an **empty array** while the job itself reported
   * `failedCount: 250`. Not a truncated list — a list that says nothing went
   * wrong about a job that failed half its rows, which is the opposite of what
   * an error report is for.
   *
   * The org check still runs first, through the same `getJob`, because the
   * failure rows are keyed only on `jobId` and would otherwise be readable
   * across tenants by anyone who guessed a job id.
   */
  async getErrorReport(orgId: string, jobId: number) {
    await this.getJob(orgId, jobId);
    return this.db.query.signBulkSendRows.findMany({
      where: and(eq(signBulkSendRows.jobId, jobId), eq(signBulkSendRows.status, "failed")),
      orderBy: (r, { asc }) => [asc(r.rowNumber)],
      limit: BULK_ERROR_REPORT_CAP,
    });
  }
}
