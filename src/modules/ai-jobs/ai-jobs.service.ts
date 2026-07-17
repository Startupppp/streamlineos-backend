import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNotNull, lt, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { aiJobs } from "../../db/schema";
import type { AiJob } from "../../db/schema";

export interface EnqueueInput {
  orgId: string;
  userId?: string;
  type: string;
  payload: Record<string, unknown>;
  priority?: number;
  runAt?: Date;
  maxAttempts?: number;
  idempotencyKey?: string;
}

export interface ListJobsOptions {
  type?: string;
  status?: string;
  cursor?: number;
  limit?: number;
}

@Injectable()
export class AiJobsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async enqueue(input: EnqueueInput): Promise<{ jobId: number }> {
    if (input.idempotencyKey) {
      const existing = await this.db.query.aiJobs.findFirst({
        where: and(
          eq(aiJobs.orgId, input.orgId),
          eq(aiJobs.idempotencyKey, input.idempotencyKey),
        ),
      });
      if (existing) return { jobId: existing.id };
    }

    const rows = await this.db
      .insert(aiJobs)
      .values({
        orgId: input.orgId,
        userId: input.userId ?? null,
        type: input.type,
        payload: input.payload,
        priority: input.priority ?? 0,
        runAt: input.runAt ?? new Date(),
        maxAttempts: input.maxAttempts ?? 3,
        idempotencyKey: input.idempotencyKey ?? null,
      })
      .returning({ id: aiJobs.id });

    const row = rows[0];
    if (!row) throw new Error("Failed to enqueue AI job");
    return { jobId: row.id };
  }

  async claimBatch(workerId: string, limit: number): Promise<AiJob[]> {
    const now = new Date();
    const claimed = await this.db.execute(sql`
      UPDATE ai_jobs
      SET status = 'RUNNING',
          locked_by = ${workerId},
          locked_at = ${now},
          updated_at = ${now}
      WHERE id IN (
        SELECT id FROM ai_jobs
        WHERE status = 'QUEUED' AND run_at <= ${now}
        ORDER BY priority DESC, run_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING
        id, org_id, user_id, type, payload, status, priority,
        attempts, max_attempts, idempotency_key, run_at,
        locked_by, locked_at, last_error, result, created_at, updated_at
    `);

    return claimed.map((row) => ({
      id: Number(row["id"]),
      orgId: String(row["org_id"]),
      userId: row["user_id"] != null ? String(row["user_id"]) : null,
      type: String(row["type"]),
      payload: (row["payload"] ?? {}) as Record<string, unknown>,
      status: String(row["status"]) as AiJob["status"],
      priority: Number(row["priority"]),
      attempts: Number(row["attempts"]),
      maxAttempts: Number(row["max_attempts"]),
      idempotencyKey: row["idempotency_key"] != null ? String(row["idempotency_key"]) : null,
      runAt: new Date(String(row["run_at"])),
      lockedBy: row["locked_by"] != null ? String(row["locked_by"]) : null,
      lockedAt: row["locked_at"] != null ? new Date(String(row["locked_at"])) : null,
      lastError: row["last_error"] != null ? String(row["last_error"]) : null,
      result: (row["result"] ?? null) as Record<string, unknown> | null,
      createdAt: new Date(String(row["created_at"])),
      updatedAt: new Date(String(row["updated_at"])),
    }));
  }

  async complete(jobId: number, result: Record<string, unknown>): Promise<void> {
    await this.db
      .update(aiJobs)
      .set({ status: "COMPLETED", result, lockedBy: null, lockedAt: null })
      .where(eq(aiJobs.id, jobId));
  }

  async fail(jobId: number, error: string): Promise<void> {
    const job = await this.db.query.aiJobs.findFirst({
      where: eq(aiJobs.id, jobId),
    });
    if (!job) return;

    const nextAttempts = job.attempts + 1;
    if (nextAttempts >= job.maxAttempts) {
      await this.db
        .update(aiJobs)
        .set({ status: "DEAD", attempts: nextAttempts, lastError: error, lockedBy: null, lockedAt: null })
        .where(eq(aiJobs.id, jobId));
      return;
    }

    const backoffMinutes = Math.pow(2, nextAttempts);
    const nextRunAt = new Date(Date.now() + backoffMinutes * 60_000);
    await this.db
      .update(aiJobs)
      .set({
        status: "QUEUED",
        attempts: nextAttempts,
        lastError: error,
        runAt: nextRunAt,
        lockedBy: null,
        lockedAt: null,
      })
      .where(eq(aiJobs.id, jobId));
  }

  async cancel(orgId: string, jobId: number): Promise<void> {
    await this.db
      .update(aiJobs)
      .set({ status: "CANCELLED" })
      .where(and(eq(aiJobs.id, jobId), eq(aiJobs.orgId, orgId), eq(aiJobs.status, "QUEUED")));
  }

  async getStatus(orgId: string, jobId: number): Promise<AiJob | null> {
    const job = await this.db.query.aiJobs.findFirst({
      where: and(eq(aiJobs.id, jobId), eq(aiJobs.orgId, orgId)),
    });
    return job ?? null;
  }

  async listJobs(orgId: string, opts: ListJobsOptions): Promise<{ items: AiJob[]; nextCursor: number | null }> {
    const limit = Math.min(opts.limit ?? 25, 100);
    const conditions = [eq(aiJobs.orgId, orgId)];

    if (opts.type) conditions.push(eq(aiJobs.type, opts.type));
    if (opts.status) conditions.push(eq(aiJobs.status, opts.status as AiJob["status"]));
    if (opts.cursor) conditions.push(lt(aiJobs.id, opts.cursor));

    const items = await this.db.query.aiJobs.findMany({
      where: and(...conditions),
      orderBy: (t, { desc }) => [desc(t.id)],
      limit: limit + 1,
    });

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

    return { items: page, nextCursor };
  }

  async releaseStaleLocks(olderThanMinutes: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
    const rows = await this.db
      .update(aiJobs)
      .set({ status: "QUEUED", lockedBy: null, lockedAt: null })
      .where(
        and(
          eq(aiJobs.status, "RUNNING"),
          isNotNull(aiJobs.lockedAt),
          lte(aiJobs.lockedAt, cutoff),
        ),
      )
      .returning({ id: aiJobs.id });
    return rows.length;
  }
}
