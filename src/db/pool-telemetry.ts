import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "../common/logger/logger.service";

const SATURATION_LOG_INTERVAL_MS = 30_000;
const FALLBACK_SLOW_ACQUIRE_MS = 250;

export interface PoolTelemetrySnapshot {
  max: number;
  waiting: number;
  borrows: number;
  inFlight: number;
  maxWaitMs: number;
  peakWaiting: number;
  peakInFlight: number;
  slowAcquires: number;
  averageWaitMs: number;
  failedAcquires: number;
  saturationEvents: number;
  lastSaturationAt: string | null;
}

export interface PoolBorrow {
  acquired(): void;
  release(): void;
}

const NOOP_BORROW: PoolBorrow = {
  acquired: () => {},
  release: () => {},
};

/**
 * postgres-js keeps its queues in a closure and exposes only `options`, so pool
 * depth is unreadable from the driver. The equivalent is observable from outside:
 * every authenticated request runs inside one tenant transaction, so in-flight
 * tenant transactions are checked-out connections, and the gap between asking for
 * a transaction and entering its callback is the time spent queueing for one.
 */
class PoolTelemetry {
  private max = 0;
  private waiting = 0;
  private borrows = 0;
  private inFlight = 0;
  private maxWaitMs = 0;
  private totalWaitMs = 0;
  private peakWaiting = 0;
  private peakInFlight = 0;
  private slowAcquires = 0;
  private failedAcquires = 0;
  private saturationEvents = 0;
  private lastSaturationLogAt = 0;
  private lastSaturationAt: string | null = null;
  private slowAcquireMs = FALLBACK_SLOW_ACQUIRE_MS;

  configure(options: { max: number; slowAcquireMs: number }): void {
    this.max = options.max;
    this.slowAcquireMs = options.slowAcquireMs;
  }

  begin(): PoolBorrow {
    const startedAt = Date.now();
    let state: "waiting" | "held" | "done" = "waiting";

    this.waiting += 1;
    if (this.waiting > this.peakWaiting) this.peakWaiting = this.waiting;
    if (this.max > 0 && this.inFlight >= this.max) this.recordSaturation();

    return {
      acquired: () => {
        if (state !== "waiting") return;
        state = "held";
        this.waiting -= 1;
        this.inFlight += 1;
        this.borrows += 1;
        if (this.inFlight > this.peakInFlight)
          this.peakInFlight = this.inFlight;

        const waitMs = Date.now() - startedAt;
        this.totalWaitMs += waitMs;
        if (waitMs > this.maxWaitMs) this.maxWaitMs = waitMs;
        if (waitMs >= this.slowAcquireMs) this.slowAcquires += 1;
      },
      release: () => {
        if (state === "done") return;
        if (state === "waiting") {
          this.waiting -= 1;
          this.failedAcquires += 1;
        } else {
          this.inFlight -= 1;
        }
        state = "done";
      },
    };
  }

  snapshot(): PoolTelemetrySnapshot {
    return {
      max: this.max,
      inFlight: this.inFlight,
      waiting: this.waiting,
      peakInFlight: this.peakInFlight,
      peakWaiting: this.peakWaiting,
      borrows: this.borrows,
      saturationEvents: this.saturationEvents,
      slowAcquires: this.slowAcquires,
      failedAcquires: this.failedAcquires,
      averageWaitMs:
        this.borrows === 0 ? 0 : Math.round(this.totalWaitMs / this.borrows),
      maxWaitMs: this.maxWaitMs,
      lastSaturationAt: this.lastSaturationAt,
    };
  }

  reset(): void {
    this.waiting = 0;
    this.inFlight = 0;
    this.peakWaiting = 0;
    this.peakInFlight = 0;
    this.borrows = 0;
    this.slowAcquires = 0;
    this.failedAcquires = 0;
    this.saturationEvents = 0;
    this.totalWaitMs = 0;
    this.maxWaitMs = 0;
    this.lastSaturationAt = null;
    this.lastSaturationLogAt = 0;
  }

  private recordSaturation(): void {
    this.saturationEvents += 1;
    const now = Date.now();
    this.lastSaturationAt = new Date(now).toISOString();

    if (now - this.lastSaturationLogAt < SATURATION_LOG_INTERVAL_MS) return;
    this.lastSaturationLogAt = now;
    logger.warn(
      "Database pool saturated — tenant transactions are queueing for a connection",
      {
        max: this.max,
        inFlight: this.inFlight,
        waiting: this.waiting,
        saturationEvents: this.saturationEvents,
      },
    );
  }
}

export const poolTelemetry = new PoolTelemetry();

const activeBorrow = new AsyncLocalStorage<true>();

/**
 * A savepoint opened on an already-borrowed connection must not be counted
 * again, or `inFlight` drifts past `max` and every nested write reads as
 * saturation.
 */
export function withPoolBorrow<T>(
  run: (borrow: PoolBorrow) => Promise<T>,
): Promise<T> {
  if (activeBorrow.getStore()) return run(NOOP_BORROW);

  const borrow = poolTelemetry.begin();
  return activeBorrow.run(true, async () => {
    try {
      return await run(borrow);
    } finally {
      borrow.release();
    }
  });
}

export function runOutsidePoolBorrow<T>(fn: () => Promise<T>): Promise<T> {
  return activeBorrow.exit(fn);
}
