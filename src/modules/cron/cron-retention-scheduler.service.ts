import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Redis } from "@upstash/redis";
import { REDIS } from "../../common/cache/cache.service";
import { logger } from "../../common/logger/logger.service";
import { PROCESS_CELL_ID } from "../../common/cell-resources/cell-id";
import { CronLeaseService, HEARTBEAT_KEY_PREFIX } from "./cron-lease.service";
import { RETENTION_JOBS, type RetentionJobDeclaration } from "./retention-schedule";
import { CronHrRetentionService } from "./cron-hr-retention.service";
import { CronHelpdeskRetentionService } from "./cron-helpdesk-retention.service";
import { CronMailRetentionService } from "./cron-mail-retention.service";
import { CronAnnouncementsRetentionService } from "./cron-announcements-retention.service";
import { CronAiUsageRetentionService } from "./cron-ai-usage-retention.service";
import { CronNotificationRetentionService } from "./cron-notification-retention.service";
import { CronNotificationOutboxRetentionService } from "./cron-notification-outbox-retention.service";
import { CronOutboxRetentionService } from "./cron-outbox-retention.service";
import { CronKbChatRetentionService } from "./cron-kb-chat-retention.service";
import { CronKbChunkRetentionService } from "./cron-kb-chunk-retention.service";
import { CronBuildRetentionService } from "./cron-build-retention.service";
import { CronGdprExportRetentionService } from "./cron-gdpr-export-retention.service";
import { NotificationRetentionService } from "../notifications/notification-retention.service";
import { CronBillingService } from "./cron-billing.service";

const DEFAULT_TICK_MS = 10 * 60_000;
/** Spreads the first tick so a fleet restarting together does not converge on one instant. */
const MAX_BOOT_JITTER_MS = 60_000;

export interface RetentionTickOutcome {
  considered: number;
  ran: string[];
  skipped: string[];
  failed: string[];
}

function tickIntervalMs(): number {
  const raw = process.env.RETENTION_SCHEDULER_TICK_MS;
  if (raw === undefined) return DEFAULT_TICK_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TICK_MS;
}

/**
 * Runs every declared sweep in process, on its declared cadence.
 *
 * Until this existed the sweeps were reachable only as `POST /cron/<job>` behind
 * `CRON_SECRET`, and no scheduler in either repository ever sent that request: the
 * README's schedule table named five jobs and not one of them was a retention sweep.
 * A drain nobody triggers is indistinguishable from a drain that works.
 *
 * Due-ness is read from the same `cron:heartbeat:<jobKey>` key `CronLeaseService`
 * already writes, so an external scheduler and this one compose rather than compete:
 * an external POST refreshes the heartbeat and this scheduler stands down for the rest
 * of the interval. Redis being absent falls back to an in-process last-run map, which
 * is weaker across restarts but never runs a sweep more often than its cadence within
 * one process lifetime.
 */
@Injectable()
export class CronRetentionSchedulerService implements OnModuleInit, OnModuleDestroy {
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private readonly lastRunAt = new Map<string, number>();
  private readonly runners: ReadonlyMap<string, () => Promise<unknown>>;

  constructor(
    @Inject(REDIS) private readonly redis: Redis | null,
    private readonly lease: CronLeaseService,
    hrRetention: CronHrRetentionService,
    helpdeskRetention: CronHelpdeskRetentionService,
    mailRetention: CronMailRetentionService,
    announcementsRetention: CronAnnouncementsRetentionService,
    aiUsageRetention: CronAiUsageRetentionService,
    notificationRetention: CronNotificationRetentionService,
    notificationOutboxRetention: CronNotificationOutboxRetentionService,
    outboxRetention: CronOutboxRetentionService,
    kbChatRetention: CronKbChatRetentionService,
    kbChunkRetention: CronKbChunkRetentionService,
    buildRetention: CronBuildRetentionService,
    gdprExportRetention: CronGdprExportRetentionService,
    partitionRetention: NotificationRetentionService,
    billing: CronBillingService,
  ) {
    this.runners = new Map<string, () => Promise<unknown>>([
      ["hr-policy-retention-sweep", () => hrRetention.sweep()],
      ["helpdesk-retention-sweep", () => helpdeskRetention.sweep()],
      ["mail-metadata-retention-sweep", () => mailRetention.sweep()],
      ["announcements-retention-sweep", () => announcementsRetention.sweep()],
      ["ai-usage-retention-sweep", () => aiUsageRetention.sweep({ dryRun: false })],
      ["notifications-retention-sweep", () => notificationRetention.sweep()],
      ["notification-outbox-retention-sweep", () => notificationOutboxRetention.sweep()],
      ["outbox-events-retention-sweep", () => outboxRetention.sweep()],
      ["kb-chat-history-purge", () => kbChatRetention.purgeExpiredConversations()],
      ["kb-chunk-retention-sweep", () => kbChunkRetention.pruneStaleChunks()],
      ["build-retention-prune", () => buildRetention.pruneWebhookDeliveries()],
      ["gdpr-export-artifact-retention", () => gdprExportRetention.sweep()],
      ["notifications-retention-detach", () => partitionRetention.sweep()],
      ["ai-reservations-sweep", () => billing.sweepAiReservations()],
    ]);
  }

  onModuleInit(): void {
    if (!CronRetentionSchedulerService.isEnabled()) {
      logger.warn(
        "[retention-scheduler] disabled — retention sweeps will run only if an external scheduler POSTs /cron/<job>",
      );
      return;
    }
    const every = tickIntervalMs();
    this.timeout = setTimeout(
      () => {
        void this.tick();
        this.interval = setInterval(() => {
          void this.tick();
        }, every);
      },
      Math.floor(Math.random() * MAX_BOOT_JITTER_MS),
    );
  }

  onModuleDestroy(): void {
    clearTimeout(this.timeout);
    clearInterval(this.interval);
  }

  /**
   * Off only where something else already drives the sweeps, and never in tests —
   * a spec that boots the module must not start a timer that outlives it.
   */
  static isEnabled(): boolean {
    if (process.env.NODE_ENV === "test") return false;
    return process.env.RETENTION_SCHEDULER_ENABLED !== "false";
  }

  /**
   * One pass over every declared job. Sequential on purpose: these are bulk deletes
   * against the same pool, and firing twelve of them at once is a self-inflicted
   * saturation event.
   */
  async tick(): Promise<RetentionTickOutcome> {
    const outcome: RetentionTickOutcome = {
      considered: RETENTION_JOBS.length,
      ran: [],
      skipped: [],
      failed: [],
    };
    if (this.ticking) return outcome;
    this.ticking = true;
    try {
      for (const job of RETENTION_JOBS) {
        const runner = this.runners.get(job.jobKey);
        if (!runner) {
          // A declared job with no runner is the exact "implemented but never called"
          // shape this scheduler exists to prevent, so it is loud rather than skipped.
          logger.error(`[retention-scheduler] no runner registered for ${job.jobKey}`);
          outcome.failed.push(job.jobKey);
          continue;
        }
        if (!(await this.isDue(job))) {
          outcome.skipped.push(job.jobKey);
          continue;
        }
        try {
          const leased = await this.lease.withLease(job.jobKey, job.leaseSeconds, runner);
          if (leased.ran) {
            this.lastRunAt.set(job.jobKey, Date.now());
            outcome.ran.push(job.jobKey);
            logger.info(`[retention-scheduler] ${PROCESS_CELL_ID}:${job.jobKey} completed`);
          } else {
            outcome.skipped.push(job.jobKey);
          }
        } catch (err: unknown) {
          // withLease has already written cron:last-error:<jobKey>; this keeps the
          // remaining jobs running rather than losing the whole tick to one failure.
          outcome.failed.push(job.jobKey);
          logger.error(`[retention-scheduler] ${job.jobKey} failed`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return outcome;
    } finally {
      this.ticking = false;
    }
  }

  private async isDue(job: RetentionJobDeclaration): Promise<boolean> {
    const localLast = this.lastRunAt.get(job.jobKey);
    if (localLast !== undefined && Date.now() - localLast < job.intervalMs) return false;
    if (!this.redis) return true;
    try {
      const raw = await this.redis.get(`${HEARTBEAT_KEY_PREFIX}${job.jobKey}`);
      if (typeof raw !== "string") return true;
      const at = Date.parse(raw);
      if (Number.isNaN(at)) return true;
      return Date.now() - at >= job.intervalMs;
    } catch (err: unknown) {
      // An unreadable heartbeat must not mean "recently ran": the lease still
      // prevents a duplicate, so erring towards running is the safe direction.
      logger.warn(`[retention-scheduler] heartbeat read failed for ${job.jobKey}`, {
        cause: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
  }
}
