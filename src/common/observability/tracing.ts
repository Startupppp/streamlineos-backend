import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { getObservabilityContext } from "./observability-context";

/**
 * Spans, and the trace context that makes them join up.
 *
 * A port rather than a vendor, for the same reason the error reporter is one:
 * the application decides what is worth timing, and where the timings go is a
 * deployment concern. A self-hosted deployment must run with nothing attached.
 *
 * Deliberately not the OpenTelemetry SDK. The SDK is a dependency, a collector
 * endpoint and a deployment decision, none of which exist yet — but the *shape*
 * that matters is W3C trace context, and that is a string format. Emitting and
 * propagating real `traceparent` headers now means the trace ids already line
 * up on the day a collector is pointed at this: attaching OTel becomes an
 * exporter implementation rather than a re-instrumentation.
 */

export interface SpanContext {
  /** 32 lowercase hex characters, per W3C. */
  readonly traceId: string;
  /** 16 lowercase hex characters. */
  readonly spanId: string;
  /** Whether a collector is expected to keep this trace. */
  readonly sampled: boolean;
}

export interface FinishedSpan extends SpanContext {
  readonly name: string;
  readonly parentSpanId: string | null;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly status: "ok" | "error";
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

export interface SpanExporter {
  export(span: FinishedSpan): void;
}

/**
 * Discards by default.
 *
 * A missing collector costs timing detail, never correctness — and never an
 * error, because a tracer that throws would turn instrumentation into an
 * outage.
 */
const noopExporter: SpanExporter = { export: () => undefined };
let active: SpanExporter = noopExporter;

export function setSpanExporter(exporter: SpanExporter): void {
  active = exporter;
}

export function resetSpanExporter(): void {
  active = noopExporter;
}

const storage = new AsyncLocalStorage<SpanContext>();

export function currentSpan(): SpanContext | undefined {
  return storage.getStore();
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export function newTraceId(): string {
  return hex(16);
}

export function newSpanId(): string {
  return hex(8);
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/**
 * Read an incoming `traceparent`, or nothing.
 *
 * An all-zero trace or span id is invalid per the specification and is treated
 * as absent — a caller sending one is not offering a trace to join, and
 * adopting it would silently merge unrelated requests into one trace.
 */
export function parseTraceparent(header: string | undefined | null): SpanContext | null {
  if (typeof header !== "string") return null;

  const match = TRACEPARENT.exec(header.trim().toLowerCase());
  if (!match) return null;

  const [, traceId, spanId, flags] = match;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;

  return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
}

/** The header to send onward, so a downstream service joins this trace. */
export function formatTraceparent(span: SpanContext): string {
  return `00-${span.traceId}-${span.spanId}-${span.sampled ? "01" : "00"}`;
}

export interface StartSpanOptions {
  /** Join this trace instead of starting one — a parsed inbound traceparent. */
  readonly parent?: SpanContext | null;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface OpenSpan {
  readonly span: SpanContext;
  /** Records the span. Safe to call twice; the second call does nothing. */
  end(status?: "ok" | "error"): void;
}

/**
 * Begin a span whose end is not a function boundary.
 *
 * A request is the case this exists for: it starts in middleware and finishes
 * when the response does, which `withSpan` cannot express because `next()` does
 * not return a promise that resolves at the end of the request.
 */
export function startSpan(name: string, options: StartSpanOptions = {}): OpenSpan {
  const parent = options.parent ?? currentSpan() ?? null;

  const span: SpanContext = {
    traceId: parent?.traceId ?? newTraceId(),
    spanId: newSpanId(),
    sampled: parent ? parent.sampled : true,
  };

  const startedAt = Date.now();
  /**
   * Captured now, not read at the end.
   *
   * A span opened in middleware ends on the response's `finish` event, which
   * fires on a later turn of the event loop — by which time the async context
   * has been torn down and `getObservabilityContext()` returns nothing. Reading
   * it late silently drops the correlation id from exactly the spans it exists
   * to link.
   */
  const observability = getObservabilityContext();
  let ended = false;

  return {
    span,
    end(status: "ok" | "error" = "ok") {
      // Express can emit both `finish` and `close`; a span recorded twice would
      // double every request in the timings.
      if (ended) return;
      ended = true;
      exportSpan(span, name, parent, startedAt, status, options.attributes, observability);
    },
  };
}

/** Run `fn` with `span` as the ambient parent, so nested work joins the trace. */
export function runInSpan<T>(span: SpanContext, fn: () => T): T {
  return storage.run(span, fn);
}

function exportSpan(
  span: SpanContext,
  name: string,
  parent: SpanContext | null,
  startedAt: number,
  status: "ok" | "error",
  attributes: Readonly<Record<string, string | number | boolean>> | undefined,
  captured?: ReturnType<typeof getObservabilityContext>,
): void {
  // The captured context when there is one; otherwise the ambient one, which is
  // still live for a span that ends inside its own function boundary.
  const observability = captured ?? getObservabilityContext();
  try {
    active.export({
      ...span,
      name,
      parentSpanId: parent?.spanId ?? null,
      startedAt,
      durationMs: Date.now() - startedAt,
      status,
      attributes: {
        ...attributes,
        // Joined to the rest of the record, so a span and a log line about the
        // same request can be put side by side.
        ...(observability?.correlationId ? { "correlation.id": observability.correlationId } : {}),
        ...(observability?.orgId ? { "org.id": observability.orgId } : {}),
        ...(observability?.route ? { "http.route": observability.route } : {}),
      },
    });
  } catch {
    // A tracer must never turn instrumentation into an outage.
  }
}

/**
 * Run `fn` inside a span.
 *
 * The span nests under whatever is running, which is what makes deferred work
 * continue the request's trace rather than starting an orphan: an after-commit
 * hook runs inside the context it was registered in, so its span carries the
 * same trace id as the request that scheduled it.
 *
 * Never changes what `fn` does. An exporter that throws is swallowed, and a
 * failing `fn` still records its span before the error propagates.
 */
export async function withSpan<T>(
  name: string,
  fn: () => Promise<T>,
  options: StartSpanOptions = {},
): Promise<T> {
  const parent = options.parent ?? currentSpan() ?? null;

  const span: SpanContext = {
    traceId: parent?.traceId ?? newTraceId(),
    spanId: newSpanId(),
    // An explicitly unsampled parent stays unsampled; a new trace is sampled.
    sampled: parent ? parent.sampled : true,
  };

  const startedAt = Date.now();

  const finish = (status: "ok" | "error"): void =>
    exportSpan(span, name, parent, startedAt, status, options.attributes);

  return storage.run(span, async () => {
    try {
      const result = await fn();
      finish("ok");
      return result;
    } catch (error) {
      finish("error");
      throw error;
    }
  });
}
