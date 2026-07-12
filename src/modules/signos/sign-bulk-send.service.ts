import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { signBulkSendJobs, signBulkSendRows, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { SignAuditService } from "./sign-audit.service";
import { SignSettingsService } from "./sign-settings.service";
import { SignNotificationsService } from "./sign-notifications.service";
import { SignIntegrationsService } from "./sign-integrations.service";
import { SignTemplatesService, type TemplateSnapshot } from "./sign-templates.service";
import { SignEnvelopesService } from "./sign-envelopes.service";
import type { CreateBulkSendJobInput } from "./dto/signos.schemas";

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

  async createJob(orgId: string, userId: string, input: CreateBulkSendJobInput) {
    const template = await this.templates.get(orgId, input.templateId);
    if (template.status !== "published") throw new BadRequestException("Only published templates can be used for bulk send");

    const snapshot = template.templateJson as unknown as TemplateSnapshot;
    const signingRoles = snapshot.roles?.filter((r) => SIGNING_RECIPIENT_TYPES.includes(r.recipientType)) ?? [];
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

    const [job] = await this.db
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

    await this.db.insert(signBulkSendRows).values(
      mapped.map((row) => ({
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

    // Synchronous processing: acceptable for an admin-triggered, bounded-size (maxRows) job.
    await this.process(orgId, userId, job.id, input.templateId, signingRoles[0].roleName, mapped);
    const finalJob = await this.getJob(orgId, job.id);
    return { job: finalJob.job, dryRun: false };
  }

  private async process(orgId: string, userId: string, jobId: number, templateId: number, roleName: string, rows: MappedRow[]) {
    await this.db.update(signBulkSendJobs).set({ status: "running" }).where(eq(signBulkSendJobs.id, jobId));

    let successCount = 0;
    let failedCount = 0;

    for (const row of rows) {
      if (row.error) {
        failedCount++;
        continue;
      }
      try {
        const envelope = await this.templates.instantiate(orgId, userId, templateId, {
          recipients: [{ roleName, name: row.name!, email: row.email, phone: row.phone }],
        });
        await this.envelopes.send(orgId, envelope.id, { orgId, userId });
        await this.db
          .update(signBulkSendRows)
          .set({ status: "success", envelopeId: envelope.id, updatedAt: new Date() })
          .where(and(eq(signBulkSendRows.jobId, jobId), eq(signBulkSendRows.rowNumber, row.rowNumber)));
        successCount++;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to create envelope";
        await this.db
          .update(signBulkSendRows)
          .set({ status: "failed", errorMessage: message, updatedAt: new Date() })
          .where(and(eq(signBulkSendRows.jobId, jobId), eq(signBulkSendRows.rowNumber, row.rowNumber)));
        failedCount++;
      }
    }

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

    const sender = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
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
    const rows = await this.db.query.signBulkSendRows.findMany({ where: eq(signBulkSendRows.jobId, jobId), orderBy: (r, { asc }) => [asc(r.rowNumber)] });
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
