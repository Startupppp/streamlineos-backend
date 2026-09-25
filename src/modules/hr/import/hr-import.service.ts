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
  organizations,
} from "../../../db/schema";
import { hrImportJobs, hrImportRows } from "../../../db/schema/hr/import-jobs";
import { HrAuditService } from "../core/hr-audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { withMembershipMutations } from "../../../common/org/membership-mutations";
import { HrImportCommitService, type CommitOutcome } from "./hr-import-commit.service";
import { DEFAULT_IMPORT_TIME_ZONE, validateRows } from "./schemas/entity-row-schemas";
import { resolveRowReferences, stripResolvedKeys } from "./hr-import-preflight";
import { importCommitOrder, normaliseEmployeeImportRows, readImportRowsInOrder, resolveImportFallbacks } from "./hr-import-employee-managers";
import { ReportingManagerFallbackResolver } from "../../directory/reporting-manager-fallback.resolver";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { OrgHierarchyCacheService } from "../../../common/cache/org-hierarchy-cache.service";
import { invalidateReportingReads } from "../directory/reporting-lines.service";
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

/** Thrown when the committed buckets do not add up to what the preview promised. */
export class ImportAccountingError extends Error {}

@Injectable()
export class HrImportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
    private readonly commitService: HrImportCommitService,
    private readonly cache: CacheService,
    private readonly fallback: ReportingManagerFallbackResolver,
    private readonly hierarchyCache: OrgHierarchyCacheService,
  ) {}

  /**
   * The organisation's own calendar. Every date question an import asks — most
   * visibly "is this attendance row in the future?" — is asked in this zone, not
   * the server's and not a hardcoded one (V-012b).
   */
  private async orgTimeZone(orgId: string): Promise<string> {
    const [org] = await this.db
      .select({ timezone: organizations.timezone })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    return org?.timezone || DEFAULT_IMPORT_TIME_ZONE;
  }

  async createJob(orgId: string, actorId: string, input: CreateImportJobInput, actor?: CurrentUserContext) {
    const { entity, fileName } = input;
    const stripped = input.rows.map(stripResolvedKeys);
    const normalised = entity === "employees" ? normaliseEmployeeImportRows(stripped) : { rows: stripped, legacyHeaderRows: 0 };
    const rows = normalised.rows;
    const timeZone = await this.orgTimeZone(orgId);
    const { validRows: schemaValid, errorRows: schemaErrors } = validateRows(
      entity,
      rows,
      timeZone,
    );

    // The preview used to be database-blind, so a row naming a leave type, a
    // department, a manager or an employee that does not exist was reported
    // VALID and only failed at commit — the operator was shown "3 valid, 1
    // error" about a file that was about to write one row (V-010e, V-011c/e,
    // V-012c). One batched resolution pass per distinct reference per file now
    // runs here, before `hr_import_rows` is written, and stores the resolved ids
    // on the payload so the commit does not read them again.
    const preflight = await resolveRowReferences(this.db, orgId, entity, schemaValid);
    const actorRef = actor ?? { orgId, userId: actorId, isOrgOwner: false };
    const { valid: validRows, errors: fallbackErrors } = await resolveImportFallbacks(this.fallback, actorRef, entity, preflight.valid);
    const errorRows = [...schemaErrors, ...preflight.errors, ...fallbackErrors].sort(
      (a, b) => a.rowNumber - b.rowNumber,
    );
    const topErrors = errorRows
      .slice(0, 100)
      .map((row) => ({ row: row.rowNumber, message: row.error ?? "Invalid row" }));

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
        orgId,
        jobId: job.id,
        rowNumber: r.rowNumber,
        payload: r.payload,
        status: "valid" as const,
        error: null,
      })),
      ...errorRows.map((r) => ({
        orgId,
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
      after: { entity, fileName, totalRows: rows.length, validRows: validRows.length, errorRows: errorRows.length,
        ...(normalised.legacyHeaderRows > 0 ? { legacyManagerHeader: true, legacyManagerHeaderRows: normalised.legacyHeaderRows } : {}) },
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

  async commitJob(orgId: string, actorId: string, jobId: string, actor?: CurrentUserContext) {
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

    // Counted by what the row actually did, not by "the loop reached the end".
    // `validRows` used to be overwritten with a bare committed count, so a job
    // that wrote nothing still reported a number and the UI still said
    // "Committed" — which is how HRMS-E2E-003/004/005 could each report success
    // over an empty table.
    const outcomes: Record<CommitOutcome, number> = { created: 0, updated: 0, unchanged: 0 };
    let failed = 0;
    let committed = 0;
    // What the preview promised, read before the commit overwrites it. This is
    // the only number the accounting check below can be compared against: the
    // old check compared the buckets to `committed`, which the same `if (ref)`
    // block incremented, so it reduced to `x === x` and could never fire.
    const previewedValid = job.validRows;
    const previewedErrors = job.errorRows;
    const timeZone = await this.orgTimeZone(orgId);

    // The employees entity admits people to the organisation, so its writes go
    // through the one owner of organization_members writes. The wrapper drains
    // the permission-version and membership-cache invalidations after the
    // transaction resolves — draining inside it would publish a membership the
    // commit could still roll back.
    try {
      await withMembershipMutations(this.cache, (membership) =>
      this.db.transaction(async (tx) => {
      const ctx = { orgId, actorId, membership, timeZone, actor: actor ?? { orgId, userId: actorId, isOrgOwner: false } };
      const order = await importCommitOrder(tx, jobId, job.entity);
      for (let start = 0; start < order.length; start += IMPORT_ROW_BATCH_SIZE) {
        const rows = await readImportRowsInOrder(tx, jobId, order.slice(start, start + IMPORT_ROW_BATCH_SIZE));
        for (const row of rows) {
          try {
            // Each row commits inside its own savepoint (Drizzle emits
            // SAVEPOINT / ROLLBACK TO SAVEPOINT for a nested transaction).
            // Without it, a row that fails at the SQL level leaves the whole
            // job transaction aborted (SQLSTATE 25P02) and the catch below —
            // which runs on that same transaction — throws instead of
            // recording the error, taking the entire import down with it.
            // The savepoint also keeps a row atomic: if markRowCommitted
            // fails, the work commitRow just did is rolled back with it.
            const ref = await tx.transaction(async (rowTx) => {
              const rowRef = await this.commitService.commitRow(
                rowTx,
                ctx,
                job.entity,
                row.payload,
              );
              await this.commitService.markRowCommitted(rowTx, row.id, rowRef);
              return rowRef;
            });
            // A commit that returns nothing is a row that wrote nothing. It used
            // to fall through `if (ref)` into no bucket at all, keep
            // `status='valid'`, and leave the job reporting a committed count
            // over it. Now it is a row error with a message an operator can act on.
            if (!ref || !(ref.outcome in outcomes))
              throw new Error(
                "The importer wrote nothing for this row and reported no outcome.",
              );
            committed++;
            outcomes[ref.outcome] += 1;
          } catch (err) {
            const message = err instanceof Error ? err.message : "Commit failed";
            failed++;
            await tx
              .update(hrImportRows)
              .set({ status: "error", error: message })
              .where(eq(hrImportRows.id, row.id));
          }
        }

      }

      // The invariant the tickets asked for: every row the PREVIEW called valid
      // ends up in exactly one bucket. Compared against `job.validRows` this can
      // actually fail — which is the point. The hazard is a row that wrote
      // nothing: it landed in no bucket, kept `status='valid'` forever, and the
      // job still reported a committed count over it.
      const accountedFor = outcomes.created + outcomes.updated + outcomes.unchanged + failed;
      if (accountedFor !== previewedValid)
        throw new ImportAccountingError(
          `Import accounting did not reconcile: the preview found ${previewedValid} valid row(s) ` +
            `but only ${accountedFor} were written, failed or skipped. No row is reported as committed.`,
        );

      await tx
        .update(hrImportJobs)
        .set({
          // A job that wrote nothing is a failure, not a commit. Reporting
          // "Committed" over zero writes is the defect QA filed three times.
          status: committed === 0 && failed > 0 ? "failed" : "committed",
          committedAt: new Date(),
          validRows: committed,
          // The preview's own validation errors used to be discarded here, so a
          // five-row file with three bad rows recorded `errorRows: 0` and the
          // server's counters no longer added up to `totalRows`.
          errorRows: previewedErrors + failed,
          createdRows: outcomes.created,
          updatedRows: outcomes.updated,
          unchangedRows: outcomes.unchanged,
        })
        .where(eq(hrImportJobs.id, jobId));
      }),
      );
    } catch (err) {
      // The transaction has rolled back, so nothing the job wrote survives. The
      // job row must not be left in `committing` claiming a commit that did not
      // happen — mark it failed on a fresh connection and let the error out.
      await this.db
        .update(hrImportJobs)
        .set({
          status: "failed",
          errors: [
            {
              row: 0,
              message: err instanceof Error ? err.message : "Import commit failed",
            },
          ],
        })
        .where(and(eq(hrImportJobs.id, jobId), eq(hrImportJobs.orgId, orgId)));
      throw err instanceof ImportAccountingError
        ? new BadRequestException(err.message)
        : err;
    }

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_import_job",
      entityId: jobId,
      action: "committed",
      after: { committed },
    });
    if (job.entity === "employees" && committed > 0)
      await invalidateReportingReads(this.hierarchyCache, this.cache, orgId);

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
          const ref = row.createdRecordRef;
          if (!ref) continue;
          // Only undo what this job created. Now that a commit can update a
          // record the operator already had — that is what makes a re-import
          // idempotent — deleting by id would let a rollback destroy rows the
          // import merely touched. Rows written before outcomes existed carry no
          // `outcome` and were all inserts, so they roll back as before.
          const outcome = ref.outcome ?? "created";
          if (outcome !== "created") continue;
          await this.commitService.rollbackRef(tx, {
            table: ref.table,
            id: Number(ref.id),
            outcome,
          });
        }

        afterId = rows[rows.length - 1].id;
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
