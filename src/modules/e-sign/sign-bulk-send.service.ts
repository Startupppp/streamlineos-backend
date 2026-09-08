import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { organizationMembers, signBulkSendJobs, signBulkSendRows } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { SignAuditService } from "./sign-audit.service";
import { SignSettingsService } from "./sign-settings.service";
import { SignNotificationsService } from "./sign-notifications.service";
import { SignIntegrationsService } from "./sign-integrations.service";
import { SignTemplatesService } from "./sign-templates.service";
import { parseTemplateSnapshot } from "./sign-template-snapshot";
import { SignEnvelopesService } from "./sign-envelopes.service";
import { bulkUpdateFromValues } from "../../common/db/bulk-update";
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
 * The outcome of one row, held until the whole job has run.
 *
 * Instantiating and sending an envelope is irreducibly per row — each one is a
 * distinct document with a distinct recipient — but the row's own status write
 * is not, and it used to be a second round trip per row inside the same loop.
 * Collecting the outcomes turns 2N statements into N + one
 * `UPDATE … FROM (VALUES …)`, and loses nothing on a crash: `process` runs
 * inside the request transaction, so a failure mid-job already rolled back
 * every status the loop had written.
 */
interface RowOutcome {
  readonly rowNumber: number;
  readonly status: "success" | "failed";
  readonly envelopeId: number | null;
  readonly errorMessage: string | null;
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
      columns: { id: true },
      where: and(eq(signBulkSendJobs.orgId, orgId), inArray(signBulkSendJobs.status, [...ACTIVE_JOB_STATUSES])),
    });
    if (activeJobs.length >= orgSettings.bulkSendMaxActiveJobs) {
      throw new BadRequestException(`This organization already has ${orgSettings.bulkSendMaxActiveJobs} active bulk send jobs`);
    }

    const mapped = this.mapRows(input.rows, input.columnMapping);

    const [job] = await this.db
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

    await this.db.insert(signBulkSendRows).values(
      mapped.map((row) => ({
        orgId,
        jobId: job.id,
        rowNumber: row.rowNumber,
        rawDataJson: row.raw,
        status: row.error ? ("failed" as const) : ("pending" as const),
        errorMessage: row.error,
      })),
    );

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

    await this.process(orgId, senderMembershipId, job.id, input.templateId, signingRoles[0].roleName, mapped);
    const finalJob = await this.getJob(orgId, job.id);
    return { job: finalJob.job, dryRun: false };
  }

  private async process(orgId: string, senderMembershipId: number | null, jobId: number, templateId: number, roleName: string, rows: MappedRow[]) {
    await this.db.update(signBulkSendJobs).set({ status: "running" }).where(eq(signBulkSendJobs.id, jobId));

    const senderMember =
      senderMembershipId != null
        ? await this.db.query.organizationMembers.findFirst({
            where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.id, senderMembershipId)),
            with: { user: { columns: { id: true, name: true, email: true } } },
          })
        : null;

    const actor = { orgId, userId: senderMember?.user?.id ?? "", membershipId: senderMembershipId };

    let successCount = 0;
    let failedCount = 0;
    const outcomes: RowOutcome[] = [];

    for (const row of rows) {
      if (row.error || !row.name) {
        failedCount++;
        continue;
      }
      try {
        const envelope = await this.templates.instantiate(orgId, senderMembershipId, templateId, {
          recipients: [{ roleName, name: row.name, email: row.email, phone: row.phone }],
        });
        await this.envelopes.send(orgId, envelope.id, actor);
        outcomes.push({ rowNumber: row.rowNumber, status: "success", envelopeId: envelope.id, errorMessage: null });
        successCount++;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to create envelope";
        outcomes.push({ rowNumber: row.rowNumber, status: "failed", envelopeId: null, errorMessage: message });
        failedCount++;
      }
    }

    await this.writeRowOutcomes(orgId, jobId, outcomes);

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

    if (senderMember?.user?.email) {
      await this.notifications.sendBulkJobCompleted(senderMember.user.email, senderMember.user.name ?? "there", jobId, rows.length, successCount, failedCount);
    }

    this.integrations.emitBulkSendCompleted(orgId, senderMember?.user?.id ?? null, jobId, { totalCount: rows.length, successCount, failedCount });
  }

  /**
   * `row_number` is unique within a job, so it joins the outcome to its row
   * exactly once the job is pinned in the `WHERE` — which it is, beside the
   * tenant predicate the builder always adds.
   */
  private async writeRowOutcomes(orgId: string, jobId: number, outcomes: readonly RowOutcome[]): Promise<void> {
    if (outcomes.length === 0) return;
    await bulkUpdateFromValues(this.db, {
      table: signBulkSendRows,
      orgId,
      key: { column: "row_number", type: "integer" },
      columns: [
        { column: "status", type: "sign_bulk_row_status" },
        { column: "envelope_id", type: "integer" },
        { column: "error_message", type: "text" },
      ],
      rows: outcomes.map((outcome) => ({
        key: outcome.rowNumber,
        values: [outcome.status, outcome.envelopeId, outcome.errorMessage],
      })),
      touch: ["updated_at"],
      extraWhere: eq(signBulkSendRows.jobId, jobId),
    });
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
    if (!ACTIVE_JOB_STATUSES.some((status) => status === job.status)) {
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
