import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { payrollJobs } from "../../../db/schema";
import { isUniqueViolation } from "../../../common/db/postgres-error";
import { logger } from "../../../common/logger/logger.service";
import { buildCursorPage, decodeCursor, type CursorPage } from "../../../common/pagination/cursor";
import { keysetAfterId, keysetBeforeId } from "../../../common/pagination/keyset";

export type PayrollJobType =
  | "GENERATE"
  | "RECALCULATE"
  | "PDF_PUBLISH"
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
      if (!isUniqueViolation(err)) {
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

  async listFailed(
    orgId: string,
    cursor: string | undefined,
    limit = 50,
  ): Promise<CursorPage<typeof payrollJobs.$inferSelect>> {
    const cap = Math.min(limit, 100);
    const position = decodeCursor(cursor);
    const rows = await this.db
      .select()
      .from(payrollJobs)
      .where(
        and(
          eq(payrollJobs.orgId, orgId),
          inArray(payrollJobs.status, ["FAILED", "DEAD_LETTER"]),
          position ? keysetBeforeId(payrollJobs.createdAt, payrollJobs.id, position) : undefined,
        ),
      )
      .orderBy(desc(payrollJobs.createdAt), desc(payrollJobs.id))
      .limit(cap + 1);
    return buildCursorPage(rows, cap, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: String(row.id),
    }));
  }

  /**
   * Claim a batch of PENDING jobs for a worker (cross-process safe-ish via status flip).
   *
   * One `UPDATE … WHERE id = ANY(…) AND status = 'PENDING' RETURNING *` rather than one
   * round trip per candidate, and `attempt` is incremented in SQL rather than from the
   * value the SELECT read: a second worker that claimed the same row between the two
   * statements would otherwise have its increment written back over. The `status =
   * 'PENDING'` predicate still does the claiming, so a row another worker took is simply
   * absent from RETURNING. Rows come back unordered, so the FIFO order of the candidate
   * SELECT is restored before returning.
   */
  async claimPending(limit = 10): Promise<(typeof payrollJobs.$inferSelect)[]> {
    const pending = await this.db
      .select({ id: payrollJobs.id })
      .from(payrollJobs)
      .where(eq(payrollJobs.status, "PENDING"))
      .orderBy(asc(payrollJobs.createdAt))
      .limit(limit);
    if (pending.length === 0) return [];

    const claimed = await this.db
      .update(payrollJobs)
      .set({
        status: "RUNNING",
        startedAt: new Date(),
        attempt: sql`coalesce(${payrollJobs.attempt}, 0) + 1`,
        progress: 1,
      })
      .where(
        and(
          inArray(
            payrollJobs.id,
            pending.map((job) => job.id),
          ),
          eq(payrollJobs.status, "PENDING"),
        ),
      )
      .returning();

    const order = new Map(pending.map((job, index) => [job.id, index]));
    return claimed.sort(
      (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
    );
  }

  async listForResource(
    orgId: string,
    resourceType: string,
    resourceId: string,
    cursor: string | undefined,
    limit = 20,
  ): Promise<CursorPage<typeof payrollJobs.$inferSelect>> {
    const cap = Math.min(limit, 100);
    const position = decodeCursor(cursor);
    const rows = await this.db
      .select()
      .from(payrollJobs)
      .where(
        and(
          eq(payrollJobs.orgId, orgId),
          eq(payrollJobs.resourceType, resourceType),
          eq(payrollJobs.resourceId, resourceId),
          position ? keysetAfterId(payrollJobs.createdAt, payrollJobs.id, position) : undefined,
        ),
      )
      .orderBy(asc(payrollJobs.createdAt), asc(payrollJobs.id))
      .limit(cap + 1);
    return buildCursorPage(rows, cap, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: String(row.id),
    }));
  }
}
