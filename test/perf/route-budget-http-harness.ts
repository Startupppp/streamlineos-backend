import http from "node:http";
import https from "node:https";
import { queryTelemetry } from "src/db/query-telemetry";

/**
 * The HTTP-level instrument behind ticket 22's second box.
 *
 * `run-read-cost-budgets.mjs` measures one statement with EXPLAIN and can never answer what a
 * ROUTE costs: it sees neither the statements the handler issues around that read, nor the bytes
 * it serialises, nor the provider calls it makes, nor the heap it holds while doing it. Those four
 * ceilings — maxDbCalls, maxDownstreamCalls, maxResponseBytes, maxMemoryMb — plus the end-to-end
 * maxLatencyP95Ms are only observable from outside the process boundary, which is what this does.
 *
 * Four instruments, one request window:
 *
 *   db calls      QueryTelemetryTracker, the same singleton `countDbCalls` uses. It wraps
 *                 `client.unsafe`, the single entry point Drizzle's postgres-js driver takes, so
 *                 this counts round trips rather than call sites. `SELECT set_config(...)` is
 *                 classified separately, so arming the tenant GUC never inflates a route's count.
 *   downstream    `http.request` / `https.request` / `globalThis.fetch`, counted for every target
 *                 that is not the harness's own loopback port. Redis over the Upstash REST client
 *                 is a fetch and is counted; the supertest client's own socket is not.
 *   bytes         the byte length of the response body the application produced. Compression is
 *                 deliberately NOT enabled on the harness app: a gzip ratio is a property of the
 *                 payload's entropy and of the deployment, and measuring it here would make the
 *                 recorded number un-reproducible. This is the uncompressed figure, and the
 *                 manifest records that it is.
 *   heap          heapUsed above a post-GC baseline, sampled at 1 ms through the request and again
 *                 at completion, maximum taken. Requires --expose-gc; without it the baseline is
 *                 whatever the last request left behind and the number is refused, not guessed.
 *
 * Everything is measured SERIALLY. The telemetry tracker is a module-level singleton and the heap
 * baseline is process-wide, so two concurrent requests would each count the other's work.
 */

export interface RequestSample {
  readonly status: number;
  readonly ms: number;
  readonly bytes: number;
  readonly dbCalls: number;
  readonly gucCalls: number;
  readonly downstreamCalls: number;
  readonly heapMb: number | null;
}

export interface Percentiles {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly min: number;
  readonly max: number;
}

type NodeRequest = typeof http.request;
type FetchLike = (input: unknown, init?: unknown) => Promise<unknown>;

interface Saved {
  httpRequest: NodeRequest;
  httpGet: NodeRequest;
  httpsRequest: NodeRequest;
  httpsGet: NodeRequest;
  fetch: FetchLike | undefined;
}

/**
 * Counts outbound calls, excluding the harness's own loopback traffic.
 *
 * Without the exclusion every route would report at least one downstream call — the supertest
 * client connecting to the app under test — and a route that genuinely calls nothing would look
 * like a route that calls a provider.
 */
export class DownstreamCounter {
  private count = 0;
  private saved: Saved | null = null;
  private selfPorts = new Set<string>();

  excludeLoopbackPort(port: number): void {
    this.selfPorts.add(String(port));
  }

  private isSelf(target: string): boolean {
    if (!/^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\]|::1)/i.test(target)) return false;
    for (const port of this.selfPorts) if (target.includes(`:${port}`)) return true;
    return false;
  }

  private describe(arg: unknown): string {
    if (typeof arg === "string") return arg;
    if (arg instanceof URL) return arg.toString();
    if (arg !== null && typeof arg === "object") {
      const opts = arg as { host?: string; hostname?: string; port?: number | string; href?: string };
      if (typeof opts.href === "string") return opts.href;
      const host = opts.hostname ?? opts.host ?? "";
      return opts.port === undefined ? host : `${host}:${String(opts.port)}`;
    }
    return "";
  }

  install(): void {
    if (this.saved) return;
    this.saved = {
      httpRequest: http.request,
      httpGet: http.get,
      httpsRequest: https.request,
      httpsGet: https.get,
      fetch: (globalThis as { fetch?: FetchLike }).fetch,
    };

    const wrapNode = (original: NodeRequest): NodeRequest =>
      ((...args: Parameters<NodeRequest>) => {
        if (!this.isSelf(this.describe(args[0]))) this.count += 1;
        return original(...args);
      }) as NodeRequest;

    http.request = wrapNode(this.saved.httpRequest);
    http.get = wrapNode(this.saved.httpGet);
    https.request = wrapNode(this.saved.httpsRequest);
    https.get = wrapNode(this.saved.httpsGet);

    const originalFetch = this.saved.fetch;
    if (originalFetch)
      (globalThis as { fetch?: FetchLike }).fetch = async (input: unknown, init?: unknown) => {
        if (!this.isSelf(this.describe(input))) this.count += 1;
        return originalFetch(input, init);
      };
  }

  restore(): void {
    if (!this.saved) return;
    http.request = this.saved.httpRequest;
    http.get = this.saved.httpGet;
    https.request = this.saved.httpsRequest;
    https.get = this.saved.httpsGet;
    if (this.saved.fetch) (globalThis as { fetch?: FetchLike }).fetch = this.saved.fetch;
    this.saved = null;
  }

  reset(): void {
    this.count = 0;
  }

  read(): number {
    return this.count;
  }
}

export function percentiles(values: readonly number[]): Percentiles | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1));
    return sorted[idx] ?? 0;
  };
  return {
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    min: round(sorted[0] ?? 0),
    max: round(sorted[sorted.length - 1] ?? 0),
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

const BYTES_PER_MB = 1024 * 1024;

interface GlobalWithGc {
  gc?: () => void;
}

export function gcAvailable(): boolean {
  return typeof (globalThis as GlobalWithGc).gc === "function";
}

function collect(): void {
  (globalThis as GlobalWithGc).gc?.();
}

export interface HttpResponseShape {
  readonly status: number;
  readonly bytes: number;
}

/**
 * One measured request.
 *
 * The heap poll runs on a 1 ms interval for the life of the request and is unref'd, so a route
 * that finishes inside one tick still contributes its completion sample and never holds the loop
 * open. `measureHeap: false` skips the forced collection entirely — a GC between every sample
 * costs more wall clock than the requests do, so latency and heap are taken in separate passes
 * rather than one pass that measures a distorted version of both.
 */
export async function measureOnce(
  send: () => Promise<HttpResponseShape>,
  downstream: DownstreamCounter,
  options: { measureHeap: boolean },
): Promise<RequestSample> {
  const trackHeap = options.measureHeap && gcAvailable();
  if (trackHeap) collect();
  const baseline = process.memoryUsage().heapUsed;
  let peak = baseline;
  const poll = trackHeap
    ? setInterval(() => {
        const used = process.memoryUsage().heapUsed;
        if (used > peak) peak = used;
      }, 1)
    : null;
  poll?.unref();

  queryTelemetry.reset();
  downstream.reset();
  const startedAt = process.hrtime.bigint();
  let response: HttpResponseShape;
  try {
    response = await send();
  } finally {
    if (poll) clearInterval(poll);
  }
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  const settled = process.memoryUsage().heapUsed;
  if (settled > peak) peak = settled;

  const snapshot = queryTelemetry.snapshot();
  return {
    status: response.status,
    ms: round(elapsedMs),
    bytes: response.bytes,
    dbCalls: snapshot["db.query.execute"].count,
    gucCalls: snapshot["db.guc.setup"].count,
    downstreamCalls: downstream.read(),
    heapMb: trackHeap ? round(Math.max(0, peak - baseline) / BYTES_PER_MB) : null,
  };
}

export interface RouteMeasurement {
  readonly status: "measured" | "unmeasured";
  readonly httpStatus: number | null;
  readonly reason?: string;
  readonly samples: number;
  readonly latencyMs: Percentiles | null;
  readonly dbCalls: number | null;
  readonly dbCallsVaried: readonly number[] | null;
  readonly gucCalls: number | null;
  readonly downstreamCalls: number | null;
  readonly responseBytes: number | null;
  readonly memoryMb: number | null;
  readonly bodyPreview?: string;
}

/**
 * A route is measured only when it answered 2xx.
 *
 * A 403 measures the guard, a 404 measures the router, a 500 measures the failure path — none of
 * them is the route's cost, and recording one as `measuredLatencyP95Ms` would put a number in the
 * manifest that describes work the application never does in production. The status and the
 * response body's first line are carried through instead, so the residue says WHY rather than
 * only how large it is.
 */
export function summarise(
  samples: readonly RequestSample[],
  heapSamples: readonly RequestSample[],
  bodyPreview: string | undefined,
): RouteMeasurement {
  const first = samples[0];
  if (!first)
    return {
      status: "unmeasured",
      httpStatus: null,
      reason: "no samples were taken",
      samples: 0,
      latencyMs: null,
      dbCalls: null,
      dbCallsVaried: null,
      gucCalls: null,
      downstreamCalls: null,
      responseBytes: null,
      memoryMb: null,
    };

  const nonOk = samples.find((s) => s.status < 200 || s.status >= 300);
  if (nonOk)
    return {
      status: "unmeasured",
      httpStatus: nonOk.status,
      reason: `route answered HTTP ${String(nonOk.status)} — a non-2xx response measures the failure path, not the route`,
      samples: samples.length,
      latencyMs: null,
      dbCalls: null,
      dbCallsVaried: null,
      gucCalls: null,
      downstreamCalls: null,
      responseBytes: null,
      memoryMb: null,
      bodyPreview,
    };

  const dbCounts = samples.map((s) => s.dbCalls);
  const distinct = [...new Set(dbCounts)].sort((a, b) => a - b);
  const heapValues = heapSamples.map((s) => s.heapMb).filter((v): v is number => v !== null);

  return {
    status: "measured",
    httpStatus: first.status,
    samples: samples.length,
    latencyMs: percentiles(samples.map((s) => s.ms)),
    // The ceiling is a ceiling: when a route's count varies across samples (a cache fill on the
    // first call, a lazily-created row on another), the MAXIMUM is what a budget must hold.
    dbCalls: Math.max(...dbCounts),
    dbCallsVaried: distinct.length > 1 ? distinct : null,
    gucCalls: Math.max(...samples.map((s) => s.gucCalls)),
    downstreamCalls: Math.max(...samples.map((s) => s.downstreamCalls)),
    responseBytes: Math.max(...samples.map((s) => s.bytes)),
    memoryMb: heapValues.length > 0 ? Math.max(...heapValues) : null,
  };
}
