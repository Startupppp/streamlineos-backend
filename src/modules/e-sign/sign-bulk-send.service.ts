import { randomUUID } from "node:crypto";
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { organizationMembers, signBulkSendJobs, signBulkSendRows } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { SignAuditService } from "./sign-audit.service";
import { SignSettingsService } from "./sign-settings.service";
import { SignNotificationsService } from "./sign-notifications.service";
import { SignIntegrationsService } from "./sign-integrations.service";
import { SignTemplatesService, parseTemplateSnapshot } from "./sign-templates.service";
import { SignEnvelopesService } from "./sign-envelopes.service";
import { OutboxWriter } from "../../common/outbox/outbox-writer";
import type { CreateBulkSendJobInput } from "./dto/e-sign.schemas";
import type { BulkProcessResult } from "./sign-bulk-send.types";
import { runBulkSendPass, type BulkSendPassDeps } from "./lib/bulk-send-pass";
import { mapRows } from "./lib/bulk-send-rows";
export type { BulkProcessResult } from "./sign-bulk-send.types";

/** The one event name, so producer and consumer cannot disagree. */
export const SIGN_BULK_SEND_QUEUED = "sign.bulk_send.queued";

/** One page of a job's rows, for the detail view. The job's counts are exact. */
const JOB_ROWS_PAGE_LIMIT = 100;

/**
 * The error report is a download, so it is not paged at 100 like a list — a
 * report truncated to a screenful is not a report. It is still bounded, and
 * says when it hit the bound.
 */
const ERROR_REPORT_LIMIT = 5_000;

const SIGNING_RECIPIENT_TYPES = ["signer", "approver", "in_person_host", "internal_reviewer"];
const ACTIVE_JOB_STATUSES = ["pending", "validating", "running"] as const;

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

  /** What the row pass (`lib/bulk-send-pass.ts`) acts through. */
  private passDeps(): BulkSendPassDeps {
    const { db, audit, notifications, templates, envelopes, integrations } = this;
    return { db, audit, notifications, templates, envelopes, integrations };
  }

  async createJob(orgId: string, senderMembershipId: number | null, input: CreateBulkSendJobInput) {
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

    const mapped = mapRows(input.rows, input.columnMapping);

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
          senderMembershipId,
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
            actor_membership_id: senderMembershipId,
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

    /**
     * The sender is the membership that queued the job, resolved inside this
     * organisation once per pass: every envelope in it goes out on their behalf.
     */
    const senderMember =
      job.senderMembershipId != null
        ? await this.db.query.organizationMembers.findFirst({
            where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.id, job.senderMembershipId)),
            with: { user: { columns: { id: true } } },
          })
        : null;
    const actor = { orgId, userId: senderMember?.user?.id ?? "", membershipId: job.senderMembershipId };

    const template = await this.templates.get(orgId, job.templateId);
    const snapshot = parseTemplateSnapshot(template.templateJson);
    const signingRoles = snapshot.roles.filter((r) => SIGNING_RECIPIENT_TYPES.includes(r.recipientType));
    const roleName = signingRoles[0]?.roleName;
    if (!roleName) throw new BadRequestException("Template no longer has a single signer role");

    return runBulkSendPass(this.passDeps(), orgId, jobId, job, actor, roleName);
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
    const rows = await this.db.query.signBulkSendRows.findMany({ where: eq(signBulkSendRows.jobId, jobId), orderBy: (r, { asc }) => [asc(r.rowNumber)], limit: JOB_ROWS_PAGE_LIMIT });
    /**
     * `rowsTruncated` because the cap was previously invisible: a caller
     * reading `rows.length` on a large job had no way to tell a complete list
     * from the first hundred of it. The counts on the job itself are the whole
     * truth; these rows are a page of evidence.
     */
    /*
     * `rowTotal` counts the rows themselves rather than trusting the job's
     * tally, so a caller is told how many rows exist even when the tally and the
     * table disagree; `rowsTruncated` is read from that count.
     */
    const [counted] = await this.db
      .select({ n: sql<string>`count(*)` })
      .from(signBulkSendRows)
      .where(eq(signBulkSendRows.jobId, jobId));
    const rowTotal = Number(counted?.n ?? 0);
    return { job, rows, rowTotal, rowsTruncated: rowTotal > rows.length };
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
   * Every failed row of a job, not the failures among its first page.
   *
   * This used to be `getJob(...).rows.filter(failed)`, and `getJob` caps its
   * rows at 100 ordered by row number. So for a job of five hundred whose
   * first hundred rows sent cleanly, the error report was EMPTY while the job
   * reported four hundred failures — the report was silently truncated at the
   * one point somebody consults it to find out what went wrong, and the
   * absence of rows read as "nothing to fix". A job may hold up to
   * `bulkSendMaxRowsPerJob`, which an organisation may set as high as 10,000,
   * so the gap is not a corner case.
   *
   * Queried on `(job_id, status)`, which is indexed, and capped explicitly
   * with the count and the cap both reported — a download that is short must
   * say so rather than look complete.
   */
  async getErrorReport(orgId: string, jobId: number) {
    /** Tenant check first: this must 404 for another organisation's job. */
    const job = await this.db.query.signBulkSendJobs.findFirst({
      where: and(eq(signBulkSendJobs.id, jobId), eq(signBulkSendJobs.orgId, orgId)),
      columns: { id: true, failedCount: true },
    });
    if (!job) throw new NotFoundException("Bulk send job not found");

    const rows = await this.db.query.signBulkSendRows.findMany({
      where: and(eq(signBulkSendRows.jobId, jobId), eq(signBulkSendRows.status, "failed")),
      orderBy: (r, { asc }) => [asc(r.rowNumber)],
      limit: ERROR_REPORT_LIMIT,
    });

    return {
      rows,
      /** From the job's own tally, so a truncated page cannot understate it. */
      failedCount: job.failedCount,
      returned: rows.length,
      limit: ERROR_REPORT_LIMIT,
      truncated: rows.length === ERROR_REPORT_LIMIT && job.failedCount > rows.length,
    };
  }
}
