import { randomUUID } from "node:crypto";
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { signBulkSendJobs, signBulkSendRows, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { SignAuditService } from "./sign-audit.service";
import { SignSettingsService } from "./sign-settings.service";
import { SignNotificationsService } from "./sign-notifications.service";
import { SignIntegrationsService } from "./sign-integrations.service";
import { SignTemplatesService, parseTemplateSnapshot } from "./sign-templates.service";
import { OutboxWriter } from "../../common/outbox/outbox-writer";

/** The one event name, so producer and consumer cannot disagree. */
export const SIGN_BULK_SEND_QUEUED = "sign.bulk_send.queued";

/**
 * Tries per row before it is given up on.
 *
 * Three, not one and not unbounded. One would mark a row failed on its first
 * transient hiccup and never look again; unbounded would let a single
 * permanently failing row be retried forever, re-entering the worker beside
 * four hundred and ninety-nine rows that are already done.
 */
const MAX_ROW_ATTEMPTS = 3;

export interface BulkProcessResult {
  jobId: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: boolean;
}
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

  /**
   * One row, so the worker can re-derive a row from what was stored rather
   * than from what the request happened to be holding. `mapRows` used to be
   * the only mapper and the mapped values lived in memory for the life of the
   * request — which is fine when the request also does the sending, and
   * impossible once the sending moves to a worker that may run minutes later
   * in another process.
   */
  private mapRow(
    raw: Record<string, unknown>,
    columnMapping: Record<string, string>,
    rowNumber: number,
  ): MappedRow {
    const nameCol = columnMapping.name;
    const emailCol = columnMapping.email;
    const phoneCol = columnMapping.phone;
    const name = nameCol ? String(raw[nameCol] ?? "").trim() : "";
    const email = emailCol ? String(raw[emailCol] ?? "").trim() : "";
    const phone = phoneCol ? String(raw[phoneCol] ?? "").trim() : undefined;

    let error: string | undefined;
    if (!name) error = "Missing name";
    else if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) error = "Missing or invalid email";

    return { rowNumber, raw, name: name || undefined, email: email || undefined, phone, error };
  }

  private mapRows(rows: Record<string, unknown>[], columnMapping: Record<string, string>): MappedRow[] {
    return rows.map((raw, index) => this.mapRow(raw, columnMapping, index + 1));
  }

  async createJob(orgId: string, userId: string, input: CreateBulkSendJobInput) {
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

    const mapped = this.mapRows(input.rows, input.columnMapping);

    /**
     * Job, rows and — for a real send — the queue entry, in one transaction.
     * They were three separate writes, so a failure between them could leave a
     * job with no rows, or rows nothing would ever process.
     */
    const job = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(signBulkSendJobs)
        .values({
          orgId,
          templateId: input.templateId,
          senderUserId: userId,
          status: input.dryRun ? "validating" : "pending",
          columnMappingJson: input.columnMapping,
          totalCount: mapped.length,
        })
        .returning();
      if (!created) throw new Error("bulk send job insert returned nothing");

      await tx.insert(signBulkSendRows).values(
        mapped.map((row) => ({
          jobId: created.id,
          rowNumber: row.rowNumber,
          rawDataJson: row.raw,
          status: row.error ? ("failed" as const) : ("pending" as const),
          errorMessage: row.error,
        })),
      );

      if (!input.dryRun) {
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType: "sign_bulk_send_job",
          aggregateId: String(created.id),
          aggregateVersion: 1,
          eventType: SIGN_BULK_SEND_QUEUED,
          payload: {
            organization_id: orgId,
            job_id: created.id,
            template_id: input.templateId,
            role_name: signingRoles[0]!.roleName,
            actor_user_id: userId,
            total_count: mapped.length,
          },
          occurredAt: new Date(),
        });
      }

      return created;
    });

    await this.audit.record({
      orgId,
      actorType: "internal_user",
      actorUserId: userId,
      eventType: "bulk_job_created",
      eventMessage: `Bulk send job created from template "${template.name}" (${mapped.length} rows${input.dryRun ? ", dry run" : ""})`,
    });

    if (input.dryRun) {
      const preview = mapped.slice(0, 5);
      const failedCount = mapped.filter((r) => r.error).length;
      const [updated] = await this.db
        .update(signBulkSendJobs)
        .set({ status: "completed", completedAt: new Date(), successCount: mapped.length - failedCount, failedCount })
        .where(eq(signBulkSendJobs.id, job.id))
        .returning();
      return { job: updated, preview, dryRun: true };
    }

    /**
     * SIGN-P0-05. Queued, not sent.
     *
     * This used to call `process` inline: up to `bulk_send_max_rows_per_job`
     * envelopes — 500 by default — each a template instantiation and an email,
     * all inside the HTTP request that asked for it. The comment beside it
     * called that "acceptable for an admin-triggered, bounded-size job"; five
     * hundred sends is not a request, it is a batch job wearing a request's
     * clothes, and the first thing that happens at scale is a gateway timeout
     * with an unknown number of envelopes already out the door.
     *
     * The event is emitted in the same transaction that creates the job, so a
     * job cannot exist unqueued and a queue entry cannot point at a job that
     * rolled back.
     */
    const queued = await this.getJob(orgId, job.id);
    return { job: queued.job, dryRun: false, queued: true };
  }

  /**
   * SIGN-P0-06. Processes whatever of a job is still outstanding.
   *
   * Reads its work from the database rather than from arguments, which is what
   * makes redelivery safe: the outbox may hand this event over more than once,
   * and a second pass finds only the rows still `pending` — the ones already
   * sent are `success` and are not touched. That is the property that stops a
   * retry from mailing five hundred people twice.
   */
  async processQueuedJob(orgId: string, jobId: number): Promise<BulkProcessResult> {
    const job = await this.db.query.signBulkSendJobs.findFirst({
      where: and(eq(signBulkSendJobs.id, jobId), eq(signBulkSendJobs.orgId, orgId)),
    });
    if (!job) throw new NotFoundException("Bulk send job not found");

    /** Cancelled between queueing and running is a normal race, not a failure. */
    if (job.status === "cancelled" || job.status === "completed") {
      return { jobId, processed: 0, succeeded: 0, failed: 0, skipped: true };
    }

    const template = await this.templates.get(orgId, job.templateId);
    const snapshot = parseTemplateSnapshot(template.templateJson);
    const signingRoles = snapshot.roles.filter((r) => SIGNING_RECIPIENT_TYPES.includes(r.recipientType));
    const roleName = signingRoles[0]?.roleName;
    if (!roleName) throw new BadRequestException("Template no longer has a single signer role");

    await this.db
      .update(signBulkSendJobs)
      .set({ status: "running" })
      .where(eq(signBulkSendJobs.id, jobId));

    const pending = await this.db
      .select()
      .from(signBulkSendRows)
      .where(and(eq(signBulkSendRows.jobId, jobId), eq(signBulkSendRows.status, "pending")))
      .orderBy(signBulkSendRows.rowNumber);

    const columnMapping = (job.columnMappingJson ?? {}) as Record<string, string>;
    let succeeded = 0;
    let failed = 0;

    for (const stored of pending) {
      /**
       * Counted before the attempt, not after. A row that makes the process
       * die — an unhandled provider error, a container restart mid-send —
       * would otherwise keep its old count and be retried forever, which is
       * exactly the row most likely to keep killing the worker.
       */
      const attempts = stored.attempts + 1;
      await this.db
        .update(signBulkSendRows)
        .set({ attempts, updatedAt: new Date() })
        .where(eq(signBulkSendRows.id, stored.id));

      if (attempts > MAX_ROW_ATTEMPTS) {
        await this.db
          .update(signBulkSendRows)
          .set({
            status: "failed",
            errorMessage: `Gave up after ${MAX_ROW_ATTEMPTS} attempts`,
            updatedAt: new Date(),
          })
          .where(eq(signBulkSendRows.id, stored.id));
        failed++;
        continue;
      }

      const row = this.mapRow(
        stored.rawDataJson as Record<string, unknown>,
        columnMapping,
        stored.rowNumber,
      );
      if (row.error) {
        await this.db
          .update(signBulkSendRows)
          .set({ status: "failed", errorMessage: row.error, updatedAt: new Date() })
          .where(eq(signBulkSendRows.id, stored.id));
        failed++;
        continue;
      }

      try {
        const envelope = await this.templates.instantiate(orgId, job.senderUserId, job.templateId, {
          recipients: [{ roleName, name: row.name!, email: row.email, phone: row.phone }],
        });
        await this.envelopes.send(orgId, envelope.id, { orgId, userId: job.senderUserId });
        await this.db
          .update(signBulkSendRows)
          .set({ status: "success", envelopeId: envelope.id, errorMessage: null, updatedAt: new Date() })
          .where(eq(signBulkSendRows.id, stored.id));
        succeeded++;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to create envelope";
        /**
         * Left `pending` while the budget lasts, so the next delivery picks it
         * up; marked `failed` only when there is nothing left to try. A row
         * marked failed on its first transient error would never be retried,
         * which is the opposite failure and just as silent.
         */
        const exhausted = attempts >= MAX_ROW_ATTEMPTS;
        await this.db
          .update(signBulkSendRows)
          .set({
            status: exhausted ? "failed" : "pending",
            errorMessage: message,
            updatedAt: new Date(),
          })
          .where(eq(signBulkSendRows.id, stored.id));
        if (exhausted) failed++;
      }
    }

    return this.finishJob(orgId, jobId, succeeded, failed, pending.length);
  }

  /** Counts recomputed from the rows, not accumulated, so a resumed job still totals correctly. */
  private async finishJob(
    orgId: string,
    jobId: number,
    succeeded: number,
    failed: number,
    processed: number,
  ): Promise<BulkProcessResult> {
    const rows = await this.db
      .select({ status: signBulkSendRows.status })
      .from(signBulkSendRows)
      .where(eq(signBulkSendRows.jobId, jobId));

    const successCount = rows.filter((r) => r.status === "success").length;
    const failedCount = rows.filter((r) => r.status === "failed").length;
    const stillPending = rows.filter((r) => r.status === "pending").length;

    await this.db
      .update(signBulkSendJobs)
      .set({
        status: stillPending > 0 ? "running" : "completed",
        completedAt: stillPending > 0 ? null : new Date(),
        successCount,
        failedCount,
      })
      .where(eq(signBulkSendJobs.id, jobId));

    if (stillPending > 0) {
      /** Rows left to try means the event must come back; throwing is how the outbox retries. */
      throw new Error(
        `bulk send job ${jobId}: ${stillPending} row(s) still pending after this pass`,
      );
    }

    const job = await this.db.query.signBulkSendJobs.findFirst({
      where: eq(signBulkSendJobs.id, jobId),
    });

    await this.audit.record({
      orgId,
      actorType: "system",
      eventType: "bulk_job_completed",
      eventMessage: `Bulk send job completed: ${successCount} sent, ${failedCount} failed`,
    });

    const sender = job?.senderUserId
      ? await this.db.query.users.findFirst({ where: eq(users.id, job.senderUserId) })
      : null;
    if (sender?.email) {
      await this.notifications.sendBulkJobCompleted(
        sender.email,
        sender.name ?? "there",
        jobId,
        rows.length,
        successCount,
        failedCount,
      );
    }

    if (job?.senderUserId) {
      this.integrations.emitBulkSendCompleted(orgId, job.senderUserId, jobId, {
        totalCount: rows.length,
        successCount,
        failedCount,
      });
    }

    return { jobId, processed, succeeded, failed, skipped: false };
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
    const rows = await this.db.query.signBulkSendRows.findMany({ where: eq(signBulkSendRows.jobId, jobId), orderBy: (r, { asc }) => [asc(r.rowNumber)], limit: 100 });
    return { job, rows };
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

  async getErrorReport(orgId: string, jobId: number) {
    const { rows } = await this.getJob(orgId, jobId);
    return rows.filter((r) => r.status === "failed");
  }
}
