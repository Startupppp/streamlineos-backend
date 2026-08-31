import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, lt, lte } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { gdprExportJobs } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { StorageService, type FileStreamResult } from "../storage/storage.service";
import { OutboxWriter } from "../../common/outbox/outbox-writer";
import {
  GDPR_EXPORT_REQUESTED_EVENT,
  GDPR_EXPORT_AGGREGATE_TYPE,
} from "./dto/gdpr-export-outbox.schemas";

export type GdprExportJobRow = typeof gdprExportJobs.$inferSelect;

const EXPIRY_MS = 72 * 60 * 60 * 1000;

@Injectable()
export class GdprExportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
  ) {}

  async create(
    requestedBy: string,
    orgId: string,
    subjectUserId: string,
    idempotencyKey: string,
  ) {
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ orgId, subjectUserId }))
      .digest("hex");

    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(gdprExportJobs)
        .values({ orgId, subjectUserId, requestedBy, idempotencyKey, requestHash })
        .onConflictDoNothing({ target: [gdprExportJobs.orgId, gdprExportJobs.idempotencyKey] })
        .returning();

      const isNew = inserted.length > 0;
      const job =
        inserted[0] ??
        (
          await tx
            .select()
            .from(gdprExportJobs)
            .where(
              and(
                eq(gdprExportJobs.orgId, orgId),
                eq(gdprExportJobs.idempotencyKey, idempotencyKey),
              ),
            )
            .limit(1)
        )[0];

      if (!job) throw new BadRequestException("Failed to create GDPR export job");

      if (job.requestedBy !== requestedBy || job.requestHash !== requestHash)
        throw new BadRequestException("Idempotency-Key was used for a different export request");

      if (isNew) {
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType: GDPR_EXPORT_AGGREGATE_TYPE,
          aggregateId: job.id,
          aggregateVersion: 1,
          eventType: GDPR_EXPORT_REQUESTED_EVENT,
          payload: { jobId: job.id, orgId },
          occurredAt: new Date(),
        });
      }

      return this.view(job);
    });
  }

  async get(requestedByUserId: string, orgId: string, jobId: string, isAdmin: boolean) {
    const job = await this.findJob(orgId, jobId, requestedByUserId, isAdmin);
    return this.view(job);
  }

  async download(
    requestedByUserId: string,
    orgId: string,
    jobId: string,
    isAdmin: boolean,
  ): Promise<{ job: ReturnType<GdprExportService["view"]>; file: FileStreamResult }> {
    const job = await this.findJob(orgId, jobId, requestedByUserId, isAdmin);
    if (job.status === "expired" || (job.expiresAt && job.expiresAt <= new Date()))
      throw new BadRequestException("Export has expired");
    if (job.status !== "completed" || !job.fileKey)
      throw new BadRequestException("Export is not ready for download");
    return { job: this.view(job), file: await this.storage.getFileStream(orgId, job.fileKey) };
  }

  async claim(orgId: string): Promise<GdprExportJobRow | null> {
    const candidate = (
      await this.db
        .select()
        .from(gdprExportJobs)
        .where(
          and(eq(gdprExportJobs.orgId, orgId), eq(gdprExportJobs.status, "pending")),
        )
        .orderBy(asc(gdprExportJobs.createdAt))
        .limit(1)
    )[0];
    if (!candidate) return null;
    const rows = await this.db
      .update(gdprExportJobs)
      .set({
        status: "running",
        attempt: candidate.attempt + 1,
        lockedAt: new Date(),
        updatedAt: new Date(),
        errorCode: null,
        errorMessage: null,
      })
      .where(
        and(eq(gdprExportJobs.id, candidate.id), eq(gdprExportJobs.status, "pending")),
      )
      .returning();
    return rows[0] ?? null;
  }

  async complete(
    id: string,
    fileKey: string,
    fileName: string,
    size: number,
    rowCount: number,
    truncated: boolean,
  ) {
    const now = new Date();
    await this.db
      .update(gdprExportJobs)
      .set({
        status: "completed",
        fileKey,
        fileName,
        fileSizeBytes: size,
        rowCount,
        truncated,
        completedAt: now,
        expiresAt: new Date(now.getTime() + EXPIRY_MS),
        lockedAt: null,
        updatedAt: now,
      })
      .where(and(eq(gdprExportJobs.id, id), eq(gdprExportJobs.status, "running")));
  }

  async fail(job: GdprExportJobRow, error: unknown) {
    const retry = job.attempt < job.maxAttempts;
    await this.db
      .update(gdprExportJobs)
      .set({
        status: retry ? "pending" : "failed",
        errorCode: "EXPORT_GENERATION_FAILED",
        errorMessage:
          error instanceof Error ? error.message.slice(0, 500) : "Export generation failed",
        lockedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(eq(gdprExportJobs.id, job.id), eq(gdprExportJobs.status, "running")),
      );
  }

  async reclaim(orgId: string, staleBefore: Date) {
    await this.db
      .update(gdprExportJobs)
      .set({ status: "pending", lockedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(gdprExportJobs.orgId, orgId),
          eq(gdprExportJobs.status, "running"),
          lte(gdprExportJobs.lockedAt, staleBefore),
        ),
      );
  }

  private async findJob(
    orgId: string,
    jobId: string,
    requestedByUserId: string,
    isAdmin: boolean,
  ): Promise<GdprExportJobRow> {
    const conditions = [eq(gdprExportJobs.orgId, orgId), eq(gdprExportJobs.id, jobId)];
    if (!isAdmin) conditions.push(eq(gdprExportJobs.requestedBy, requestedByUserId));

    const job = (
      await this.db
        .select()
        .from(gdprExportJobs)
        .where(and(...conditions))
        .limit(1)
    )[0];

    if (!job) throw new NotFoundException("GDPR export job not found");
    return job;
  }

  view(job: GdprExportJobRow) {
    return {
      id: job.id,
      status: job.status,
      subjectUserId: job.subjectUserId,
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

  async expireOldJobs(orgId: string, now: Date) {
    await this.db
      .update(gdprExportJobs)
      .set({ status: "expired", updatedAt: now })
      .where(
        and(
          eq(gdprExportJobs.orgId, orgId),
          eq(gdprExportJobs.status, "completed"),
          lt(gdprExportJobs.expiresAt, now),
        ),
      );
  }
}
