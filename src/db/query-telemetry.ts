import { startSpan } from "../common/observability/tracing";
import type { SeamKey } from "../common/observability/seam-budgets";
import { noteStatementEnd, noteStatementStart } from "./borrow-scope";
import {
  QueryFingerprintRegistry,
  type FingerprintTotals,
  type QueryFingerprintStat,
} from "./query-fingerprint-registry";

export { type QueryFingerprintStat } from "./query-fingerprint-registry";

export const RESERVOIR_CAP = 1_024;

const GUC_PATTERN = /^\s*SELECT\s+set_config\s*\(/i;

export function classifyQuerySeam(queryText: string): SeamKey {
  return GUC_PATTERN.test(queryText) ? "db.guc.setup" : "db.query.execute";
}

export class BoundedReservoir {
  private readonly samples: number[] = [];
  private seen = 0;

  constructor(private readonly cap: number) {}

  record(value: number): void {
    this.seen += 1;
    if (this.samples.length < this.cap) {
      this.samples.push(value);
      return;
    }
    const slot = Math.floor(Math.random() * this.seen);
    if (slot < this.cap) this.samples[slot] = value;
  }

  p95(): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const idx = Math.ceil(sorted.length * 0.95) - 1;
    return sorted[Math.max(0, idx)] ?? 0;
  }

  get size(): number {
    return this.samples.length;
  }

  clear(): void {
    this.samples.length = 0;
    this.seen = 0;
  }
}

export interface SeamSnapshot {
  count: number;
  p95Ms: number;
}

export type QueryTelemetrySnapshot = {
  "db.guc.setup": SeamSnapshot;
  "db.query.execute": SeamSnapshot;
} & FingerprintTotals;

type Settle = (status: "ok" | "error", outcome?: unknown) => void;

export interface Thenable {
  then(onOk?: ((value: unknown) => unknown) | null, onErr?: ((reason: unknown) => unknown) | null): unknown;
}

type UnknownFn = (...args: unknown[]) => unknown;

function isThenable(value: object): value is Thenable {
  return typeof Reflect.get(value, "then") === "function";
}

function isUnknownFn(value: unknown): value is UnknownFn {
  return typeof value === "function";
}

export class QueryTelemetryTracker {
  private readonly gucReservoir = new BoundedReservoir(RESERVOIR_CAP);
  private readonly queryReservoir = new BoundedReservoir(RESERVOIR_CAP);
  private gucCount = 0;
  private queryCount = 0;
  private readonly fingerprints = new QueryFingerprintRegistry();

  observe<T extends object>(pending: T, queryText: string): T {
    const seamKey = classifyQuerySeam(queryText);
    const startedAt = Date.now();
    const span = startSpan(seamKey, { attributes: { seam: seamKey } });
    let settled = false;
    noteStatementStart(startedAt);

    const settle: Settle = (status, outcome) => {
      if (settled) return;
      settled = true;
      const durationMs = Date.now() - startedAt;
      try {
        noteStatementEnd();
        this.record(seamKey, durationMs);
        if (seamKey === "db.query.execute")
          this.fingerprints.record(queryText, durationMs, status, outcome);
        span.end(status);
      } catch {
        return;
      }
    };

    return this.wrap(pending, settle);
  }

  snapshot(): QueryTelemetrySnapshot {
    return {
      "db.guc.setup": { count: this.gucCount, p95Ms: this.gucReservoir.p95() },
      "db.query.execute": { count: this.queryCount, p95Ms: this.queryReservoir.p95() },
      ...this.fingerprints.totals(),
    };
  }

  /** Slowest fingerprints by total time — where the round trips actually went. */
  topFingerprints(limit = 10): QueryFingerprintStat[] {
    return this.fingerprints.top(limit);
  }

  reset(): void {
    this.gucCount = 0;
    this.queryCount = 0;
    this.fingerprints.clear();
    this.gucReservoir.clear();
    this.queryReservoir.clear();
  }

  private record(seamKey: SeamKey, durationMs: number): void {
    if (seamKey === "db.guc.setup") {
      this.gucCount += 1;
      this.gucReservoir.record(durationMs);
      return;
    }
    this.queryCount += 1;
    this.queryReservoir.record(durationMs);
  }

  private wrap<T extends object>(target: T, settle: Settle): T {
    const proxy: T = new Proxy(target, {
      get: (raw, prop) => {
        if (prop === "then" || prop === "catch" || prop === "finally") {
          // Asserted, not branched on. Narrowing this to `isThenable(raw) && …` made a
          // broken pending query fall through to `Reflect.get(raw, "then") === undefined`,
          // so `await` resolved to the raw object as though the statement had succeeded —
          // while `noteStatementStart` stayed unbalanced and the span was never ended.
          if (!isThenable(raw)) throw new TypeError("pending.then is not a function");
          const settling = (
            onOk?: (value: unknown) => unknown,
            onErr?: (reason: unknown) => unknown,
          ): unknown =>
            raw.then(
              (value: unknown) => {
                settle("ok", value);
                return onOk ? onOk(value) : value;
              },
              (reason: unknown) => {
                settle("error", reason);
                if (onErr) return onErr(reason);
                throw reason;
              },
            );

          if (prop === "then") return settling;

          if (prop === "catch")
            return (onErr?: (reason: unknown) => unknown) => settling(undefined, onErr);

          return (onDone?: () => void) =>
            settling(
              (value: unknown) => {
                onDone?.();
                return value;
              },
              (reason: unknown) => {
                onDone?.();
                throw reason;
              },
            );
        }

        const value: unknown = Reflect.get(raw, prop);
        if (!isUnknownFn(value)) return value;

        return (...args: unknown[]): unknown => {
          const result: unknown = value.apply(raw, args);
          return result === raw ? this.wrap(raw, settle) : result;
        };
      },
    });

    return proxy;
  }
}

export const queryTelemetry = new QueryTelemetryTracker();

type AnyFunction = (...args: never[]) => unknown;
type TransactionBody = (client: unknown) => unknown;

interface InstrumentableClient {
  unsafe: AnyFunction;
  begin?: AnyFunction;
  savepoint?: AnyFunction;
}

const CLIENT_PASSING_METHODS = ["begin", "savepoint"] as const;


const instrumented = new WeakSet<object>();

export function instrumentPostgresClient<T extends InstrumentableClient>(client: T): T {
  if (instrumented.has(client)) return client;
  instrumented.add(client);

  const mutable: { unsafe: AnyFunction; begin?: AnyFunction; savepoint?: AnyFunction } = client;
  const originalUnsafe = client.unsafe.bind(client) as (...args: unknown[]) => object;

  mutable.unsafe = ((...args: unknown[]): object => {
    const pending = originalUnsafe(...args);
    const [query] = args;
    try {
      return queryTelemetry.observe(pending, typeof query === "string" ? query : "");
    } catch {
      return pending;
    }
  }) as AnyFunction;

  for (const method of CLIENT_PASSING_METHODS) {
    const original = client[method]?.bind(client) as
      | ((...args: unknown[]) => unknown)
      | undefined;
    if (!original) continue;

    mutable[method] = ((...args: unknown[]): unknown => {
      const bodyIndex = args.findIndex((arg) => typeof arg === "function");
      if (bodyIndex === -1) return original(...args);

      const body = args[bodyIndex] as TransactionBody;
      const next = [...args];
      next[bodyIndex] = (scopedClient: unknown): unknown => {
        if (isInstrumentable(scopedClient)) instrumentPostgresClient(scopedClient);
        return body(scopedClient);
      };
      return original(...next);
    }) as AnyFunction;
  }

  return client;
}

function isInstrumentable(candidate: unknown): candidate is InstrumentableClient {
  if (typeof candidate !== "function" && typeof candidate !== "object") return false;
  if (candidate === null) return false;
  return typeof (candidate as { unsafe?: unknown }).unsafe === "function";
}
