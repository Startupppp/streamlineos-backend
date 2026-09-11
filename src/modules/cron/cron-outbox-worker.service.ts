import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { logger } from "../../common/logger/logger.service";
import { OutboxPublisherService } from "../../common/outbox/outbox-publisher.service";
import { CronLeaseService } from "./cron-lease.service";

const INTERVAL_MS = 15_000;
const KICKOFF_DELAY_MS = 2_000;
const JOB_KEY = "outbox-events-worker";
const LEASE_SECONDS = 120;

@Injectable()
export class CronOutboxWorkerService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;
  private kickoff: ReturnType<typeof setTimeout> | undefined;
  private running = false;

  constructor(
    private readonly publisher: OutboxPublisherService,
    private readonly lease: CronLeaseService,
  ) {}

  onModuleInit(): void {
    if (!CronOutboxWorkerService.isEnabled()) {
      logger.warn(
        "[outbox-worker] disabled — outbox events will drain only if an external scheduler POSTs /cron/outbox-events-worker",
      );
      return;
    }
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
    this.timer.unref();
    this.kickoff = setTimeout(() => void this.tick(), KICKOFF_DELAY_MS);
    this.kickoff.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
    clearTimeout(this.kickoff);
  }

  static isEnabled(): boolean {
    if (process.env.NODE_ENV === "test") return false;
    return process.env.OUTBOX_INPROCESS_WORKER !== "false";
  }

  wake(): void {
    void this.tick();
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.lease.withLease(JOB_KEY, LEASE_SECONDS, () => this.publisher.flush());
    } catch (error: unknown) {
      logger.error("[outbox-worker] flush failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }
}
