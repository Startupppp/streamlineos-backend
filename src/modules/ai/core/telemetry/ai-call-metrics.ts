import { startSpan, type OpenSpan } from "../../../../common/observability";
import { resolveAiCorrelationId } from "./ai-correlation";

/** The span name every AI gateway call is recorded under. */
export const AI_CALL_SPAN_NAME = "ai.gateway.call";

/**
 * `ai_usage_logs.outcome` is `varchar(20)`; a longer member would be rejected by
 * Postgres at insert time and lose the whole row, so the width is asserted
 * against the column rather than trusted.
 */
export const AI_OUTCOME_MAX_LENGTH = 20;

export const AI_CALL_OUTCOMES = [
  "ok",
  "error",
  "cancelled",
  "cache_hit",
  "dedupe_hit",
  "quota_exceeded",
  "concurrency_exceeded",
  "context_too_large",
  "invalid_output",
  "provider_unavailable",
  "not_configured",
] as const;

export type AiCallOutcome = (typeof AI_CALL_OUTCOMES)[number];

/**
 * Outcomes that cost the caller nothing and reached no provider. They are
 * successes, not faults: a cache hit is the system working, and a client
 * hanging up is the client's decision.
 */
const NON_FAULT_OUTCOMES: ReadonlySet<AiCallOutcome> = new Set<AiCallOutcome>([
  "ok",
  "cache_hit",
  "dedupe_hit",
  "cancelled",
]);

export interface AiCallFacts {
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  creditsMilli?: number;
  costUsd?: number;
}

export interface AiCallTimings {
  /** Waiting for the per-organisation concurrency slot. */
  queueMs: number;
  /** Everything this process did that was not the queue and not the provider. */
  overheadMs: number;
  /** Provider-bound, measured around the provider call alone. */
  providerMs: number;
  /** Provider time to the first streamed token, when the call streams. */
  ttftMs?: number;
  /** Provider attempts beyond the first, across retries and model fallback. */
  retries: number;
  cacheHit: boolean;
}

function clampNonNegative(value: number): number {
  return value > 0 ? value : 0;
}

/**
 * One record per AI gateway call, covering every dimension an operator needs and
 * carrying no tenant content at all.
 *
 * **Provider time is measured separately from ours.** `providerMs` brackets only
 * the provider call; `overheadMs` is what is left after the queue wait and the
 * provider are subtracted from the wall clock. Neither can absorb the other, so
 * a slow provider never reads as application overhead and our own slowness is
 * never excused as the provider's.
 *
 * **Nothing is interpolated into a message.** The emitted line's `message` is the
 * exporter's own constant and every attribute is an identifier, an enum member or
 * a number — the shape that lets a prompt, a completion or a bind value reach a
 * log through a template is not available here.
 *
 * Attributes are filled in as the call progresses and read when the span ends;
 * `ai-call-metrics.spec.ts` pins that the exporter really does see the late
 * writes, so a change to the tracing seam fails a test rather than silently
 * emptying every AI metric.
 */
export class AiCallMetrics {
  private readonly attributes: Record<string, string | number | boolean> = {};
  private readonly span: OpenSpan;
  private readonly startedAt = Date.now();
  private queueMs = 0;
  private providerMs = 0;
  private providerOpenedAt: number | null = null;
  private ttftMs: number | undefined;
  private retries = 0;
  private cacheHit = false;
  private finished = false;

  readonly correlationId: string;

  private constructor(
    private readonly feature: string,
    private readonly tier: string,
    orgId: string | undefined,
    correlationId: string,
  ) {
    this.correlationId = correlationId;
    this.attributes["ai.feature"] = feature;
    this.attributes["ai.tier"] = tier;
    // Ambient context overwrites this at export time when there is one; it fills
    // the gap for a cron-initiated call, which has an org but no request.
    if (orgId) this.attributes["org.id"] = orgId;
    this.span = startSpan(AI_CALL_SPAN_NAME, { attributes: this.attributes });
  }

  static begin(opts: { feature: string; tier?: string; orgId?: string }): AiCallMetrics {
    return new AiCallMetrics(
      opts.feature,
      opts.tier ?? "fast",
      opts.orgId,
      resolveAiCorrelationId(),
    );
  }

  /** Times the wait for a concurrency slot, whether or not the slot is granted. */
  async queue<T>(fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      this.queueMs += Date.now() - start;
    }
  }

  /** Brackets the provider call so its latency is never folded into ours. */
  async provider<T>(fn: () => Promise<T>): Promise<T> {
    this.providerOpened();
    try {
      return await fn();
    } finally {
      this.providerClosed();
    }
  }

  /** The streaming form of `provider`, whose end is not a function boundary. */
  providerOpened(): void {
    if (this.providerOpenedAt === null) this.providerOpenedAt = Date.now();
  }

  providerClosed(): void {
    if (this.providerOpenedAt === null) return;
    this.providerMs += Date.now() - this.providerOpenedAt;
    this.providerOpenedAt = null;
  }

  /** Time-to-first-token, measured from the provider call, not from the request. */
  firstToken(): void {
    if (this.ttftMs !== undefined || this.providerOpenedAt === null) return;
    this.ttftMs = Date.now() - this.providerOpenedAt;
  }

  retried(): void {
    this.retries += 1;
  }

  served(): void {
    this.cacheHit = true;
  }

  timings(): AiCallTimings {
    const elapsed = Date.now() - this.startedAt;
    const inFlightProvider =
      this.providerOpenedAt === null ? 0 : Date.now() - this.providerOpenedAt;
    const providerMs = this.providerMs + inFlightProvider;
    return {
      queueMs: this.queueMs,
      providerMs,
      overheadMs: clampNonNegative(elapsed - this.queueMs - providerMs),
      ...(this.ttftMs !== undefined ? { ttftMs: this.ttftMs } : {}),
      retries: this.retries,
      cacheHit: this.cacheHit,
    };
  }

  /** Records the span. Safe to call twice; the second call changes nothing. */
  finish(outcome: AiCallOutcome, facts: AiCallFacts = {}): AiCallTimings {
    if (this.finished) return this.timings();
    this.finished = true;
    this.providerClosed();
    const timings = this.timings();

    this.attributes["ai.outcome"] = outcome;
    this.attributes["ai.queue_ms"] = timings.queueMs;
    this.attributes["ai.overhead_ms"] = timings.overheadMs;
    this.attributes["ai.provider_ms"] = timings.providerMs;
    this.attributes["ai.retries"] = timings.retries;
    this.attributes["ai.cache_hit"] = timings.cacheHit;
    if (timings.ttftMs !== undefined) this.attributes["ai.ttft_ms"] = timings.ttftMs;
    if (facts.model !== undefined) this.attributes["ai.model"] = facts.model;
    // Abbreviated deliberately. `redactAttributes` withholds any key whose
    // normalised form contains "token" or "prompt", so `ai.prompt_tokens` and
    // `ai.completion_tokens` both arrive at the log as "[redacted]" — a metric
    // that looks emitted and carries nothing. The counts are integers with no
    // tenant content in them, so the key is what has to change, not the rule.
    if (facts.promptTokens !== undefined) this.attributes["ai.tok_in"] = facts.promptTokens;
    if (facts.completionTokens !== undefined)
      this.attributes["ai.tok_out"] = facts.completionTokens;
    if (facts.creditsMilli !== undefined) this.attributes["ai.credits_milli"] = facts.creditsMilli;
    if (facts.costUsd !== undefined) this.attributes["ai.cost_usd"] = facts.costUsd;

    this.span.end(NON_FAULT_OUTCOMES.has(outcome) ? "ok" : "error");
    return timings;
  }
}
