import type { FinishedSpan, SpanExporter } from "./tracing";

/**
 * Writes each finished span as a structured JSON line to stdout so p95 latency
 * can be computed from the log stream without a separate metrics database.
 *
 * Wire at boot: `setSpanExporter(new LogSpanExporter())` in `backend/src/main.ts`.
 *
 * To compute p95: group lines where `message === "SPAN"` by `name`, collect
 * `latencyMs`, sort, read the 95th-percentile entry.
 */
export class LogSpanExporter implements SpanExporter {
  export(span: FinishedSpan): void {
    process.stdout.write(
      JSON.stringify({
        timestamp: new Date(span.startedAt).toISOString(),
        level: "info",
        message: "SPAN",
        name: span.name,
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        status: span.status,
        latencyMs: span.durationMs,
        ...span.attributes,
      }) + "\n",
    );
  }
}
