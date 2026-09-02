import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { financeReportExportJobs } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { accountableMembershipId } from "../../../common/auth/principal";
import { StorageService, type FileStreamResult } from "../../storage/storage.service";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import {
  FINANCE_REPORT_EXPORT_AGGREGATE_TYPE,
  FINANCE_REPORT_EXPORT_REQUESTED_EVENT,
  type CreateFinanceReportExportJobInput,
} from "./dto/finance-report-export.schemas";
import type { FinanceReportExportFilters } from "../../../db/schema/accounting/finance-report-export-jobs";

export type FinanceReportExportJobRow = typeof financeReportExportJobs.$inferSelect;

const EXPIRY_MS = 24 * 60 * 60 * 1000;
const REPORT_EXPORT_BATCH_SIZE = 500;
export const REPORT_LINE_CAP = 50_000;

@Injectable()
export class FinanceReportExportService {
  constructor(@Inject(DRIZZLE) private readonly db: Db, private readonly storage: StorageService) {}

  async create(user: CurrentUserContext, input: CreateFinanceReportExportJobInput, idempotencyKey: string) {
    const requesterMembershipId = accountableMembershipId(user.principal);
    if (requesterMembershipId === null) throw new ForbiddenException("A member identity is required to export reports");
    const filters: FinanceReportExportFilters = {
      reportType: input.reportType,
      from: input.from,
      to: input.to,
      ...(input.vendorId !== undefined && { vendorId: input.vendorId }),
      ...(input.clientId !== undefined && { clientId: input.clientId }),
      ...(input.budgetId !== undefined && { budgetId: input.budgetId }),
    };
    const requestHash = createHash("sha256").update(JSON.stringify(filters)).digest("hex");
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(financeReportExportJobs)
        .values({ orgId: user.orgId, requestedByMembershipId: requesterMembershipId, reportType: input.reportType, filters, idempotencyKey, requestHash })
        .onConflictDoNothing({ target: [financeReportExportJobs.orgId, financeReportExportJobs.idempotencyKey] })
        .returning();
      const isNew = inserted.length > 0;
      const job =
        inserted[0] ??
        (
          await tx
            .select()
            .from(financeReportExportJobs)
            .where(and(eq(financeReportExportJobs.orgId, user.orgId), eq(financeReportExportJobs.idempotencyKey, idempotencyKey)))
            .limit(1)
        )[0];
      if (!job) throw new BadRequestException("Failed to create finance report export job");
      if (job.requestedByMembershipId !== requesterMembershipId || job.requestHash !== requestHash)
        throw new BadRequestException("Idempotency-Key was used for a different export");
      if (isNew) {
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: user.orgId,
          aggregateType: FINANCE_REPORT_EXPORT_AGGREGATE_TYPE,
          aggregateId: job.id,
          aggregateVersion: 1,
          eventType: FINANCE_REPORT_EXPORT_REQUESTED_EVENT,
          payload: { jobId: job.id, orgId: user.orgId },
          occurredAt: new Date(),
        });
      }
      return this.view(job);
    });
  }

  async get(user: CurrentUserContext, id: string) {
    const job = await this.find(user, id);
    return this.view(job);
  }

  async download(user: CurrentUserContext, id: string): Promise<{ job: ReturnType<FinanceReportExportService["view"]>; file: FileStreamResult }> {
    const job = await this.find(user, id);
    if (job.status === "expired" || (job.expiresAt && job.expiresAt <= new Date())) throw new BadRequestException("Export has expired");
    if (job.status !== "completed" || !job.fileKey) throw new BadRequestException("Export is not ready for download");
    return { job: this.view(job), file: await this.storage.getFileStream(user.orgId, job.fileKey) };
  }

  async claim(orgId: string): Promise<FinanceReportExportJobRow | null> {
    const candidate = (
      await this.db
        .select()
        .from(financeReportExportJobs)
        .where(and(eq(financeReportExportJobs.orgId, orgId), eq(financeReportExportJobs.status, "pending")))
        .orderBy(asc(financeReportExportJobs.createdAt))
        .limit(1)
    )[0];
    if (!candidate) return null;
    const rows = await this.db
      .update(financeReportExportJobs)
      .set({ status: "running", attempt: candidate.attempt + 1, lockedAt: new Date(), updatedAt: new Date(), errorCode: null, errorMessage: null })
      .where(and(eq(financeReportExportJobs.id, candidate.id), eq(financeReportExportJobs.status, "pending")))
      .returning();
    return rows[0] ?? null;
  }

  async progress(id: string, processedRows: number) {
    await this.db
      .update(financeReportExportJobs)
      .set({ processedRows, updatedAt: new Date(), lockedAt: new Date() })
      .where(and(eq(financeReportExportJobs.id, id), eq(financeReportExportJobs.status, "running")));
  }

  async complete(id: string, fileKey: string, fileName: string, size: number, count: number, truncated: boolean) {
    const now = new Date();
    await this.db
      .update(financeReportExportJobs)
      .set({ status: "completed", fileKey, fileName, fileSizeBytes: size, rowCount: count, processedRows: count, truncated, completedAt: now, expiresAt: new Date(now.getTime() + EXPIRY_MS), lockedAt: null, updatedAt: now })
      .where(and(eq(financeReportExportJobs.id, id), eq(financeReportExportJobs.status, "running")));
  }

  async fail(job: FinanceReportExportJobRow, error: unknown) {
    const retry = job.attempt < job.maxAttempts;
    await this.db
      .update(financeReportExportJobs)
      .set({ status: retry ? "pending" : "failed", errorCode: "EXPORT_GENERATION_FAILED", errorMessage: error instanceof Error ? error.message.slice(0, 500) : "Export generation failed", lockedAt: null, updatedAt: new Date() })
      .where(and(eq(financeReportExportJobs.id, job.id), eq(financeReportExportJobs.status, "running")));
  }

  async cancel(user: CurrentUserContext, id: string) {
    const job = await this.find(user, id);
    const rows = await this.db
      .update(financeReportExportJobs)
      .set({ status: "cancelled", lockedAt: null, updatedAt: new Date() })
      .where(and(eq(financeReportExportJobs.id, job.id), inArray(financeReportExportJobs.status, ["pending", "running"])))
      .returning();
    const updated = rows[0];
    if (!updated) throw new ConflictException("Export job cannot be cancelled in its current state");
    return this.view(updated);
  }

  async reclaim(orgId: string, staleBefore: Date) {
    await this.db
      .update(financeReportExportJobs)
      .set({ status: "pending", lockedAt: null, updatedAt: new Date() })
      .where(and(eq(financeReportExportJobs.orgId, orgId), eq(financeReportExportJobs.status, "running"), lte(financeReportExportJobs.lockedAt, staleBefore)));
  }

  private async find(user: CurrentUserContext, id: string) {
    const requesterMembershipId = accountableMembershipId(user.principal);
    if (requesterMembershipId === null) throw new NotFoundException("Finance report export job not found");
    const job = (
      await this.db
        .select()
        .from(financeReportExportJobs)
        .where(
          and(
            eq(financeReportExportJobs.orgId, user.orgId),
            eq(financeReportExportJobs.requestedByMembershipId, requesterMembershipId),
            eq(financeReportExportJobs.id, id),
          ),
        )
        .limit(1)
    )[0];
    if (!job) throw new NotFoundException("Finance report export job not found");
    return job;
  }

  private view(job: FinanceReportExportJobRow) {
    return {
      id: job.id,
      reportType: job.reportType,
      status: job.status,
      processedRows: job.processedRows,
      rowCount: job.rowCount,
      truncated: job.truncated,
      fileName: job.fileName,
      errorCode: job.errorCode,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      expiresAt: job.expiresAt,
    };
  }
}
