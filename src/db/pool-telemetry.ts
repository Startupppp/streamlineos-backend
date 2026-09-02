import { startSpan } from "../common/observability/tracing";
import { SEAM_BUDGETS } from "../common/observability/seam-budgets";
import { logger } from "../common/logger/logger.service";
import { BoundedReservoir, RESERVOIR_CAP } from "./query-telemetry";
import {
  createBorrowScope,
  exitBorrowScope,
  getBorrowScope,
  runInBorrowScope,
  type BorrowScope,
} from "./borrow-scope";

const SATURATION_LOG_INTERVAL_MS = 30_000;
const FALLBACK_SLOW_ACQUIRE_MS = SEAM_BUDGETS['db.pool.wait'].thresholdMs;

/**
 * A borrow held this long is reported as long-held, and an idle gap this long
 * inside one is reported as idle-in-transaction. Both are well under the 60 s
 * `idle_in_transaction_session_timeout` so the counters rise before the database
 * starts killing transactions rather than after.
 */
const LONG_HOLD_MS = 1_000;
const IDLE_IN_TRANSACTION_MS = 250;

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
  p95WaitMs: number;
  maxHeldMs: number;
  averageHeldMs: number;
  p95HeldMs: number;
  longHolds: number;
  maxIdleInTransactionMs: number;
  p95IdleInTransactionMs: number;
  idleInTransactionBorrows: number;
  statementsPerBorrowMax: number;
}

export interface PoolBorrow {
  acquired(): void;
  release(): void;
}

const NOOP_BORROW: PoolBorrow = {
  acquired: () => {},
  release: () => {},
};

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
  private released = 0;
  private totalHeldMs = 0;
  private maxHeldMs = 0;
  private longHolds = 0;
  private maxIdleInTransactionMs = 0;
  private idleInTransactionBorrows = 0;
  private statementsPerBorrowMax = 0;
  private readonly waitReservoir = new BoundedReservoir(RESERVOIR_CAP);
  private readonly holdReservoir = new BoundedReservoir(RESERVOIR_CAP);
  private readonly idleReservoir = new BoundedReservoir(RESERVOIR_CAP);

  configure(options: { max: number; slowAcquireMs: number }): void {
    this.max = options.max;
    this.slowAcquireMs = options.slowAcquireMs;
  }

  begin(): PoolBorrow {
    const startedAt = Date.now();
    let acquiredAt: number | null = null;
    let state: "waiting" | "held" | "done" = "waiting";
    const waitSpan = startSpan('db.pool.wait', { attributes: { seam: 'db.pool.wait' } });

    this.waiting += 1;
    if (this.waiting > this.peakWaiting) this.peakWaiting = this.waiting;
    if (this.max > 0 && this.inFlight >= this.max) this.recordSaturation();

    return {
      acquired: () => {
        if (state !== "waiting") return;
        state = "held";
        acquiredAt = Date.now();
        this.waiting -= 1;
        this.inFlight += 1;
        this.borrows += 1;
        if (this.inFlight > this.peakInFlight)
          this.peakInFlight = this.inFlight;

        const waitMs = Date.now() - startedAt;
        this.totalWaitMs += waitMs;
        if (waitMs > this.maxWaitMs) this.maxWaitMs = waitMs;
        if (waitMs >= this.slowAcquireMs) this.slowAcquires += 1;
        this.waitReservoir.record(waitMs);

        try {
          waitSpan.end('ok');
        } catch {
        }
      },
      release: () => {
        if (state === "done") return;
        if (state === "waiting") {
          this.waiting -= 1;
          this.failedAcquires += 1;
          try {
            waitSpan.end('error');
          } catch {
          }
        } else {
          this.inFlight -= 1;
          this.recordHold(Date.now() - (acquiredAt ?? startedAt), getBorrowScope());
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
      p95WaitMs: this.waitReservoir.p95(),
      maxHeldMs: this.maxHeldMs,
      averageHeldMs:
        this.released === 0 ? 0 : Math.round(this.totalHeldMs / this.released),
      p95HeldMs: this.holdReservoir.p95(),
      longHolds: this.longHolds,
      maxIdleInTransactionMs: this.maxIdleInTransactionMs,
      p95IdleInTransactionMs: this.idleReservoir.p95(),
      idleInTransactionBorrows: this.idleInTransactionBorrows,
      statementsPerBorrowMax: this.statementsPerBorrowMax,
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
    this.released = 0;
    this.totalHeldMs = 0;
    this.maxHeldMs = 0;
    this.longHolds = 0;
    this.maxIdleInTransactionMs = 0;
    this.idleInTransactionBorrows = 0;
    this.statementsPerBorrowMax = 0;
    this.holdReservoir.clear();
    this.idleReservoir.clear();
  }

  /**
   * Transaction duration and idle-in-transaction, the two measurements §5.1 box 8
   * names that the borrow was not taking. Wait time alone cannot tell a slow
   * query from a connection pinned across an S3 PUT; hold time minus statement
   * time can.
   */
  private recordHold(heldMs: number, scope: BorrowScope | undefined): void {
    this.released += 1;
    this.totalHeldMs += heldMs;
    if (heldMs > this.maxHeldMs) this.maxHeldMs = heldMs;
    if (heldMs >= LONG_HOLD_MS) this.longHolds += 1;
    this.holdReservoir.record(heldMs);

    if (!scope) return;
    if (scope.statements > this.statementsPerBorrowMax)
      this.statementsPerBorrowMax = scope.statements;
    this.idleReservoir.record(scope.idleMs);
    if (scope.maxIdleGapMs > this.maxIdleInTransactionMs)
      this.maxIdleInTransactionMs = scope.maxIdleGapMs;
    if (scope.maxIdleGapMs >= IDLE_IN_TRANSACTION_MS) this.idleInTransactionBorrows += 1;
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

export function withPoolBorrow<T>(
  run: (borrow: PoolBorrow) => Promise<T>,
): Promise<T> {
  if (getBorrowScope()) return run(NOOP_BORROW);

  const borrow = poolTelemetry.begin();
  return runInBorrowScope(createBorrowScope(Date.now()), async () => {
    try {
      return await run(borrow);
    } finally {
      borrow.release();
    }
  });
}

export function runOutsidePoolBorrow<T>(fn: () => Promise<T>): Promise<T> {
  return exitBorrowScope(fn);
}
