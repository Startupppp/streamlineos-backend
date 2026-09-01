import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, count, desc, eq, gt } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  attendance,
  assets,
  leaveBalances,
  documents,
} from "../../../db/schema";
import { hrImportJobs, hrImportRows } from "../../../db/schema/hr/import-jobs";
import { HrAuditService } from "../core/hr-audit.service";
import { HrImportCommitService } from "./hr-import-commit.service";
import { validateRows } from "./schemas/entity-row-schemas";
import type {
  CreateImportJobInput,
  ExportQueryInput,
  HrImportEntity,
  ListImportJobsInput,
} from "./dto/import-job.dto";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import {
  keysetBeforeId,
  keysetBeforeUuid,
} from "../../../common/pagination/keyset";

const IMPORT_ROW_BATCH_SIZE = 500;

@Injectable()
export class HrImportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
    private readonly commitService: HrImportCommitService,
  ) {}

  async createJob(orgId: string, actorId: string, input: CreateImportJobInput) {
    const { entity, fileName, rows } = input;
    const { validRows, errorRows, topErrors } = validateRows(entity, rows);

    const [job] = await this.db
      .insert(hrImportJobs)
      .values({
        orgId,
        entity,
        fileName,
        status: "previewed",
        totalRows: rows.length,
        validRows: validRows.length,
        errorRows: errorRows.length,
        errors: topErrors,
        createdBy: actorId,
      })
      .returning();

    if (!job) throw new BadRequestException("Failed to create import job");

    const allResults = [
      ...validRows.map((r) => ({
        jobId: job.id,
        rowNumber: r.rowNumber,
        payload: r.payload,
        status: "valid" as const,
        error: null,
      })),
      ...errorRows.map((r) => ({
        jobId: job.id,
        rowNumber: r.rowNumber,
        payload: r.payload,
        status: "error" as const,
        error: r.error,
      })),
    ];

    if (allResults.length > 0) {
      const BATCH = 500;
      for (let i = 0; i < allResults.length; i += BATCH) {
        await this.db.insert(hrImportRows).values(allResults.slice(i, i + BATCH));
      }
    }

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_import_job",
      entityId: job.id,
      action: "created",
      after: { entity, fileName, totalRows: rows.length, validRows: validRows.length, errorRows: errorRows.length },
    });

    return {
      job,
      summary: {
        total: rows.length,
        valid: validRows.length,
        errors: errorRows.length,
        topErrors,
      },
    };
  }

  async listJobs(orgId: string, input: ListImportJobsInput) {
    const { cursor, limit, entity } = input;

    const conditions = [eq(hrImportJobs.orgId, orgId)];
    if (entity) conditions.push(eq(hrImportJobs.entity, entity));
    const baseWhere = and(...conditions);
    const position = decodeCursor(cursor);
    const where = and(
      baseWhere,
      position ? keysetBeforeUuid(hrImportJobs.createdAt, hrImportJobs.id, position) : undefined,
    );

    const [data, totalResult] = await Promise.all([
      this.db
        .select()
        .from(hrImportJobs)
        .where(where)
        .orderBy(desc(hrImportJobs.createdAt), desc(hrImportJobs.id))
        .limit(limit + 1),
      this.db.select({ total: count() }).from(hrImportJobs).where(baseWhere),
    ]);

    const total = totalResult[0]?.total ?? 0;
    const page = buildCursorPage(data, limit, (job) => ({
      sortValue: job.createdAt.toISOString(),
      id: job.id,
    }));
    return {
      data: page.data,
      total,
      pagination: page.pagination,
    };
  }

  async getJob(orgId: string, jobId: string) {
    const job = await this.db
      .select()
      .from(hrImportJobs)
      .where(and(eq(hrImportJobs.id, jobId), eq(hrImportJobs.orgId, orgId)))
      .limit(1);

    if (!job[0]) throw new NotFoundException("Import job not found");

    const errorRows = await this.db
      .select()
      .from(hrImportRows)
      .where(and(eq(hrImportRows.jobId, jobId), eq(hrImportRows.status, "error")))
      .limit(50);

    return { job: job[0], errorRows };
  }

  async commitJob(orgId: string, actorId: string, jobId: string) {
    const existing = await this.db
      .select()
      .from(hrImportJobs)
      .where(and(eq(hrImportJobs.id, jobId), eq(hrImportJobs.orgId, orgId)))
      .limit(1);

    const job = existing[0];
    if (!job) throw new NotFoundException("Import job not found");
    if (job.status !== "previewed") {
      throw new BadRequestException(`Job cannot be committed in status '${job.status}'`);
    }

    await this.db.update(hrImportJobs).set({ status: "committing" }).where(eq(hrImportJobs.id, jobId));

    let committed = 0;

    await this.db.transaction(async (tx) => {
      let afterId: string | undefined;
      while (true) {
        const rows = await tx
          .select()
          .from(hrImportRows)
          .where(
            and(
              eq(hrImportRows.jobId, jobId),
              eq(hrImportRows.status, "valid"),
              afterId ? gt(hrImportRows.id, afterId) : undefined,
            ),
          )
          .orderBy(asc(hrImportRows.id))
          .limit(IMPORT_ROW_BATCH_SIZE);

        if (rows.length === 0) break;
        for (const row of rows) {
          try {
            const ref = await this.commitService.commitRow(tx, orgId, job.entity as HrImportEntity, row.payload);
            if (ref) {
              await this.commitService.markRowCommitted(tx, row.id, ref);
              committed++;
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : "Commit failed";
            await tx
              .update(hrImportRows)
              .set({ status: "error", error: message })
              .where(eq(hrImportRows.id, row.id));
          }
        }

        afterId = rows[rows.length - 1]!.id;
        if (rows.length < IMPORT_ROW_BATCH_SIZE) break;
      }

      await tx
        .update(hrImportJobs)
        .set({ status: "committed", committedAt: new Date(), validRows: committed })
        .where(eq(hrImportJobs.id, jobId));
    });

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_import_job",
      entityId: jobId,
      action: "committed",
      after: { committed },
    });

    const updated = await this.db
      .select()
      .from(hrImportJobs)
      .where(eq(hrImportJobs.id, jobId))
      .limit(1);

    return updated[0];
  }

  async rollbackJob(orgId: string, actorId: string, jobId: string) {
    const existing = await this.db
      .select()
      .from(hrImportJobs)
      .where(and(eq(hrImportJobs.id, jobId), eq(hrImportJobs.orgId, orgId)))
      .limit(1);

    const job = existing[0];
    if (!job) throw new NotFoundException("Import job not found");
    if (job.status !== "committed") {
      throw new BadRequestException(`Job cannot be rolled back in status '${job.status}'`);
    }

    await this.db.transaction(async (tx) => {
      let afterId: string | undefined;
      while (true) {
        const rows = await tx
          .select()
          .from(hrImportRows)
          .where(
            and(
              eq(hrImportRows.jobId, jobId),
              eq(hrImportRows.status, "committed"),
              afterId ? gt(hrImportRows.id, afterId) : undefined,
            ),
          )
          .orderBy(asc(hrImportRows.id))
          .limit(IMPORT_ROW_BATCH_SIZE);

        if (rows.length === 0) break;
        for (const row of rows) {
          if (row.createdRecordRef) {
            await this.commitService.rollbackRef(tx, row.createdRecordRef);
          }
        }

        afterId = rows[rows.length - 1]!.id;
        if (rows.length < IMPORT_ROW_BATCH_SIZE) break;
      }

      await tx
        .update(hrImportJobs)
        .set({ status: "rolled_back", rolledBackAt: new Date() })
        .where(eq(hrImportJobs.id, jobId));
    });

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_import_job",
      entityId: jobId,
      action: "rolled_back",
    });

    const updated = await this.db
      .select()
      .from(hrImportJobs)
      .where(eq(hrImportJobs.id, jobId))
      .limit(1);

    return updated[0];
  }

  async exportEntity(orgId: string, entity: HrImportEntity, input: ExportQueryInput) {
    if (entity === "employees") {
      throw new BadRequestException({
        code: "HR_EMPLOYEE_EXPORT_ASYNC_REQUIRED",
        message: "Employee exports must be created from the Employee Directory.",
      });
    }

    const { cursor, limit } = input;
    const position = decodeCursor(cursor);
    if (cursor !== undefined && !position) {
      throw new BadRequestException("Invalid pagination cursor");
    }

    if (entity === "attendance") {
      const rows = await this.db
        .select()
        .from(attendance)
        .where(
          and(
            eq(attendance.orgId, orgId),
            position
              ? keysetBeforeId(attendance.createdAt, attendance.id, position)
              : undefined,
          ),
        )
        .orderBy(desc(attendance.createdAt), desc(attendance.id))
        .limit(limit + 1);
      return buildCursorPage(rows, limit, (row) => ({
        sortValue: row.createdAt.toISOString(),
        id: String(row.id),
      }));
    }
    if (entity === "assets") {
      const rows = await this.db
        .select()
        .from(assets)
        .where(
          and(
            eq(assets.orgId, orgId),
            position
              ? keysetBeforeId(assets.createdAt, assets.id, position)
              : undefined,
          ),
        )
        .orderBy(desc(assets.createdAt), desc(assets.id))
        .limit(limit + 1);
      return buildCursorPage(rows, limit, (row) => ({
        sortValue: row.createdAt.toISOString(),
        id: String(row.id),
      }));
    }
    if (entity === "leave_balances") {
      const cursorId = position ? Number(position.id) : undefined;
      if (
        position &&
        (typeof cursorId !== "number" || !Number.isSafeInteger(cursorId) ||
          cursorId <= 0 ||
          position.sortValue !== position.id)
      ) {
        throw new BadRequestException("Invalid pagination cursor");
      }
      const rows = await this.db
        .select()
        .from(leaveBalances)
        .where(
          and(
            eq(leaveBalances.orgId, orgId),
            cursorId !== undefined ? gt(leaveBalances.id, cursorId) : undefined,
          ),
        )
        .orderBy(asc(leaveBalances.id))
        .limit(limit + 1);
      return buildCursorPage(rows, limit, (row) => ({
        sortValue: String(row.id),
        id: String(row.id),
      }));
    }
    if (entity === "document_metadata") {
      const rows = await this.db
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.orgId, orgId),
            position
              ? keysetBeforeId(documents.createdAt, documents.id, position)
              : undefined,
          ),
        )
        .orderBy(desc(documents.createdAt), desc(documents.id))
        .limit(limit + 1);
      return buildCursorPage(rows, limit, (row) => ({
        sortValue: row.createdAt.toISOString(),
        id: String(row.id),
      }));
    }
    return buildCursorPage([], limit, () => ({ sortValue: "", id: "" }));
  }
}
