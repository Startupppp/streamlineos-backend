import { HttpException, HttpStatus } from "@nestjs/common";
import { logger } from "../common/logger/logger.service";

export const DEFAULT_ACQUIRE_TIMEOUT_MS = 5_000;
export const DEFAULT_QUEUE_DEPTH_FACTOR = 4;

export type PoolShedReason = "queue-full" | "acquire-timeout";

export interface PoolAdmissionConfig {
  maxConcurrent: number;
  maxQueueDepth: number;
  acquireTimeoutMs: number;
  laneCapOverrides?: Record<string, number>;
}

export interface PoolAdmissionSnapshot {
  configured: boolean;
  maxConcurrent: number;
  maxQueueDepth: number;
  acquireTimeoutMs: number;
  active: number;
  queued: number;
  peakQueued: number;
  shedQueueFull: number;
  shedAcquireTimeout: number;
  admittedAfterWait: number;
  maxObservedWaitMs: number;
}

export class PoolSaturatedError extends HttpException {
  constructor(
    readonly reason: PoolShedReason,
    readonly waitedMs: number,
    retryAfterMs: number,
  ) {
    super(
      {
        code: "DB_POOL_SATURATED",
        message:
          reason === "queue-full"
            ? "Every database connection is checked out and the wait queue is full."
            : "Timed out waiting for a database connection.",
        details: { retryable: true, retryAfterMs, waitedMs },
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    this.name = "PoolSaturatedError";
  }
}

interface Waiter {
  admit: () => void;
  refuse: (error: PoolSaturatedError) => void;
  timer: ReturnType<typeof setTimeout>;
  queuedAt: number;
}

class Lane {
  active = 0;
  readonly queue: Waiter[] = [];
}

const SATURATION_LOG_INTERVAL_MS = 30_000;

class PoolAdmissionGate {
  private config: PoolAdmissionConfig | null = null;
  private readonly lanes = new Map<string, Lane>();
  private peakQueued = 0;
  private shedQueueFull = 0;
  private shedAcquireTimeout = 0;
  private admittedAfterWait = 0;
  private maxObservedWaitMs = 0;
  private lastShedLogAt = 0;

  configure(config: PoolAdmissionConfig): void {
    this.config = config;
  }

  /** Test-only reset; production never disarms a configured gate. */
  reset(): void {
    for (const lane of this.lanes.values())
      for (const waiter of lane.queue) clearTimeout(waiter.timer);
    this.lanes.clear();
    this.config = null;
    this.peakQueued = 0;
    this.shedQueueFull = 0;
    this.shedAcquireTimeout = 0;
    this.admittedAfterWait = 0;
    this.maxObservedWaitMs = 0;
    this.lastShedLogAt = 0;
  }

  async acquire(laneKey: string): Promise<() => void> {
    const config = this.config;
    if (!config) return () => {};

    const lane = this.laneFor(laneKey);
    const effectiveCap =
      this.config.laneCapOverrides?.[laneKey] ?? this.config.maxConcurrent;

    if (lane.active < effectiveCap) {
      lane.active += 1;
      return this.releaseFor(lane);
    }

    if (lane.queue.length >= config.maxQueueDepth) {
      this.shedQueueFull += 1;
      this.reportShed("queue-full", laneKey, lane, config);
      throw new PoolSaturatedError("queue-full", 0, config.acquireTimeoutMs);
    }

    const queuedAt = Date.now();
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        queuedAt,
        admit: resolve,
        refuse: reject,
        timer: setTimeout(() => {
          const index = lane.queue.indexOf(waiter);
          if (index >= 0) lane.queue.splice(index, 1);
          this.shedAcquireTimeout += 1;
          this.reportShed("acquire-timeout", laneKey, lane, config);
          reject(
            new PoolSaturatedError(
              "acquire-timeout",
              Date.now() - queuedAt,
              config.acquireTimeoutMs,
            ),
          );
        }, config.acquireTimeoutMs),
      };
      lane.queue.push(waiter);
      if (lane.queue.length > this.peakQueued)
        this.peakQueued = lane.queue.length;
    });

    const waitedMs = Date.now() - queuedAt;
    this.admittedAfterWait += 1;
    if (waitedMs > this.maxObservedWaitMs) this.maxObservedWaitMs = waitedMs;
    return this.releaseFor(lane);
  }

  snapshot(): PoolAdmissionSnapshot {
    let active = 0;
    let queued = 0;
    for (const lane of this.lanes.values()) {
      active += lane.active;
      queued += lane.queue.length;
    }
    return {
      configured: this.config !== null,
      maxConcurrent: this.config?.maxConcurrent ?? 0,
      maxQueueDepth: this.config?.maxQueueDepth ?? 0,
      acquireTimeoutMs: this.config?.acquireTimeoutMs ?? 0,
      active,
      queued,
      peakQueued: this.peakQueued,
      shedQueueFull: this.shedQueueFull,
      shedAcquireTimeout: this.shedAcquireTimeout,
      admittedAfterWait: this.admittedAfterWait,
      maxObservedWaitMs: this.maxObservedWaitMs,
    };
  }

  private laneFor(key: string): Lane {
    const existing = this.lanes.get(key);
    if (existing) return existing;
    const lane = new Lane();
    this.lanes.set(key, lane);
    return lane;
  }

  /**
   * The slot is handed straight to the next waiter rather than decremented and
   * re-taken, so a released connection cannot be claimed by an arriving request
   * ahead of one already queued.
   */
  private releaseFor(lane: Lane): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = lane.queue.shift();
      if (!next) {
        lane.active -= 1;
        return;
      }
      clearTimeout(next.timer);
      next.admit();
    };
  }

  private reportShed(
    reason: PoolShedReason,
    laneKey: string,
    lane: Lane,
    config: PoolAdmissionConfig,
  ): void {
    const now = Date.now();
    if (now - this.lastShedLogAt < SATURATION_LOG_INTERVAL_MS) return;
    this.lastShedLogAt = now;
    logger.warn("Database pool saturated — shedding tenant transactions", {
      reason,
      lane: laneKey,
      active: lane.active,
      queued: lane.queue.length,
      maxConcurrent: config.maxConcurrent,
      maxQueueDepth: config.maxQueueDepth,
      shedQueueFull: this.shedQueueFull,
      shedAcquireTimeout: this.shedAcquireTimeout,
    });
  }
}

export const poolAdmission = new PoolAdmissionGate();

export function configurePoolAdmission(config: PoolAdmissionConfig): void {
  poolAdmission.configure(config);
}

export function resolvePoolAdmissionConfig(input: {
  max: number;
  queueDepth?: number;
  acquireTimeoutMs?: number;
}): PoolAdmissionConfig {
  return {
    maxConcurrent: input.max,
    maxQueueDepth: input.queueDepth ?? input.max * DEFAULT_QUEUE_DEPTH_FACTOR,
    acquireTimeoutMs: input.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS,
  };
}
