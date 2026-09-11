import {
  classifyContention,
  fingerprintQuery,
  rowsReturnedOf,
} from "./query-fingerprint";

/**
 * A statement at or above this is recorded against its fingerprint as slow.
 * Kept deliberately low: the point is to find the query issued 4,000 times at
 * 3 ms each, which no per-statement threshold tuned for "slow" would ever see.
 */
export const SLOW_QUERY_MS = 50;

/**
 * Fingerprints are unbounded in principle — a `sql` fragment built from a
 * changing shape mints a new one every call — so the table is capped and the
 * overflow is counted rather than silently absorbed. A rising
 * `fingerprintsDropped` means the normaliser is missing a literal, which is a
 * defect in `query-fingerprint.ts`, not in the caller.
 */
export const FINGERPRINT_CAP = 256;

export interface QueryFingerprintStat {
  id: string;
  shape: string;
  calls: number;
  totalMs: number;
  maxMs: number;
  slowCalls: number;
  rowsReturned: number;
  errors: number;
  lockWaits: number;
  deadlocks: number;
  timeouts: number;
}

export interface FingerprintTotals {
  rowsReturned: number;
  slowQueries: number;
  lockWaits: number;
  deadlocks: number;
  timeouts: number;
  fingerprints: number;
  fingerprintsDropped: number;
}

/**
 * Per-fingerprint call count, rows returned and contention — §5.1 box 9's list
 * minus buffers, which needs an `EXPLAIN` per statement and is measured offline
 * by `run-read-cost-budgets.mjs` instead.
 *
 * Nothing recorded here has ever held a bind value: `fingerprintQuery`
 * normalises literals and `$n` placeholders to `?` before the shape is stored,
 * and the error path keeps only the SQLSTATE class.
 */
export class QueryFingerprintRegistry {
  private rowsReturned = 0;
  private slowQueries = 0;
  private lockWaits = 0;
  private deadlocks = 0;
  private timeouts = 0;
  private fingerprintsDropped = 0;
  private readonly stats = new Map<string, QueryFingerprintStat>();

  record(
    queryText: string,
    durationMs: number,
    status: "ok" | "error",
    outcome: unknown,
  ): void {
    const { id, shape } = fingerprintQuery(queryText);
    let stat = this.stats.get(id);
    if (!stat) {
      if (this.stats.size >= FINGERPRINT_CAP) {
        this.fingerprintsDropped += 1;
        return;
      }
      stat = {
        id,
        shape,
        calls: 0,
        totalMs: 0,
        maxMs: 0,
        slowCalls: 0,
        rowsReturned: 0,
        errors: 0,
        lockWaits: 0,
        deadlocks: 0,
        timeouts: 0,
      };
      this.stats.set(id, stat);
    }

    stat.calls += 1;
    stat.totalMs += durationMs;
    if (durationMs > stat.maxMs) stat.maxMs = durationMs;
    if (durationMs >= SLOW_QUERY_MS) {
      stat.slowCalls += 1;
      this.slowQueries += 1;
    }

    if (status === "ok") {
      const rows = rowsReturnedOf(outcome);
      stat.rowsReturned += rows;
      this.rowsReturned += rows;
      return;
    }

    stat.errors += 1;
    const contention = classifyContention(outcome);
    if (contention === "lockWait") {
      stat.lockWaits += 1;
      this.lockWaits += 1;
    } else if (contention === "deadlock") {
      stat.deadlocks += 1;
      this.deadlocks += 1;
    } else if (contention === "timeout") {
      stat.timeouts += 1;
      this.timeouts += 1;
    }
  }

  /** Slowest fingerprints by total time — where the round trips actually went. */
  top(limit = 10): QueryFingerprintStat[] {
    return [...this.stats.values()]
      .sort((a, b) => b.totalMs - a.totalMs || b.calls - a.calls)
      .slice(0, limit)
      .map((stat) => ({ ...stat }));
  }

  totals(): FingerprintTotals {
    return {
      rowsReturned: this.rowsReturned,
      slowQueries: this.slowQueries,
      lockWaits: this.lockWaits,
      deadlocks: this.deadlocks,
      timeouts: this.timeouts,
      fingerprints: this.stats.size,
      fingerprintsDropped: this.fingerprintsDropped,
    };
  }

  clear(): void {
    this.rowsReturned = 0;
    this.slowQueries = 0;
    this.lockWaits = 0;
    this.deadlocks = 0;
    this.timeouts = 0;
    this.fingerprintsDropped = 0;
    this.stats.clear();
  }
}
