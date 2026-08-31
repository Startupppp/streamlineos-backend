import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gt, gte, lte } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { expenseExportJobs, expenses, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { accountableMembershipId } from "../../common/auth/principal";
import { StorageService, type FileStreamResult } from "../storage/storage.service";
import type { ExportInput } from "./dto/expense.schemas";
import type { DataScope } from "../access/access.types";
import { OutboxWriter } from "../../common/outbox/outbox-writer";
import {
  EXPENSE_EXPORT_REQUESTED_EVENT,
  EXPENSE_EXPORT_AGGREGATE_TYPE,
} from "./dto/expense-outbox.schemas";
import type { ExpenseExportFilters } from "../../db/schema/payroll/expense-export-jobs";

export type ExpenseExportJobRow = typeof expenseExportJobs.$inferSelect;
const EXPIRY_MS = 24 * 60 * 60 * 1000;
export const EXPORT_BATCH_SIZE = 500;

@Injectable()
export class ExpenseExportService {
  constructor(@Inject(DRIZZLE) private readonly db: Db, private readonly storage: StorageService) {}

  async create(user: CurrentUserContext, filters: ExportInput, idempotencyKey: string, scope: DataScope) {
    if (scope === "none") throw new ForbiddenException("Export scope denies access");
    const requesterMembershipId = accountableMembershipId(user.principal);
    if (requesterMembershipId === null) throw new ForbiddenException("A member identity is required to export expenses");
    const storedFilters: ExpenseExportFilters = {
      ...filters,
      scope,
      ...(scope === "own" || scope === "team" ? { userId: user.userId } : {}),
    };
    const requestHash = createHash("sha256").update(JSON.stringify(storedFilters)).digest("hex");
    return this.db.transaction(async (tx) => {
      const inserted = await tx.insert(expenseExportJobs).values({
        orgId: user.orgId, requestedByMembershipId: requesterMembershipId, filters: storedFilters, idempotencyKey, requestHash,
      }).onConflictDoNothing({ target: [expenseExportJobs.orgId, expenseExportJobs.idempotencyKey] }).returning();
      const isNew = inserted.length > 0;
      const job = inserted[0] ?? (await tx.select().from(expenseExportJobs).where(and(eq(expenseExportJobs.orgId, user.orgId), eq(expenseExportJobs.idempotencyKey, idempotencyKey))).limit(1))[0];
      if (!job) throw new BadRequestException("Failed to create expense export job");
      if (job.requestedByMembershipId !== requesterMembershipId || job.requestHash !== requestHash) throw new BadRequestException("Idempotency-Key was used for a different export");
      if (isNew) {
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: user.orgId,
          aggregateType: EXPENSE_EXPORT_AGGREGATE_TYPE,
          aggregateId: job.id,
          aggregateVersion: 1,
          eventType: EXPENSE_EXPORT_REQUESTED_EVENT,
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

  async download(user: CurrentUserContext, id: string): Promise<{ job: ReturnType<ExpenseExportService["view"]>; file: FileStreamResult }> {
    const job = await this.find(user, id);
    if (job.status === "expired" || (job.expiresAt && job.expiresAt <= new Date())) throw new BadRequestException("Export has expired");
    if (job.status !== "completed" || !job.fileKey) throw new BadRequestException("Export is not ready for download");
    return { job: this.view(job), file: await this.storage.getFileStream(user.orgId, job.fileKey) };
  }

  async claim(orgId: string): Promise<ExpenseExportJobRow | null> {
    const candidate = (await this.db.select().from(expenseExportJobs).where(and(eq(expenseExportJobs.orgId, orgId), eq(expenseExportJobs.status, "pending"))).orderBy(asc(expenseExportJobs.createdAt)).limit(1))[0];
    if (!candidate) return null;
    const rows = await this.db.update(expenseExportJobs).set({ status: "running", attempt: candidate.attempt + 1, lockedAt: new Date(), updatedAt: new Date(), errorCode: null, errorMessage: null }).where(and(eq(expenseExportJobs.id, candidate.id), eq(expenseExportJobs.status, "pending"))).returning();
    return rows[0] ?? null;
  }

  async rows(job: ExpenseExportJobRow, afterId: number | undefined) {
    const f = job.filters;
    if (f.scope === "none") return [];
    const conditions = [eq(expenses.orgId, job.orgId)];
    const requestedUserId = f.userId;
    if (requestedUserId) conditions.push(eq(expenses.userId, requestedUserId));
    if (f.status) conditions.push(eq(expenses.status, f.status));
    if (f.startDate) conditions.push(gte(expenses.expenseDate, f.startDate));
    if (f.endDate) conditions.push(lte(expenses.expenseDate, f.endDate));
    if (afterId !== undefined) conditions.push(gt(expenses.id, afterId));
    return this.db.select({ id: expenses.id, date: expenses.expenseDate, employee: users.name, email: users.email, category: expenses.category, amount: expenses.amount, description: expenses.description, status: expenses.status, rejection: expenses.rejectionReason }).from(expenses).innerJoin(users, eq(users.id, expenses.userId)).where(and(...conditions)).orderBy(asc(expenses.id)).limit(EXPORT_BATCH_SIZE);
  }

  async progress(id: string, processedRows: number) { await this.db.update(expenseExportJobs).set({ processedRows, updatedAt: new Date(), lockedAt: new Date() }).where(and(eq(expenseExportJobs.id, id), eq(expenseExportJobs.status, "running"))); }
  async complete(id: string, fileKey: string, fileName: string, size: number, count: number, truncated: boolean) { const now = new Date(); await this.db.update(expenseExportJobs).set({ status: "completed", fileKey, fileName, fileSizeBytes: size, rowCount: count, processedRows: count, truncated, completedAt: now, expiresAt: new Date(now.getTime() + EXPIRY_MS), lockedAt: null, updatedAt: now }).where(and(eq(expenseExportJobs.id, id), eq(expenseExportJobs.status, "running"))); }
  async fail(job: ExpenseExportJobRow, error: unknown) { const retry = job.attempt < job.maxAttempts; await this.db.update(expenseExportJobs).set({ status: retry ? "pending" : "failed", errorCode: "EXPORT_GENERATION_FAILED", errorMessage: error instanceof Error ? error.message.slice(0, 500) : "Export generation failed", lockedAt: null, updatedAt: new Date() }).where(and(eq(expenseExportJobs.id, job.id), eq(expenseExportJobs.status, "running"))); }
  async reclaim(orgId: string, staleBefore: Date) { await this.db.update(expenseExportJobs).set({ status: "pending", lockedAt: null, updatedAt: new Date() }).where(and(eq(expenseExportJobs.orgId, orgId), eq(expenseExportJobs.status, "running"), lte(expenseExportJobs.lockedAt, staleBefore))); }

  private async find(user: CurrentUserContext, id: string) {
    const requesterMembershipId = accountableMembershipId(user.principal);
    if (requesterMembershipId === null) throw new NotFoundException("Expense export job not found");
    const job = (await this.db.select().from(expenseExportJobs).where(and(eq(expenseExportJobs.orgId, user.orgId), eq(expenseExportJobs.requestedByMembershipId, requesterMembershipId), eq(expenseExportJobs.id, id))).limit(1))[0];
    if (!job) throw new NotFoundException("Expense export job not found");
    return job;
  }
  private view(job: ExpenseExportJobRow) { return { id: job.id, status: job.status, processedRows: job.processedRows, rowCount: job.rowCount, truncated: job.truncated, fileName: job.fileName, errorCode: job.errorCode, errorMessage: job.errorMessage, createdAt: job.createdAt, completedAt: job.completedAt, expiresAt: job.expiresAt }; }
}
