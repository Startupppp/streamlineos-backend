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
import {
  hrExportJobs,
  organizationMembers,
  type HrExportDataScope,
  type HrExportJobStatus,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AuditService } from "../../../common/audit/audit.service";
import { withTenant } from "../../../common/tenant";
import type { FileStreamResult } from "../../storage/storage.service";
import { StorageService } from "../../storage/storage.service";
import { AccessService } from "../../access/access.service";
import type { DataScope } from "../../access/access.types";
import { authorize } from "../../access/authorize";
import type { CreateEmployeeExportJobInput } from "./dto/export-job.dto";
import { hrExportUnavailable, isMissingHrExportTable } from "./hr-export-errors";
import type { GeneratedEmployeeExport } from "./hr-export-file.service";

export type HrExportJobRow = typeof hrExportJobs.$inferSelect;

export interface HrExportJobView {
  id: string;
  entity: "employees";
  status: HrExportJobStatus;
  processedRows: number;
  rowCount: number | null;
  fileName: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  expiresAt: Date | null;
}

export class HrExportProcessingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HrExportProcessingError";
  }
}

const SCOPE_RANK: Record<DataScope, number> = {
  none: 0,
  own: 1,
  team: 2,
  all: 3,
};

export function narrowestExportScope(
  requested: HrExportDataScope,
  current: DataScope,
): DataScope {
  return SCOPE_RANK[requested] <= SCOPE_RANK[current] ? requested : current;
}

export function isExportScopeStillAllowed(
  exportedScope: HrExportDataScope,
  currentScope: DataScope,
): boolean {
  return SCOPE_RANK[exportedScope] <= SCOPE_RANK[currentScope];
}

export function isHrExportWorkerEnabled(): boolean {
  return process.env.HR_EXPORT_WORKER_ENABLED === "true";
}

@Injectable()
export class HrExportJobsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  async create(
    user: CurrentUserContext,
    input: CreateEmployeeExportJobInput,
    requestedScope: DataScope,
    idempotencyKey: string,
  ): Promise<HrExportJobView> {
    if (requestedScope === "none") {
      throw new ForbiddenException("Employee view permission is required to export employees");
    }
    if (!isHrExportWorkerEnabled() || !this.storage.isConfigured()) {
      throw hrExportUnavailable();
    }

    const requestHash = createHash("sha256")
      .update(JSON.stringify(input.filters))
      .digest("hex");

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

      const job = inserted[0] ?? (await this.findByIdempotency(user.orgId, idempotencyKey));
      if (!job) throw new BadRequestException("Failed to create employee export job");
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
      return this.toView(job);
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
    const row = await this.findForRequester(orgId, requesterUserId, exportJobId);
    await this.assertRequesterStillAuthorized(row);
    return this.toView(row);
  }

  async getDownload(
    orgId: string,
    requesterUserId: string,
    exportJobId: string,
  ): Promise<{ job: HrExportJobView; file: FileStreamResult }> {
    const row = await this.findForRequester(orgId, requesterUserId, exportJobId);
    await this.assertRequesterStillAuthorized(row);
    if (row.status === "expired" || (row.expiresAt && row.expiresAt <= new Date())) {
      throw new GoneException("This employee export has expired. Create a new export.");
    }
    if (row.status !== "completed" || !row.fileKey) {
      throw new BadRequestException("Employee export is not ready for download");
    }
    return {
      job: this.toView(row),
      file: await this.storage.getFileStream(row.fileKey),
    };
  }

  async recordDownload(
    orgId: string,
    requesterUserId: string,
    job: HrExportJobView,
  ): Promise<void> {
    await this.audit.logCritical({
      action: "hr.employee_export.downloaded",
      userId: requesterUserId,
      orgId,
      resourceType: "hr_export_job",
      resourceId: job.id,
      metadata: { entity: job.entity, rowCount: job.rowCount },
    });
  }

  async resolveExecutionScope(job: HrExportJobRow): Promise<DataScope> {
    const member = await withTenant(
      this.db,
      { orgId: job.orgId, audience: "INTERNAL" },
      async (tx) => {
        const rows = await tx
          .select({
            role: organizationMembers.role,
            isOwner: organizationMembers.isOwner,
            status: organizationMembers.status,
          })
          .from(organizationMembers)
          .where(
            and(
              eq(organizationMembers.orgId, job.orgId),
              eq(organizationMembers.userId, job.requestedBy),
            ),
          )
          .limit(1);
        return rows[0];
      },
    );
    if (!member || member.status !== "ACTIVE") {
      throw new HrExportProcessingError(
        "EXPORT_ACCESS_REVOKED",
        "Your access changed before the export ran. Create a new export after access is restored.",
      );
    }

    const context: CurrentUserContext = {
      userId: job.requestedBy,
      orgId: job.orgId,
      role: member.role,
      permissions: [],
      isOrgOwner: member.isOwner,
      sessionId: "hr-export-worker",
      tokenScopes: null,
    };
    const [exportAccess, employeeAccess] = await Promise.all([
      authorize(this.access, context, "hr:export:manage"),
      authorize(this.access, context, "hr:employees:view"),
    ]);
    if (!exportAccess.allow || !employeeAccess.allow) {
      throw new HrExportProcessingError(
        "EXPORT_ACCESS_REVOKED",
        "Your access changed before the export ran. Create a new export after access is restored.",
      );
    }

    const scope = narrowestExportScope(job.requestedScope, employeeAccess.scope);
    if (scope === "none") {
      throw new HrExportProcessingError(
        "EXPORT_SCOPE_EMPTY",
        "No employee records are available in your current access scope.",
      );
    }
    return scope;
  }

  async claimForOrg(orgId: string): Promise<HrExportJobRow | null> {
    const pending = await this.db
      .select()
      .from(hrExportJobs)
      .where(and(eq(hrExportJobs.orgId, orgId), eq(hrExportJobs.status, "pending")))
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
      .where(and(eq(hrExportJobs.id, candidate.id), eq(hrExportJobs.status, "pending")))
      .returning();
    return claimed[0] ?? null;
  }

  async updateProgress(exportJobId: string, processedRows: number): Promise<void> {
    await this.db
      .update(hrExportJobs)
      .set({ processedRows, lockedAt: new Date(), updatedAt: new Date() })
      .where(
        and(eq(hrExportJobs.id, exportJobId), eq(hrExportJobs.status, "running")),
      );
  }

  async restrictExecutionScope(
    exportJobId: string,
    executionScope: DataScope,
  ): Promise<void> {
    await this.db
      .update(hrExportJobs)
      .set({ requestedScope: executionScope, updatedAt: new Date() })
      .where(
        and(eq(hrExportJobs.id, exportJobId), eq(hrExportJobs.status, "running")),
      );
  }

  async complete(
    exportJobId: string,
    result: GeneratedEmployeeExport,
  ): Promise<boolean> {
    const completedAt = new Date();
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
        expiresAt: new Date(completedAt.getTime() + 24 * 60 * 60 * 1000),
        lockedAt: null,
        updatedAt: completedAt,
      })
      .where(
        and(eq(hrExportJobs.id, exportJobId), eq(hrExportJobs.status, "running")),
      )
      .returning({ id: hrExportJobs.id });
    return updated.length === 1;
  }

  async fail(job: HrExportJobRow, code: string, message: string): Promise<void> {
    const retry = job.attempt < job.maxAttempts && code !== "EXPORT_ACCESS_REVOKED";
    await this.db
      .update(hrExportJobs)
      .set({
        status: retry ? "pending" : "failed",
        errorCode: code,
        errorMessage: message,
        lockedAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(hrExportJobs.id, job.id), eq(hrExportJobs.status, "running")));
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
        and(eq(hrExportJobs.id, exportJobId), eq(hrExportJobs.status, "completed")),
      );
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
      if (!rows[0]) throw new NotFoundException("Employee export job not found");
      return rows[0];
    } catch (error: unknown) {
      if (isMissingHrExportTable(error)) throw hrExportUnavailable();
      throw error;
    }
  }

  private async assertRequesterStillAuthorized(row: HrExportJobRow): Promise<void> {
    try {
      const currentScope = await this.resolveExecutionScope(row);
      if (
        row.status === "completed" &&
        !isExportScopeStillAllowed(row.requestedScope, currentScope)
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
