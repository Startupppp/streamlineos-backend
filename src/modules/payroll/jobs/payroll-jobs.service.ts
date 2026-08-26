import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "crypto";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { payrollJobs } from "../../../db/schema";
import { getPostgresErrorCode } from "../../../common/db/postgres-error";
import { logger } from "../../../common/logger/logger.service";

export type PayrollJobType =
  | "PREVIEW"
  | "GENERATE"
  | "RECALCULATE"
  | "PDF_PUBLISH"
  | "EXPORT"
  | "RECONCILE"
  | "FILING_EXPORT";

@Injectable()
export class PayrollJobsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async enqueue(params: {
    orgId: string;
    jobType: PayrollJobType;
    actorId: string;
    resourceType?: string;
    resourceId?: string;
    payload?: Record<string, unknown>;
    idempotencyKey?: string;
  }) {
    const correlationId = randomUUID();
    const key = params.idempotencyKey ?? `${params.jobType}:${params.resourceType ?? ""}:${params.resourceId ?? ""}:${correlationId}`;

    if (params.idempotencyKey) {
      const existing = await this.db.query.payrollJobs.findFirst({
        where: and(
          eq(payrollJobs.orgId, params.orgId),
          eq(payrollJobs.idempotencyKey, params.idempotencyKey),
        ),
      });
      if (existing) {
        if (existing.status === "SUCCEEDED" || existing.status === "RUNNING" || existing.status === "PENDING") {
          return existing;
        }
      }
    }

    try {
      const [row] = await this.db
        .insert(payrollJobs)
        .values({
          orgId: params.orgId,
          jobType: params.jobType,
          resourceType: params.resourceType ?? null,
          resourceId: params.resourceId ?? null,
          status: "PENDING",
          progress: 0,
          attempt: 0,
          correlationId,
          idempotencyKey: key,
          payload: params.payload ?? null,
          createdBy: params.actorId,
        })
        .returning();
      return row!;
    } catch (err) {
      if (getPostgresErrorCode(err) !== "23505") {
        logger.error("payroll-jobs.enqueue: insert failed unexpectedly", {
          cause: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      throw new ConflictException("Job already enqueued for this idempotency key");
    }
  }

  async markRunning(orgId: string, jobId: number) {
    const [row] = await this.db
      .update(payrollJobs)
      .set({
        status: "RUNNING",
        startedAt: new Date(),
        attempt: (await this.getAttempt(orgId, jobId)) + 1,
      })
      .where(and(eq(payrollJobs.id, jobId), eq(payrollJobs.orgId, orgId)))
      .returning();
    if (!row) throw new NotFoundException("Job not found");
    return row;
  }

  private async getAttempt(orgId: string, jobId: number): Promise<number> {
    const row = await this.db.query.payrollJobs.findFirst({
      where: and(eq(payrollJobs.id, jobId), eq(payrollJobs.orgId, orgId)),
      columns: { attempt: true },
    });
    return row?.attempt ?? 0;
  }

  async setProgress(orgId: string, jobId: number, progress: number) {
    await this.db
      .update(payrollJobs)
      .set({ progress: Math.max(0, Math.min(100, progress)) })
      .where(and(eq(payrollJobs.id, jobId), eq(payrollJobs.orgId, orgId)));
  }

  async succeed(orgId: string, jobId: number, result?: Record<string, unknown>) {
    const [row] = await this.db
      .update(payrollJobs)
      .set({
        status: "SUCCEEDED",
        progress: 100,
        result: result ?? null,
        finishedAt: new Date(),
        errorMessage: null,
      })
      .where(and(eq(payrollJobs.id, jobId), eq(payrollJobs.orgId, orgId)))
      .returning();
    return row;
  }

  async fail(orgId: string, jobId: number, errorMessage: string) {
    const existing = await this.db.query.payrollJobs.findFirst({
      where: and(eq(payrollJobs.id, jobId), eq(payrollJobs.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Job not found");

    const nextAttempt = existing.attempt;
    const dead = nextAttempt >= existing.maxAttempts;
    const [row] = await this.db
      .update(payrollJobs)
      .set({
        status: dead ? "DEAD_LETTER" : "FAILED",
        errorMessage,
        finishedAt: new Date(),
      })
      .where(eq(payrollJobs.id, jobId))
      .returning();
    return row;
  }

  async retry(orgId: string, jobId: number) {
    const existing = await this.db.query.payrollJobs.findFirst({
      where: and(eq(payrollJobs.id, jobId), eq(payrollJobs.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Job not found");
    if (existing.status !== "FAILED" && existing.status !== "DEAD_LETTER") {
      throw new ConflictException("Only FAILED or DEAD_LETTER jobs can be retried");
    }
    const [row] = await this.db
      .update(payrollJobs)
      .set({
        status: "PENDING",
        errorMessage: null,
        finishedAt: null,
        progress: 0,
      })
      .where(eq(payrollJobs.id, jobId))
      .returning();
    return row;
  }

  async get(orgId: string, jobId: number) {
    const row = await this.db.query.payrollJobs.findFirst({
      where: and(eq(payrollJobs.id, jobId), eq(payrollJobs.orgId, orgId)),
    });
    if (!row) throw new NotFoundException("Job not found");
    return row;
  }

  async listFailed(orgId: string, limit = 50) {
    return this.db
      .select()
      .from(payrollJobs)
      .where(
        and(
          eq(payrollJobs.orgId, orgId),
          inArray(payrollJobs.status, ["FAILED", "DEAD_LETTER"]),
        ),
      )
      .limit(limit);
  }

  /** Claim a batch of PENDING jobs for a worker (cross-process safe-ish via status flip). */
  async claimPending(limit = 10): Promise<(typeof payrollJobs.$inferSelect)[]> {
    const pending = await this.db
      .select()
      .from(payrollJobs)
      .where(eq(payrollJobs.status, "PENDING"))
      .orderBy(asc(payrollJobs.createdAt))
      .limit(limit);

    const claimed: (typeof payrollJobs.$inferSelect)[] = [];
    for (const job of pending) {
      const [row] = await this.db
        .update(payrollJobs)
        .set({
          status: "RUNNING",
          startedAt: new Date(),
          attempt: (job.attempt ?? 0) + 1,
          progress: 1,
        })
        .where(and(eq(payrollJobs.id, job.id), eq(payrollJobs.status, "PENDING")))
        .returning();
      if (row) claimed.push(row);
    }
    return claimed;
  }

  async listForResource(orgId: string, resourceType: string, resourceId: string, limit = 20) {
    return this.db
      .select()
      .from(payrollJobs)
      .where(
        and(
          eq(payrollJobs.orgId, orgId),
          eq(payrollJobs.resourceType, resourceType),
          eq(payrollJobs.resourceId, resourceId),
        ),
      )
      .orderBy(asc(payrollJobs.createdAt))
      .limit(limit);
  }
}
