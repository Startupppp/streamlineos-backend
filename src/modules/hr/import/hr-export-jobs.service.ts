import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { and, asc, eq, isNotNull, lt, lte } from "drizzle-orm";
import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import { hrExportJobs, type HrExportDataScope } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AuthContextFactory } from "../../../common/auth/auth-context.factory";
import { AuditService } from "../../../common/audit/audit.service";
import type { FileStreamResult } from "../../storage/storage.service";
import { StorageService } from "../../storage/storage.service";
import { AccessService } from "../../access/access.service";
import { MembershipStateService } from "../../../common/auth/membership-state.service";
import { ScopedRead } from "../../access/scoped-read";
import { resolveHrExportScope } from "./hr-export-scope";
import type { CreateEmployeeExportJobInput } from "./dto/export-job.dto";
import {
  hrExportUnavailable,
  isMissingHrExportTable,
} from "./hr-export-errors";
import type { GeneratedEmployeeExport } from "./hr-export-file.service";
import { HrExportFileService } from "./hr-export-file.service";
import {
  EPHEMERAL_TTL_MS,
  ephemeralFileKey,
  hrExportEphemeralStore,
  isEphemeralFileKey,
} from "./hr-export-ephemeral-store";
import {
  HrExportProcessingError,
  isExportScopeStillAllowed,
  type HrExportJobRow,
  type HrExportJobView,
} from "./hr-export-jobs.types";

async function unlinkQuiet(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}

@Injectable()
export class HrExportJobsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly membershipState: MembershipStateService,
    private readonly authContexts: AuthContextFactory,
    private readonly files: HrExportFileService,
  ) {}

  async create(
    user: CurrentUserContext,
    input: CreateEmployeeExportJobInput,
    requestedScope: HrExportDataScope,
    idempotencyKey: string,
  ): Promise<HrExportJobView> {
    if (requestedScope === "none") {
      throw new ForbiddenException(
        "Employee view permission is required to export employees",
      );
    }

    const requestHash = createHash("sha256")
      .update(JSON.stringify(input.filters))
      .digest("hex");
    const useObjectStorage = this.storage.isConfigured();

    try {
      const inserted = await this.db
        .insert(hrExportJobs)
        .values({
          orgId: user.orgId,
          entity: "employees",
          status: "pending",
          filters: input.filters,
          requestedScope,
          requestedBy: user.userId,
          idempotencyKey,
          requestHash,
        })
        .onConflictDoNothing({
          target: [hrExportJobs.orgId, hrExportJobs.idempotencyKey],
        })
        .returning();

      const job =
        inserted[0] ??
        (await this.findByIdempotency(user.orgId, idempotencyKey));
      if (!job)
        throw new BadRequestException("Failed to create employee export job");
      if (job.requestedBy !== user.userId || job.requestHash !== requestHash) {
        throw new UnprocessableEntityException(
          "This Idempotency-Key was already used with a different export request",
        );
      }

      await this.audit.logCritical({
        action: "hr.employee_export.requested",
        userId: user.userId,
        orgId: user.orgId,
        resourceType: "hr_export_job",
        resourceId: job.id,
        metadata: {
          entity: "employees",
          filterKeys: Object.keys(input.filters).sort(),
          requestedScope,
        },
      });

      // Object storage → async worker. Otherwise generate in-process and return completed.
      if (useObjectStorage) return this.toView(job);
      if (job.status !== "pending") return this.toView(job);
      return await this.completeLocally(job);
    } catch (error: unknown) {
      if (isMissingHrExportTable(error)) throw hrExportUnavailable();
      throw error;
    }
  }

  async getForRequester(
    orgId: string,
    requesterUserId: string,
    exportJobId: string,
  ): Promise<HrExportJobView> {
    const row = await this.findForRequester(
      orgId,
      requesterUserId,
      exportJobId,
    );
    await this.assertRequesterStillAuthorized(row);
    return this.toView(row);
  }

  async getDownload(
    orgId: string,
    requesterUserId: string,
    exportJobId: string,
  ): Promise<{ job: HrExportJobView; file: FileStreamResult }> {
    const row = await this.findForRequester(
      orgId,
      requesterUserId,
      exportJobId,
    );
    await this.assertRequesterStillAuthorized(row);
    if (
      row.status === "expired" ||
      (row.expiresAt && row.expiresAt <= new Date())
    ) {
      throw new GoneException(
        "This employee export has expired. Create a new export.",
      );
    }
    if (row.status !== "completed" || !row.fileKey) {
      throw new BadRequestException(
        "Employee export is not ready for download",
      );
    }
    if (isEphemeralFileKey(row.fileKey)) {
      const file = hrExportEphemeralStore.openStream(orgId, row.id);
      if (!file) {
        throw new GoneException(
          "This employee export has expired. Create a new export.",
        );
      }
      return { job: this.toView(row), file };
    }
    return {
      job: this.toView(row),
      file: await this.storage.getFileStream(orgId, row.fileKey),
    };
  }

  async recordDownload(
    orgId: string,
    requesterUserId: string,
    job: HrExportJobView,
  ): Promise<void> {
    await this.audit.logCriticalOutsideTransaction({
      action: "hr.employee_export.downloaded",
      userId: requesterUserId,
      orgId,
      resourceType: "hr_export_job",
      resourceId: job.id,
      metadata: { entity: job.entity, rowCount: job.rowCount },
    });
  }

  async resolveExecutionScope(job: HrExportJobRow): Promise<ScopedRead> {
    return resolveHrExportScope(
      {
        membershipState: this.membershipState,
        authContexts: this.authContexts,
        access: this.access,
      },
      job,
    );
  }

  async claimForOrg(orgId: string): Promise<HrExportJobRow | null> {
    const pending = await this.db
      .select()
      .from(hrExportJobs)
      .where(
        and(eq(hrExportJobs.orgId, orgId), eq(hrExportJobs.status, "pending")),
      )
      .orderBy(asc(hrExportJobs.createdAt))
      .limit(1);
    const candidate = pending[0];
    if (!candidate) return null;

    const claimed = await this.db
      .update(hrExportJobs)
      .set({
        status: "running",
        attempt: candidate.attempt + 1,
        lockedAt: new Date(),
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(hrExportJobs.id, candidate.id),
          eq(hrExportJobs.status, "pending"),
        ),
      )
      .returning();
    return claimed[0] ?? null;
  }

  async updateProgress(
    exportJobId: string,
    processedRows: number,
  ): Promise<void> {
    await this.db
      .update(hrExportJobs)
      .set({ processedRows, lockedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(hrExportJobs.id, exportJobId),
          eq(hrExportJobs.status, "running"),
        ),
      );
  }

  async restrictExecutionScope(
    exportJobId: string,
    executionScope: HrExportDataScope,
  ): Promise<void> {
    await this.db
      .update(hrExportJobs)
      .set({ requestedScope: executionScope, updatedAt: new Date() })
      .where(
        and(
          eq(hrExportJobs.id, exportJobId),
          eq(hrExportJobs.status, "running"),
        ),
      );
  }

  async complete(
    exportJobId: string,
    result: GeneratedEmployeeExport,
  ): Promise<boolean> {
    const completedAt = new Date();
    const ttlMs = isEphemeralFileKey(result.fileKey)
      ? EPHEMERAL_TTL_MS
      : 24 * 60 * 60 * 1000;
    const updated = await this.db
      .update(hrExportJobs)
      .set({
        status: "completed",
        fileKey: result.fileKey,
        fileName: result.fileName,
        mimeType: result.mimeType,
        fileSizeBytes: result.fileSizeBytes,
        processedRows: result.rowCount,
        rowCount: result.rowCount,
        completedAt,
        expiresAt: new Date(completedAt.getTime() + ttlMs),
        lockedAt: null,
        updatedAt: completedAt,
      })
      .where(
        and(
          eq(hrExportJobs.id, exportJobId),
          eq(hrExportJobs.status, "running"),
        ),
      )
      .returning({ id: hrExportJobs.id });
    return updated.length === 1;
  }

  async fail(
    job: HrExportJobRow,
    code: string,
    message: string,
  ): Promise<void> {
    const retry =
      job.attempt < job.maxAttempts && code !== "EXPORT_ACCESS_REVOKED";
    await this.db
      .update(hrExportJobs)
      .set({
        status: retry ? "pending" : "failed",
        errorCode: code,
        errorMessage: message,
        lockedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(eq(hrExportJobs.id, job.id), eq(hrExportJobs.status, "running")),
      );
  }

  async reclaimStaleForOrg(orgId: string, staleBefore: Date): Promise<void> {
    await this.db
      .update(hrExportJobs)
      .set({ status: "pending", lockedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(hrExportJobs.orgId, orgId),
          eq(hrExportJobs.status, "running"),
          isNotNull(hrExportJobs.lockedAt),
          lt(hrExportJobs.lockedAt, staleBefore),
        ),
      );
  }

  listExpiredForOrg(orgId: string, now: Date): Promise<HrExportJobRow[]> {
    return this.db
      .select()
      .from(hrExportJobs)
      .where(
        and(
          eq(hrExportJobs.orgId, orgId),
          eq(hrExportJobs.status, "completed"),
          isNotNull(hrExportJobs.expiresAt),
          lte(hrExportJobs.expiresAt, now),
        ),
      )
      .orderBy(asc(hrExportJobs.expiresAt))
      .limit(10);
  }

  async markExpired(exportJobId: string): Promise<void> {
    await this.db
      .update(hrExportJobs)
      .set({
        status: "expired",
        fileKey: null,
        fileSizeBytes: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(hrExportJobs.id, exportJobId),
          eq(hrExportJobs.status, "completed"),
        ),
      );
  }

  /**
   * When private object storage is unset, generate the CSV in-process, park it
   * in the ephemeral store, and return a completed job the FE can download now.
   */
  private async completeLocally(job: HrExportJobRow): Promise<HrExportJobView> {
    const claimed = await this.db
      .update(hrExportJobs)
      .set({
        status: "running",
        attempt: job.attempt + 1,
        lockedAt: new Date(),
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(
        and(eq(hrExportJobs.id, job.id), eq(hrExportJobs.status, "pending")),
      )
      .returning();
    const running = claimed[0];
    if (!running) {
      const current = await this.findById(job.orgId, job.id);
      if (!current)
        throw new BadRequestException("Failed to create employee export job");
      return this.toView(current);
    }

    let orphanTempPath: string | null = null;
    try {
      const scope = await this.resolveExecutionScope(running);
      const rawScope = scope.rawScope(
        "persists and audits the resolved execution scope for a synchronous local export",
      );
      await this.restrictExecutionScope(running.id, rawScope);

      const local = await this.files.generateLocal(
        {
          exportJobId: running.id,
          read: scope,
          filters: running.filters,
          createdAt: running.createdAt,
        },
        (processedRows) => this.updateProgress(running.id, processedRows),
      );
      orphanTempPath = local.tempPath;

      const result: GeneratedEmployeeExport = {
        fileKey: ephemeralFileKey(running.id),
        fileName: local.fileName,
        mimeType: local.mimeType,
        fileSizeBytes: local.fileSizeBytes,
        rowCount: local.rowCount,
      };

      const completed = await this.complete(running.id, result);
      if (!completed) {
        await unlinkQuiet(local.tempPath);
        orphanTempPath = null;
        const current = await this.findById(running.orgId, running.id);
        if (!current)
          throw new BadRequestException("Failed to create employee export job");
        return this.toView(current);
      }

      hrExportEphemeralStore.put(running.orgId, running.id, {
        tempPath: local.tempPath,
        mimeType: local.mimeType,
        fileSizeBytes: local.fileSizeBytes,
      });
      orphanTempPath = null;

      await this.audit.logCritical({
        action: "hr.employee_export.completed",
        userId: running.requestedBy,
        orgId: running.orgId,
        resourceType: "hr_export_job",
        resourceId: running.id,
        metadata: {
          entity: "employees",
          rowCount: result.rowCount,
          scope: rawScope,
          storage: "ephemeral",
        },
      });

      const done = await this.findById(running.orgId, running.id);
      if (!done)
        throw new BadRequestException("Failed to create employee export job");
      return this.toView(done);
    } catch (error: unknown) {
      if (orphanTempPath) await unlinkQuiet(orphanTempPath);
      if (error instanceof HrExportProcessingError) {
        await this.fail(running, error.code, error.message);
        throw new ForbiddenException(error.message);
      }
      await this.fail(
        running,
        "EXPORT_GENERATION_FAILED",
        "Employee export generation failed. Try again.",
      );
      throw error;
    }
  }

  private async findById(
    orgId: string,
    exportJobId: string,
  ): Promise<HrExportJobRow | undefined> {
    const rows = await this.db
      .select()
      .from(hrExportJobs)
      .where(
        and(eq(hrExportJobs.orgId, orgId), eq(hrExportJobs.id, exportJobId)),
      )
      .limit(1);
    return rows[0];
  }

  private async findByIdempotency(
    orgId: string,
    idempotencyKey: string,
  ): Promise<HrExportJobRow | undefined> {
    const rows = await this.db
      .select()
      .from(hrExportJobs)
      .where(
        and(
          eq(hrExportJobs.orgId, orgId),
          eq(hrExportJobs.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return rows[0];
  }

  private async findForRequester(
    orgId: string,
    requesterUserId: string,
    exportJobId: string,
  ): Promise<HrExportJobRow> {
    try {
      const rows = await this.db
        .select()
        .from(hrExportJobs)
        .where(
          and(
            eq(hrExportJobs.orgId, orgId),
            eq(hrExportJobs.requestedBy, requesterUserId),
            eq(hrExportJobs.id, exportJobId),
          ),
        )
        .limit(1);
      if (!rows[0])
        throw new NotFoundException("Employee export job not found");
      return rows[0];
    } catch (error: unknown) {
      if (isMissingHrExportTable(error)) throw hrExportUnavailable();
      throw error;
    }
  }

  private async assertRequesterStillAuthorized(
    row: HrExportJobRow,
  ): Promise<void> {
    try {
      const currentScope = await this.resolveExecutionScope(row);
      if (
        row.status === "completed" &&
        !isExportScopeStillAllowed(
          row.requestedScope,
          currentScope.rawScope(
            "compares the resolved export scope rank against the persisted requested scope",
          ),
        )
      ) {
        throw new ForbiddenException(
          "Your employee access scope changed. Create a new export for your current scope.",
        );
      }
    } catch (error: unknown) {
      if (error instanceof HrExportProcessingError) {
        throw new ForbiddenException(error.message);
      }
      throw error;
    }
  }

  private toView(row: HrExportJobRow): HrExportJobView {
    return {
      id: row.id,
      entity: row.entity,
      status: row.status,
      processedRows: row.processedRows,
      rowCount: row.rowCount,
      fileName: row.fileName,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      completedAt: row.completedAt,
      expiresAt: row.expiresAt,
    };
  }
}
