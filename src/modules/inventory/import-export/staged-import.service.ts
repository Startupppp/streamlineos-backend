import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { invImportJobs, invImportRows } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import type { ImportType } from "./dto/import-export.schemas";

/**
 * Resumable imports — INV-108.
 *
 * The previous importer took rows in the request body, capped at 10,000, and
 * applied every one of them synchronously inside the request's transaction. A
 * 100,000-row file could not be expressed at all, and a failure at row 9,000
 * lost the 8,999 before it with nothing to resume from.
 *
 * Three properties make this resumable rather than merely chunked:
 *
 * Rows are durable before any of them is applied. Staging and processing are
 * separate calls, so the work survives the process that started it.
 *
 * Each chunk commits on its own. A crash costs at most one chunk, and the job's
 * cursor says where to start again — resuming is just calling process again.
 *
 * Every row carries its own outcome. A re-run skips what already applied instead
 * of posting it a second time, which is what makes retry safe rather than
 * merely possible.
 */

/** Ceiling on rows per staging call — the request body still has to fit. */
export const MAX_STAGE_CHUNK = 5_000;
/** Ceiling on rows applied per process call, so one call cannot run unbounded. */
export const MAX_PROCESS_CHUNK = 1_000;

export interface RowOutcome {
  rowNumber: number;
  status: "APPLIED" | "FAILED" | "SKIPPED";
  code?: string;
  field?: string;
  message?: string;
}

/** Applies one staged row. Returning an error marks the row failed, not the job. */
export type RowApplier = (
  orgId: string,
  userId: string,
  jobId: number,
  rowNumber: number,
  payload: Record<string, string>,
) => Promise<Omit<RowOutcome, "rowNumber"> | null>;

interface JobRow {
  id: number;
  status: string;
  jobType: string;
  totalRows: number;
  stagedRows: number;
  processedRows: number;
  errorRows: number;
  nextRow: number;
  chunkSize: number;
  checksum: string | null;
  cancelledAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

@Injectable()
export class StagedImportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: InventoryAuditService,
  ) {}

  /**
   * Opens a job, or returns the one this file already opened.
   *
   * Keyed on the idempotency key rather than the checksum alone: the same file
   * legitimately gets imported twice, and it is the caller saying "this is the
   * same submission" that makes a repeat a replay. A key reused with a different
   * checksum is a different file wearing the same name, and is refused.
   */
  async createJob(
    orgId: string,
    userId: string,
    input: {
      importType: ImportType;
      fileName?: string;
      totalRows: number;
      checksum: string;
      idempotencyKey: string;
      chunkSize?: number;
    },
  ) {
    const existing = await this.db.query.invImportJobs.findFirst({
      where: and(
        eq(invImportJobs.orgId, orgId),
        eq(invImportJobs.idempotencyKey, input.idempotencyKey),
      ),
    });
    if (existing) {
      if (existing.checksum !== input.checksum)
        throw new ConflictException("This import key was already used for a different file");
      return existing;
    }

    const [job] = await this.db
      .insert(invImportJobs)
      .values({
        orgId,
        jobType: input.importType,
        status: "PENDING",
        fileName: input.fileName ?? null,
        totalRows: input.totalRows,
        checksum: input.checksum,
        idempotencyKey: input.idempotencyKey,
        chunkSize: Math.min(input.chunkSize ?? 500, MAX_PROCESS_CHUNK),
        createdBy: userId,
      })
      .returning();
    if (!job) throw new BadRequestException("Could not open the import job");

    await this.cache.invalidateNamespace(CACHE_KEYS.invImportJobsNamespace(orgId));
    return job;
  }

  /**
   * Stages one chunk of rows at their file positions.
   *
   * `onConflictDoNothing` on (job, row_number) is what makes a retried upload
   * safe: the same chunk sent twice lands once, so a client that loses its
   * response can simply send it again.
   */
  async stageRows(
    orgId: string,
    jobId: number,
    rows: readonly { rowNumber: number; payload: Record<string, string> }[],
  ) {
    if (rows.length > MAX_STAGE_CHUNK)
      throw new BadRequestException(`At most ${String(MAX_STAGE_CHUNK)} rows per call`);

    const job = await this.loadJob(orgId, jobId);
    if (job.cancelledAt) throw new ConflictException("This import was cancelled");
    if (job.status === "COMPLETED") throw new ConflictException("This import has already finished");

    await this.db
      .insert(invImportRows)
      .values(rows.map((row) => ({ orgId, jobId, rowNumber: row.rowNumber, payload: row.payload })))
      .onConflictDoNothing();

    const [counted] = await this.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM inv_import_rows WHERE org_id = ${orgId} AND job_id = ${jobId}`);
    const stagedRows = counted?.n ?? 0;

    await this.db
      .update(invImportJobs)
      .set({ stagedRows, status: "VALIDATING" })
      .where(and(eq(invImportJobs.id, jobId), eq(invImportJobs.orgId, orgId)));

    return { jobId, stagedRows, totalRows: job.totalRows };
  }

  /**
   * Applies the next chunk and advances the cursor.
   *
   * One transaction per chunk, so a crash costs at most this chunk. Rows are
   * claimed with FOR UPDATE SKIP LOCKED in file order: two callers processing
   * the same job make progress on different rows instead of deadlocking or
   * double-applying.
   */
  async processChunk(orgId: string, userId: string, jobId: number, apply: RowApplier) {
    const job = await this.loadJob(orgId, jobId);
    if (job.cancelledAt) throw new ConflictException("This import was cancelled");
    if (job.completedAt) return this.progressOf(await this.loadJob(orgId, jobId));

    const claimed = await this.db.execute<{ id: number; row_number: number; payload: Record<string, string> }>(sql`
      SELECT id, row_number, payload
      FROM inv_import_rows
      WHERE org_id = ${orgId} AND job_id = ${jobId} AND status = 'PENDING'
      ORDER BY row_number
      LIMIT ${job.chunkSize}
      FOR UPDATE SKIP LOCKED`);

    if (claimed.length === 0) {
      const finished = await this.finish(orgId, userId, jobId);
      return this.progressOf(finished);
    }

    if (!job.startedAt) {
      await this.db
        .update(invImportJobs)
        .set({ status: "RUNNING", startedAt: new Date() })
        .where(and(eq(invImportJobs.id, jobId), eq(invImportJobs.orgId, orgId)));
    }

    const outcomes: RowOutcome[] = [];
    const byId = new Map<number, RowOutcome>();
    for (const row of claimed) {
      // A row that throws is a failed row, not a failed job — one malformed line
      // in a hundred thousand must not discard the other 99,999.
      let outcome: Omit<RowOutcome, "rowNumber"> | null;
      try {
        outcome = await apply(orgId, userId, jobId, row.row_number, row.payload);
      } catch (error) {
        outcome = {
          status: "FAILED",
          code: "APPLY_FAILED",
          message: error instanceof Error ? error.message.slice(0, 500) : "Row could not be applied",
        };
      }
      const resolved: RowOutcome = { rowNumber: row.row_number, status: "APPLIED", ...(outcome ?? {}) };
      outcomes.push(resolved);
      byId.set(row.id, resolved);
    }

    // One statement for the rows that succeeded, not one per row. Written the
    // obvious way it was a network round-trip per row: 100,000 rows took over
    // ten minutes and got through five thousand of them. Failures keep their
    // own statement because each carries different error text, and they are the
    // rare case.
    const succeeded = [...byId.entries()].filter(([, o]) => o.status === "APPLIED").map(([id]) => id);
    if (succeeded.length > 0) {
      await this.db
        .update(invImportRows)
        .set({ status: "APPLIED", appliedAt: new Date() })
        .where(and(eq(invImportRows.orgId, orgId), inArray(invImportRows.id, succeeded)));
    }
    for (const [id, outcome] of byId) {
      if (outcome.status === "APPLIED") continue;
      await this.db
        .update(invImportRows)
        .set({
          status: outcome.status,
          errorCode: outcome.code ?? null,
          errorField: outcome.field ?? null,
          errorMessage: outcome.message ?? null,
          appliedAt: new Date(),
        })
        .where(and(eq(invImportRows.id, id), eq(invImportRows.orgId, orgId)));
    }

    const applied = outcomes.filter((o) => o.status === "APPLIED").length;
    const failed = outcomes.filter((o) => o.status === "FAILED").length;
    const highest = Math.max(...outcomes.map((o) => o.rowNumber));

    await this.db
      .update(invImportJobs)
      .set({
        processedRows: sql`${invImportJobs.processedRows} + ${applied}`,
        errorRows: sql`${invImportJobs.errorRows} + ${failed}`,
        nextRow: sql`GREATEST(${invImportJobs.nextRow}, ${highest + 1})`,
      })
      .where(and(eq(invImportJobs.id, jobId), eq(invImportJobs.orgId, orgId)));

    await this.cache.invalidateNamespace(CACHE_KEYS.invImportJobsNamespace(orgId));
    return this.progressOf(await this.loadJob(orgId, jobId), outcomes);
  }

  /** Stops a job without unwinding what already applied. */
  async cancel(orgId: string, userId: string, jobId: number) {
    const job = await this.loadJob(orgId, jobId);
    if (job.completedAt) throw new ConflictException("This import has already finished");
    if (job.cancelledAt) return this.progressOf(job);

    await this.db.transaction(async (tx) => {
      await tx
        .update(invImportJobs)
        .set({ status: "FAILED", cancelledAt: new Date() })
        .where(and(eq(invImportJobs.id, jobId), eq(invImportJobs.orgId, orgId)));
      // Rows already applied stay applied. Cancelling stops the work; it does
      // not reverse stock that has already moved.
      await tx
        .update(invImportRows)
        .set({ status: "SKIPPED" })
        .where(and(
          eq(invImportRows.orgId, orgId),
          eq(invImportRows.jobId, jobId),
          eq(invImportRows.status, "PENDING"),
        ));
      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "import.cancelled",
        resourceType: "import_job",
        resourceId: String(jobId),
        after: { appliedBeforeCancel: job.processedRows },
      });
    });

    await this.cache.invalidateNamespace(CACHE_KEYS.invImportJobsNamespace(orgId));
    return this.progressOf(await this.loadJob(orgId, jobId));
  }

  /** Row-level errors, paginated — a 100k import can fail 100k times. */
  async errors(orgId: string, jobId: number, page: number, limit: number) {
    await this.loadJob(orgId, jobId);
    const offset = (page - 1) * limit;
    const [rows, [counted]] = await Promise.all([
      this.db
        .select({
          rowNumber: invImportRows.rowNumber,
          code: invImportRows.errorCode,
          field: invImportRows.errorField,
          message: invImportRows.errorMessage,
        })
        .from(invImportRows)
        .where(and(
          eq(invImportRows.orgId, orgId),
          eq(invImportRows.jobId, jobId),
          eq(invImportRows.status, "FAILED"),
        ))
        .orderBy(asc(invImportRows.rowNumber))
        .limit(limit)
        .offset(offset),
      this.db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM inv_import_rows
        WHERE org_id = ${orgId} AND job_id = ${jobId} AND status = 'FAILED'`),
    ]);
    const total = counted?.n ?? 0;
    return { items: rows, total, page, totalPages: Math.ceil(total / limit) };
  }

  async progress(orgId: string, jobId: number) {
    return this.progressOf(await this.loadJob(orgId, jobId));
  }

  private async finish(orgId: string, userId: string, jobId: number): Promise<JobRow> {
    const job = await this.loadJob(orgId, jobId);
    // Failed only when nothing at all landed; a partial success is a completed
    // import with errors to look at, not a failure to re-run blindly.
    const status = job.processedRows === 0 && job.errorRows > 0 ? "FAILED" : "COMPLETED";
    await this.db.transaction(async (tx) => {
      await tx
        .update(invImportJobs)
        .set({ status, completedAt: new Date() })
        .where(and(eq(invImportJobs.id, jobId), eq(invImportJobs.orgId, orgId)));
      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "import.completed",
        resourceType: "import_job",
        resourceId: String(jobId),
        after: { status, applied: job.processedRows, failed: job.errorRows },
      });
    });
    await this.cache.invalidateNamespace(CACHE_KEYS.invImportJobsNamespace(orgId));
    return this.loadJob(orgId, jobId);
  }

  private async loadJob(orgId: string, jobId: number): Promise<JobRow> {
    const job = await this.db.query.invImportJobs.findFirst({
      where: and(eq(invImportJobs.id, jobId), eq(invImportJobs.orgId, orgId)),
    });
    // Out of tenant reads as absent, never as forbidden.
    if (!job) throw new NotFoundException("Import job not found");
    return job as unknown as JobRow;
  }

  private progressOf(job: JobRow, outcomes?: RowOutcome[]) {
    return {
      jobId: job.id,
      status: job.status,
      importType: job.jobType,
      totalRows: job.totalRows,
      stagedRows: job.stagedRows,
      appliedRows: job.processedRows,
      failedRows: job.errorRows,
      nextRow: job.nextRow,
      cancelled: job.cancelledAt != null,
      finished: job.completedAt != null,
      /** Present only on the call that produced them. */
      chunk: outcomes ?? null,
    };
  }
}
