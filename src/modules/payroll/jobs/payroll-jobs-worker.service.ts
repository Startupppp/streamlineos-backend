import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { and, eq, isNotNull, lt } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { payrollJobs } from "../../../db/schema";
import { PayrollJobsService, type PayrollJobType } from "./payroll-jobs.service";
import { GenerateService } from "../runs/generate.service";
import { PublishingService } from "../payout/publishing.service";
import { PayrollFilingsService } from "../filings/filings.service";
import { isTransientDbError } from "../../../common/db/transient-error";
import { forEachOrg, withTenant, runWithTenantContext } from "../../../common/tenant";

type ClaimedPayrollJob = typeof payrollJobs.$inferSelect;

const POLL_MS = 5_000;
const BATCH_SIZE = 5;
/**
 * Modelled on NotificationDeliveryWorker (10 min). Payroll generation for a large
 * org can take several minutes, so we use a wider window before assuming a crash.
 */
const STALE_LOCK_MS = 15 * 60 * 1_000;
const RECLAIM_INTERVAL_MS = 60_000;

/**
 * In-process durable worker for payroll jobs.
 * Claims PENDING rows, executes GENERATE / RECALCULATE / PDF_PUBLISH / FILING_EXPORT,
 * persists progress and FAILED/DEAD_LETTER states for operator retry.
 */
@Injectable()
export class PayrollJobsWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PayrollJobsWorkerService.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private transientStreak = 0;
  private lastReclaimAt = 0;

  constructor(
    private readonly jobs: PayrollJobsService,
    private readonly moduleRef: ModuleRef,
    @Inject(DRIZZLE) private readonly db: Db,
    @Optional() private readonly generate?: GenerateService,
    @Optional() private readonly publishing?: PublishingService,
    @Optional() private readonly filings?: PayrollFilingsService,
  ) {}

  onModuleInit(): void {
    // Lazy resolve to avoid circular DI hard-failures at bootstrap
    this.timer = setInterval(() => {
      void this.tick();
    }, POLL_MS);
    // Kick once shortly after boot
    setTimeout(() => void this.tick(), 2_000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Exposed for cron/manual flush and tests. */
  async flush(limit = BATCH_SIZE): Promise<{ claimed: number; completed: number; failed: number }> {
    await this.reclaimStale();

    const claimed: ClaimedPayrollJob[] = [];
    await forEachOrg(this.db, "payroll-jobs-claim", async () => {
      const remaining = limit - claimed.length;
      if (remaining <= 0) return;
      claimed.push(...(await this.jobs.claimPending(remaining)));
    });

    let completed = 0;
    let failed = 0;
    for (const job of claimed) {
      try {
        await this.inTenant(job.orgId, async () => {
          await this.jobs.setProgress(job.orgId, job.id, 10);
          const result = await this.execute(job.jobType as PayrollJobType, {
            orgId: job.orgId,
            actorId: job.createdBy ?? "system",
            resourceId: job.resourceId,
            payload: (job.payload ?? {}) as Record<string, unknown>,
          });
          await this.jobs.succeed(job.orgId, job.id, result);
        });
        completed += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Payroll job ${job.id} (${job.jobType}) failed: ${msg}`);
        try {
          await this.inTenant(job.orgId, () => this.jobs.fail(job.orgId, job.id, msg));
        } catch (markErr) {
          this.logger.error(
            `Payroll job ${job.id} could not be marked FAILED: ${
              markErr instanceof Error ? markErr.message : String(markErr)
            }`,
          );
        }
        failed += 1;
      }
    }
    return { claimed: claimed.length, completed, failed };
  }

  /**
   * Reclaim RUNNING jobs whose lock has aged past STALE_LOCK_MS, resetting them to
   * PENDING so the next flush can re-claim them. Mirrors NotificationDeliveryWorker's
   * stale-lock reclaim pattern (staleBefore = now − STALE_LOCK_MS on lockedAt).
   */
  private inTenant<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
    return withTenant(this.db, { orgId, audience: "INTERNAL" }, (tx) =>
      runWithTenantContext({ orgId, audience: "INTERNAL", tx }, fn),
    );
  }

  private async reclaimStale(): Promise<void> {
    const now = Date.now();
    if (now - this.lastReclaimAt < RECLAIM_INTERVAL_MS) return;
    this.lastReclaimAt = now;

    const staleBefore = new Date(now - STALE_LOCK_MS);
    let reclaimed = 0;

    await forEachOrg(this.db, "payroll-stale-lock-reclaim", async (tx, orgId) => {
      const rows = await tx
        .update(payrollJobs)
        .set({ status: "PENDING", startedAt: null, progress: 0 })
        .where(
          and(
            eq(payrollJobs.orgId, orgId),
            eq(payrollJobs.status, "RUNNING"),
            isNotNull(payrollJobs.startedAt),
            lt(payrollJobs.startedAt, staleBefore),
          ),
        )
        .returning({ id: payrollJobs.id });
      reclaimed += rows.length;
    });

    if (reclaimed > 0) {
      this.logger.warn(
        `Payroll stale-lock reclaim: reset ${reclaimed} RUNNING job(s) locked before ${staleBefore.toISOString()} back to PENDING`,
      );
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.flush(BATCH_SIZE);
      if (this.transientStreak > 0) {
        this.logger.log(
          `Payroll jobs worker recovered after ${this.transientStreak} transient DB connection failure(s)`,
        );
        this.transientStreak = 0;
      }
    } catch (err) {
      if (isTransientDbError(err)) {
        this.transientStreak += 1;
        if (this.transientStreak === 1) {
          this.logger.warn(
            "Payroll jobs worker: transient DB connection issue (retrying each poll; suppressing repeats until recovery)",
          );
        }
      } else {
        this.logger.error("Payroll jobs worker tick failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      this.running = false;
    }
  }

  private async resolveGenerate(): Promise<GenerateService | undefined> {
    if (this.generate) return this.generate;
    try {
      return this.moduleRef.get(GenerateService, { strict: false });
    } catch {
      return undefined;
    }
  }

  private async resolvePublishing(): Promise<PublishingService | undefined> {
    if (this.publishing) return this.publishing;
    try {
      return this.moduleRef.get(PublishingService, { strict: false });
    } catch {
      return undefined;
    }
  }

  private async resolveFilings(): Promise<PayrollFilingsService | undefined> {
    if (this.filings) return this.filings;
    try {
      return this.moduleRef.get(PayrollFilingsService, { strict: false });
    } catch {
      return undefined;
    }
  }

  private async execute(
    jobType: PayrollJobType,
    ctx: {
      orgId: string;
      actorId: string;
      resourceId: string | null;
      payload: Record<string, unknown>;
    },
  ): Promise<Record<string, unknown>> {
    const runId = ctx.resourceId ? Number(ctx.resourceId) : NaN;

    switch (jobType) {
      case "GENERATE":
      case "RECALCULATE": {
        const gen = await this.resolveGenerate();
        if (!gen) throw new Error("GenerateService unavailable");
        if (!Number.isFinite(runId)) throw new Error("runId required");
        const result = await gen.generateRun({
          orgId: ctx.orgId,
          runId,
          actorId: ctx.actorId,
          isRecalc: jobType === "RECALCULATE",
        });
        if (!result.ok) throw new Error(result.reason);
        return { ok: true, runId };
      }
      case "PDF_PUBLISH": {
        const pub = await this.resolvePublishing();
        if (!pub) throw new Error("PublishingService unavailable");
        if (!Number.isFinite(runId)) throw new Error("runId required");
        const userIds = Array.isArray(ctx.payload.userIds)
          ? (ctx.payload.userIds as string[])
          : undefined;
        const runEmployeeIds = Array.isArray(ctx.payload.runEmployeeIds)
          ? (ctx.payload.runEmployeeIds as number[])
          : undefined;
        const result = await pub.publish(ctx.orgId, runId, ctx.actorId, userIds, runEmployeeIds);
        return result as unknown as Record<string, unknown>;
      }
      case "FILING_EXPORT": {
        const filings = await this.resolveFilings();
        if (!filings) throw new Error("PayrollFilingsService unavailable");
        const filingType = String(ctx.payload.filingType ?? "PF_ECR");
        const row = await filings.prepareExport(ctx.orgId, ctx.actorId, {
          filingType,
          periodId: typeof ctx.payload.periodId === "number" ? ctx.payload.periodId : undefined,
          entityId: typeof ctx.payload.entityId === "number" ? ctx.payload.entityId : undefined,
          fiscalYear: typeof ctx.payload.fiscalYear === "string" ? ctx.payload.fiscalYear : undefined,
          payload: (ctx.payload.exportPayload as Record<string, unknown>) ?? {},
          ruleVersion: typeof ctx.payload.ruleVersion === "string" ? ctx.payload.ruleVersion : undefined,
        });
        return {
          filingId: row?.id,
          status: row?.status,
          statusLabel: row?.statusLabel ?? "Export prepared — external filing required",
        };
      }
      default:
        throw new Error(`Unknown job type: ${jobType}`);
    }
  }
}
