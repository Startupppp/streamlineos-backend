import {
  resetSpanExporter,
  runWithObservabilityContext,
  setSpanExporter,
  type FinishedSpan,
} from "../../../../common/observability";
import {
  redactAttributes,
  SENSITIVE_EXACT,
  SENSITIVE_SUBSTRINGS,
} from "../../../../common/observability/redact";
import {
  AI_CALL_OUTCOMES,
  AI_CALL_SPAN_NAME,
  AI_OUTCOME_MAX_LENGTH,
  AiCallMetrics,
} from "./ai-call-metrics";
import { resolveAiCorrelationId } from "./ai-correlation";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function capture(): FinishedSpan[] {
  const spans: FinishedSpan[] = [];
  setSpanExporter({ export: (span) => spans.push(span) });
  return spans;
}

afterEach(() => resetSpanExporter());

describe("AiCallMetrics — the metric actually reaches the exporter", () => {
  it("emits exactly one span, under the constant name, when a call finishes", () => {
    const spans = capture();
    AiCallMetrics.begin({ feature: "kb.public-ask" }).finish("ok");
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe(AI_CALL_SPAN_NAME);
  });

  /**
   * The whole design depends on attributes written between `startSpan` and
   * `end()` being visible to the exporter. If the tracing seam ever snapshots
   * them at open time instead, every AI metric silently becomes three fields —
   * so it fails here rather than in production.
   */
  it("delivers attributes written AFTER the span was opened", () => {
    const spans = capture();
    const call = AiCallMetrics.begin({ feature: "ai:chat", tier: "standard" });
    call.retried();
    call.finish("ok", { model: "gpt-4o-mini", promptTokens: 120, completionTokens: 60 });

    const attributes = spans[0]?.attributes ?? {};
    expect(attributes["ai.outcome"]).toBe("ok");
    expect(attributes["ai.retries"]).toBe(1);
    expect(attributes["ai.model"]).toBe("gpt-4o-mini");
    expect(attributes["ai.tok_in"]).toBe(120);
  });

  it("finishing twice records one span, not two", () => {
    const spans = capture();
    const call = AiCallMetrics.begin({ feature: "ai:chat" });
    call.finish("ok");
    call.finish("error");
    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes["ai.outcome"]).toBe("ok");
  });
});

describe("AiCallMetrics — provider time is measured separately from ours", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("keeps the queue wait, the provider call and our own work in three buckets", async () => {
    const call = AiCallMetrics.begin({ feature: "ai:chat" });
    await call.queue(async () => { await jest.advanceTimersByTimeAsync(40); });
    await jest.advanceTimersByTimeAsync(40);
    await call.provider(async () => { await jest.advanceTimersByTimeAsync(60); });
    const timings = call.finish("ok");

    expect(timings.queueMs).toBe(40);
    expect(timings.providerMs).toBe(60);
    expect(timings.overheadMs).toBe(40);
  });

  it("BITE — a slow provider cannot be reported as application overhead", async () => {
    const call = AiCallMetrics.begin({ feature: "ai:chat" });
    await call.provider(async () => { await jest.advanceTimersByTimeAsync(120); });
    const timings = call.finish("ok");

    expect(timings.providerMs).toBe(120);
    expect(timings.overheadMs).toBe(0);
  });

  it("time-to-first-token is measured from the provider call, not from the request", async () => {
    const call = AiCallMetrics.begin({ feature: "kb.public-ask" });
    await call.queue(async () => { await jest.advanceTimersByTimeAsync(50); });
    await jest.advanceTimersByTimeAsync(50);
    call.providerOpened();
    await jest.advanceTimersByTimeAsync(40);
    call.firstToken();
    await jest.advanceTimersByTimeAsync(40);
    const timings = call.finish("ok");

    expect(timings.ttftMs).toBe(40);
  });

  it("only the first token counts, and a token before the provider opened counts for nothing", async () => {
    const call = AiCallMetrics.begin({ feature: "kb.public-ask" });
    call.firstToken();
    call.providerOpened();
    await jest.advanceTimersByTimeAsync(30);
    call.firstToken();
    await jest.advanceTimersByTimeAsync(40);
    call.firstToken();
    const timings = call.finish("ok");

    expect(timings.ttftMs).toBe(30);
  });
});

describe("AiCallMetrics — every dimension the ticket names is carried", () => {
  it("records queue, overhead, provider, ttft, tokens, credits, cost, cache, retries and outcome", () => {
    const spans = capture();
    const call = AiCallMetrics.begin({ feature: "ai:chat", orgId: "org_a" });
    call.providerOpened();
    call.firstToken();
    call.retried();
    call.served();
    call.finish("ok", {
      model: "gpt-4o-mini",
      promptTokens: 10,
      completionTokens: 5,
      creditsMilli: 12,
      costUsd: 0.0004,
    });

    const attributes = spans[0]?.attributes ?? {};
    for (const key of [
      "ai.feature",
      "ai.tier",
      "ai.outcome",
      "ai.queue_ms",
      "ai.overhead_ms",
      "ai.provider_ms",
      "ai.ttft_ms",
      "ai.tok_in",
      "ai.tok_out",
      "ai.credits_milli",
      "ai.cost_usd",
      "ai.cache_hit",
      "ai.retries",
      "ai.model",
      "org.id",
    ])
      expect(Object.keys(attributes)).toContain(key);
  });

  it("a rejection that never reached a provider still produces a record", () => {
    const spans = capture();
    AiCallMetrics.begin({ feature: "ai:chat" }).finish("concurrency_exceeded");
    expect(spans[0]?.attributes["ai.outcome"]).toBe("concurrency_exceeded");
    expect(spans[0]?.attributes["ai.provider_ms"]).toBe(0);
    expect(spans[0]?.status).toBe("error");
  });

  it("a cache hit, a dedupe hit and a cancellation are successes, not faults", () => {
    const spans = capture();
    for (const outcome of ["cache_hit", "dedupe_hit", "cancelled"] as const)
      AiCallMetrics.begin({ feature: "ai:chat" }).finish(outcome);
    expect(spans.map((s) => s.status)).toEqual(["ok", "ok", "ok"]);
  });
});

describe("AI metrics are tenant-safe", () => {
  it("carries no prompt, completion, content or bind value — every attribute is an id or a number", () => {
    const spans = capture();
    const call = AiCallMetrics.begin({ feature: "ai:chat", orgId: "org_a" });
    call.finish("ok", { model: "gpt-4o-mini", promptTokens: 1, completionTokens: 1 });

    const attributes = spans[0]?.attributes ?? {};
    const stringValues = Object.entries(attributes)
      .filter(([, value]) => typeof value === "string")
      .map(([key]) => key);
    // Only identifiers may be strings; anything else is a number or a boolean.
    expect(stringValues.sort()).toEqual(
      ["ai.feature", "ai.model", "ai.outcome", "ai.tier", "org.id"].sort(),
    );
  });

  it("no attribute key would be withheld by the redactor — nothing here is a secret in disguise", () => {
    const spans = capture();
    AiCallMetrics.begin({ feature: "ai:chat", orgId: "org_a" }).finish("ok", {
      model: "m",
      promptTokens: 1,
      completionTokens: 1,
      creditsMilli: 1,
      costUsd: 1,
    });

    for (const key of Object.keys(spans[0]?.attributes ?? {})) {
      const normalised = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
      expect(SENSITIVE_SUBSTRINGS.some((s) => normalised.includes(s))).toBe(false);
      expect(SENSITIVE_EXACT.has(normalised)).toBe(false);
    }
  });

  /**
   * The inverse leak. `redactAttributes` withholds any key containing "token" or
   * "prompt", which are exactly the words a token counter wants — so the obvious
   * names `ai.prompt_tokens` / `ai.completion_tokens` emit "[redacted]" and the
   * metric looks present while carrying nothing. Run the real redactor over the
   * real attributes rather than reasoning about the names.
   */
  it("survives the redactor intact — no dimension is silently withheld", () => {
    const spans = capture();
    const call = AiCallMetrics.begin({ feature: "ai:chat", orgId: "org_a" });
    call.providerOpened();
    call.firstToken();
    call.finish("ok", {
      model: "gpt-4o-mini",
      promptTokens: 120,
      completionTokens: 60,
      creditsMilli: 12,
      costUsd: 0.0004,
    });

    const emitted = redactAttributes(spans[0]?.attributes ?? {});
    expect(Object.values(emitted)).not.toContain("[redacted]");
    expect(emitted["ai.tok_in"]).toBe(120);
    expect(emitted["ai.tok_out"]).toBe(60);
  });

  it("BITE — the names the redactor eats really would be eaten", () => {
    const eaten = redactAttributes({ "ai.prompt_tokens": 120, "ai.completion_tokens": 60 });
    expect(eaten["ai.prompt_tokens"]).toBe("[redacted]");
    expect(eaten["ai.completion_tokens"]).toBe("[redacted]");
  });

  it("the span name is a constant, so no caller value can be interpolated into the message", () => {
    const spans = capture();
    AiCallMetrics.begin({ feature: "ai:chat" }).finish("ok");
    expect(spans[0]?.name).toBe(AI_CALL_SPAN_NAME);
    expect(AI_CALL_SPAN_NAME).not.toMatch(/[$`]/);
  });
});

describe("outcomes fit the column that stores them", () => {
  it.each(AI_CALL_OUTCOMES.map((o) => [o]))(
    "%s is within ai_usage_logs.outcome's varchar(20)",
    (outcome) => {
      expect(outcome.length).toBeLessThanOrEqual(AI_OUTCOME_MAX_LENGTH);
    },
  );

  it("(anti-vacuous) the declared width matches the column in the Drizzle schema", () => {
    const source = readFileSync(
      join(__dirname, "../../../../db/schema/common/ai-usage.ts"),
      "utf8",
    );
    const declared = /outcome:\s*varchar\("outcome",\s*\{\s*length:\s*(\d+)\s*\}\)/.exec(source);
    expect(declared).not.toBeNull();
    expect(Number(declared?.[1])).toBe(AI_OUTCOME_MAX_LENGTH);
  });
});

describe("the correlation id joins the request, and is minted only when there is none", () => {
  it("takes the ambient request's id", () => {
    const id = runWithObservabilityContext({ correlationId: "req-abc" }, () =>
      resolveAiCorrelationId(),
    );
    expect(id).toBe("req-abc");
  });

  it("mints a fresh one only with no ambient context — the cron case", () => {
    const id = resolveAiCorrelationId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("a call opened inside a request carries that request's id", () => {
    const call = runWithObservabilityContext({ correlationId: "req-xyz" }, () =>
      AiCallMetrics.begin({ feature: "ai:chat" }),
    );
    expect(call.correlationId).toBe("req-xyz");
  });
});
