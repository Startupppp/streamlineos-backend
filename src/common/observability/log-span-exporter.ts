import { redactAttributes } from "./redact";
import type { FinishedSpan, SpanExporter } from "./tracing";

export const HIGH_FREQUENCY_SEAMS: ReadonlySet<string> = new Set([
  "db.query.execute",
  "db.guc.setup",
  "db.pool.wait",
  "cache.roundtrip",
]);

const PRODUCTION_SAMPLE_RATE = 0.05;

export function resolveSpanSampleRate(env: NodeJS.ProcessEnv = process.env): number {
  const declared = env.OBSERVABILITY_SPAN_SAMPLE_RATE;
  if (declared !== undefined && declared.trim() !== "") {
    const parsed = Number(declared);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) return parsed;
  }
  return env.NODE_ENV === "production" ? PRODUCTION_SAMPLE_RATE : 1;
}

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
  constructor(
    private readonly sampleRate: number = resolveSpanSampleRate(),
    private readonly random: () => number = Math.random,
  ) {}

  export(span: FinishedSpan): void {
    const sampled = HIGH_FREQUENCY_SEAMS.has(span.name) && this.sampleRate < 1;
    if (sampled && span.status !== "error" && this.random() >= this.sampleRate) return;

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
        ...(sampled ? { sampleRate: this.sampleRate } : {}),
        ...redactAttributes(span.attributes),
      }) + "\n",
    );
  }
}
