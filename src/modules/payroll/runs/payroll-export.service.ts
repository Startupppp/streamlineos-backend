import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { createHash } from "node:crypto";
import { payrollRunExportJobs, payrollRuns } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { accountableMembershipId } from "../../../common/auth/principal";
import { StorageService, type FileStreamResult } from "../../storage/storage.service";
import type { PayrollRunExportFilters } from "../../../db/schema/payroll/payroll-export-jobs";

export type PayrollRunExportJobRow = typeof payrollRunExportJobs.$inferSelect;

const EXPIRY_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 500;

@Injectable()
export class PayrollRunExportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
  ) {}

  async create(
    user: CurrentUserContext,
    filters: PayrollRunExportFilters,
    idempotencyKey: string,
  ): Promise<ReturnType<PayrollRunExportService["view"]>> {
    const requesterMembershipId = accountableMembershipId(user.principal);
    if (requesterMembershipId === null) {
      throw new ForbiddenException("A member identity is required to export payroll data");
    }
    const requestHash = createHash("sha256").update(JSON.stringify(filters)).digest("hex");
    const inserted = await this.db
      .insert(payrollRunExportJobs)
      .values({
        orgId: user.orgId,
        requestedByMembershipId: requesterMembershipId,
        filters,
        idempotencyKey,
        requestHash,
      })
      .onConflictDoNothing({ target: [payrollRunExportJobs.orgId, payrollRunExportJobs.idempotencyKey] })
      .returning();
    const job = inserted[0] ?? (
      await this.db
        .select()
        .from(payrollRunExportJobs)
        .where(and(
          eq(payrollRunExportJobs.orgId, user.orgId),
          eq(payrollRunExportJobs.idempotencyKey, idempotencyKey),
        ))
        .limit(1)
    )[0];
    if (!job) throw new BadRequestException("Failed to create payroll export job");
    if (job.requestedByMembershipId !== requesterMembershipId || job.requestHash !== requestHash) {
      throw new BadRequestException("Idempotency-Key was used for a different export");
    }
    return this.view(job);
  }

  async get(user: CurrentUserContext, id: string): Promise<ReturnType<PayrollRunExportService["view"]>> {
    const job = await this.find(user, id);
    return this.view(job);
  }

  async download(
    user: CurrentUserContext,
    id: string,
  ): Promise<{ job: ReturnType<PayrollRunExportService["view"]>; file: FileStreamResult }> {
    const job = await this.find(user, id);
    if (job.status === "expired" || (job.expiresAt && job.expiresAt <= new Date())) {
      throw new BadRequestException("Export has expired");
    }
    if (job.status !== "completed" || !job.fileKey) {
      throw new BadRequestException("Export is not ready for download");
    }
    return { job: this.view(job), file: await this.storage.getFileStream(user.orgId, job.fileKey) };
  }

  async claim(orgId: string): Promise<PayrollRunExportJobRow | null> {
    const candidate = (
      await this.db
        .select()
        .from(payrollRunExportJobs)
        .where(and(eq(payrollRunExportJobs.orgId, orgId), eq(payrollRunExportJobs.status, "pending")))
        .orderBy(asc(payrollRunExportJobs.createdAt))
        .limit(1)
    )[0];
    if (!candidate) return null;
    const rows = await this.db
      .update(payrollRunExportJobs)
      .set({
        status: "running",
        attempt: candidate.attempt + 1,
        lockedAt: new Date(),
        updatedAt: new Date(),
        errorCode: null,
        errorMessage: null,
      })
      .where(and(eq(payrollRunExportJobs.id, candidate.id), eq(payrollRunExportJobs.status, "pending")))
      .returning();
    return rows[0] ?? null;
  }

  async rows(job: PayrollRunExportJobRow, afterId: number | undefined) {
    const f = job.filters;
    const conditions = [eq(payrollRuns.orgId, job.orgId)];
    if (f.entityId != null) conditions.push(eq(payrollRuns.entityId, f.entityId));
    if (f.runType) conditions.push(eq(payrollRuns.runType, f.runType as "REGULAR" | "BONUS" | "OFF_CYCLE" | "CORRECTION" | "FINAL_SETTLEMENT"));
    if (f.monthFrom) conditions.push(gte(payrollRuns.month, f.monthFrom));
    if (f.monthTo) conditions.push(lte(payrollRuns.month, f.monthTo));
    if (afterId !== undefined) conditions.push(eq(payrollRuns.id, afterId));
    return this.db
      .select({
        id: payrollRuns.id,
        month: payrollRuns.month,
        runType: payrollRuns.runType,
        status: payrollRuns.status,
        employeeCount: payrollRuns.employeeCount,
        grossTotal: payrollRuns.grossTotal,
        netTotal: payrollRuns.netTotal,
        exceptionCount: payrollRuns.exceptionCount,
        createdAt: payrollRuns.createdAt,
      })
      .from(payrollRuns)
      .where(and(...conditions))
      .orderBy(desc(payrollRuns.month), asc(payrollRuns.id))
      .limit(BATCH_SIZE);
  }

  async progress(id: string, processedRows: number) {
    await this.db
      .update(payrollRunExportJobs)
      .set({ processedRows, updatedAt: new Date(), lockedAt: new Date() })
      .where(and(eq(payrollRunExportJobs.id, id), eq(payrollRunExportJobs.status, "running")));
  }

  async complete(id: string, fileKey: string, fileName: string, size: number, count: number) {
    const now = new Date();
    await this.db
      .update(payrollRunExportJobs)
      .set({
        status: "completed",
        fileKey,
        fileName,
        fileSizeBytes: size,
        rowCount: count,
        processedRows: count,
        completedAt: now,
        expiresAt: new Date(now.getTime() + EXPIRY_MS),
        lockedAt: null,
        updatedAt: now,
      })
      .where(and(eq(payrollRunExportJobs.id, id), eq(payrollRunExportJobs.status, "running")));
  }

  async fail(job: PayrollRunExportJobRow, error: unknown) {
    const retry = job.attempt < job.maxAttempts;
    await this.db
      .update(payrollRunExportJobs)
      .set({
        status: retry ? "pending" : "failed",
        errorCode: "EXPORT_GENERATION_FAILED",
        errorMessage: error instanceof Error ? error.message.slice(0, 500) : "Export generation failed",
        lockedAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(payrollRunExportJobs.id, job.id), eq(payrollRunExportJobs.status, "running")));
  }

  async reclaim(orgId: string, staleBefore: Date) {
    await this.db
      .update(payrollRunExportJobs)
      .set({ status: "pending", lockedAt: null, updatedAt: new Date() })
      .where(and(
        eq(payrollRunExportJobs.orgId, orgId),
        eq(payrollRunExportJobs.status, "running"),
        lte(payrollRunExportJobs.lockedAt, staleBefore),
      ));
  }

  private async find(user: CurrentUserContext, id: string): Promise<PayrollRunExportJobRow> {
    const requesterMembershipId = accountableMembershipId(user.principal);
    if (requesterMembershipId === null) throw new NotFoundException("Payroll export job not found");
    const job = (
      await this.db
        .select()
        .from(payrollRunExportJobs)
        .where(and(
          eq(payrollRunExportJobs.orgId, user.orgId),
          eq(payrollRunExportJobs.requestedByMembershipId, requesterMembershipId),
          eq(payrollRunExportJobs.id, id),
        ))
        .limit(1)
    )[0];
    if (!job) throw new NotFoundException("Payroll export job not found");
    return job;
  }

  view(job: PayrollRunExportJobRow) {
    return {
      id: job.id,
      status: job.status,
      processedRows: job.processedRows,
      rowCount: job.rowCount,
      fileName: job.fileName,
      errorCode: job.errorCode,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      expiresAt: job.expiresAt,
    };
  }
}
