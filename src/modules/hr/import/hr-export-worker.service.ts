import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import {
  forEachOrg,
  runWithTenantContext,
  withTenant,
} from "../../../common/tenant";
import { StorageService } from "../../storage/storage.service";
import { HrExportFileService } from "./hr-export-file.service";
import {
  HrExportJobsService,
  HrExportProcessingError,
  isHrExportWorkerEnabled,
  type HrExportJobRow,
} from "./hr-export-jobs.service";

const POLL_INTERVAL_MS = 30_000;
const STALE_JOB_MS = 15 * 60_000;
const MAINTENANCE_INTERVAL_MS = 5 * 60_000;
const CLAIM_LIMIT = 2;

@Injectable()
export class HrExportWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HrExportWorkerService.name);
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private kickoffTimer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private lastMaintenanceAt = 0;
  private storageWarningLogged = false;
  private claimAfterOrgId: string | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly jobs: HrExportJobsService,
    private readonly files: HrExportFileService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    if (!isHrExportWorkerEnabled()) return;
    this.pollTimer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    this.kickoffTimer = setTimeout(() => void this.tick(), 2_000);
    this.pollTimer.unref();
    this.kickoffTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.kickoffTimer) clearTimeout(this.kickoffTimer);
  }

  wake(): void {
    if (!isHrExportWorkerEnabled()) return;
    const wakeTimer = setTimeout(() => void this.tick(), 0);
    wakeTimer.unref();
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    if (!this.storage.isConfigured()) {
      if (!this.storageWarningLogged) {
        this.logger.warn("HR export worker is enabled but private object storage is unavailable");
        this.storageWarningLogged = true;
      }
      return;
    }

    this.storageWarningLogged = false;
    this.running = true;
    try {
      const claimed: HrExportJobRow[] = [];
      const expired: HrExportJobRow[] = [];
      const now = new Date();
      const runMaintenance = Date.now() - this.lastMaintenanceAt >= MAINTENANCE_INTERVAL_MS;
      const startingClaimCursor = this.claimAfterOrgId;
      let claimCursorReached = startingClaimCursor === null;

      await forEachOrg(this.db, "hr-export-worker", async (_tenantTx, orgId) => {
        if (runMaintenance) {
          await this.jobs.reclaimStaleForOrg(
            orgId,
            new Date(now.getTime() - STALE_JOB_MS),
          );
          expired.push(...(await this.jobs.listExpiredForOrg(orgId, now)));
        }
        if (!claimCursorReached) {
          if (orgId === startingClaimCursor) claimCursorReached = true;
          return;
        }
        if (claimed.length >= CLAIM_LIMIT) return;
        const job = await this.jobs.claimForOrg(orgId);
        if (job) {
          claimed.push(job);
          this.claimAfterOrgId = orgId;
        }
      });

      if (runMaintenance) this.lastMaintenanceAt = Date.now();
      if (claimed.length === 0 && startingClaimCursor !== null) {
        this.claimAfterOrgId = null;
      }
      for (const job of expired) await this.expireArtifact(job);
      for (const job of claimed) await this.process(job);
    } catch (error: unknown) {
      this.logger.error("HR export worker tick failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }

  private async process(job: HrExportJobRow): Promise<void> {
    let generatedFileKey: string | null = null;
    try {
      const scope = await this.jobs.resolveExecutionScope(job);
      const rawScope = scope.rawScope("persists and audits the resolved execution scope, not a row predicate");
      await this.inTenant(job.orgId, () =>
        this.jobs.restrictExecutionScope(job.id, rawScope),
      );
      const generated = await this.files.generate(
        {
          exportJobId: job.id,
          read: scope,
          filters: job.filters,
          createdAt: job.createdAt,
        },
        (processedRows) =>
          this.inTenant(job.orgId, () => this.jobs.updateProgress(job.id, processedRows)),
      );
      generatedFileKey = generated.fileKey;

      const completed = await this.inTenant(job.orgId, async () => {
        const updated = await this.jobs.complete(job.id, generated);
        if (!updated) return false;
        await this.audit.logCritical({
          action: "hr.employee_export.completed",
          userId: job.requestedBy,
          orgId: job.orgId,
          resourceType: "hr_export_job",
          resourceId: job.id,
          metadata: { entity: "employees", rowCount: generated.rowCount, scope: rawScope },
        });
        return true;
      });
      if (!completed) await this.files.delete(job.orgId, generated.fileKey);
    } catch (error: unknown) {
      if (generatedFileKey) await this.files.delete(job.orgId, generatedFileKey).catch(() => undefined);
      const processingError =
        error instanceof HrExportProcessingError
          ? error
          : new HrExportProcessingError(
              "EXPORT_GENERATION_FAILED",
              "Employee export generation failed. The job will retry automatically when possible.",
            );
      this.logger.error(`HR export job ${job.id} failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
      await this.inTenant(job.orgId, async () => {
        await this.jobs.fail(job, processingError.code, processingError.message);
        await this.audit.logCritical({
          action: "hr.employee_export.failed",
          userId: job.requestedBy,
          orgId: job.orgId,
          resourceType: "hr_export_job",
          resourceId: job.id,
          metadata: { entity: "employees", errorCode: processingError.code },
        });
      });
    }
  }

  private async expireArtifact(job: HrExportJobRow): Promise<void> {
    if (!job.fileKey) return;
    try {
      await this.files.delete(job.orgId, job.fileKey);
      await this.inTenant(job.orgId, () => this.jobs.markExpired(job.id));
    } catch (error: unknown) {
      this.logger.error(`Could not expire HR export job ${job.id}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private inTenant<T>(orgId: string, operation: () => Promise<T>): Promise<T> {
    return withTenant(this.db, { orgId, audience: "INTERNAL" }, (tenantTx) =>
      runWithTenantContext({ orgId, audience: "INTERNAL", tx: tenantTx }, operation),
    );
  }
}
