import { callProvider, outboundTraceHeaders, type ProviderDescriptor } from "./call-provider";
import { ProviderCircuitBreaker } from "./provider-circuit-breaker";
import {
  parseTraceparent,
  resetSpanExporter,
  runInSpan,
  setSpanExporter,
  type FinishedSpan,
} from "../observability/tracing";
import { runWithObservabilityContext } from "../observability/observability-context";

const REQUEST_CORRELATION_ID = "cid-provider-seam";
const REQUEST_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const REQUEST_SPAN_ID = "00f067aa0ba902b7";

function collectSpans(): { spans: FinishedSpan[]; restore: () => void } {
  const spans: FinishedSpan[] = [];
  setSpanExporter({ export: (span) => spans.push(span) });
  return { spans, restore: () => resetSpanExporter() };
}

function descriptor(overrides: Partial<ProviderDescriptor> = {}): ProviderDescriptor {
  return {
    provider: "razorpay",
    timeoutMs: 1_000,
    maxAttempts: 3,
    baseDelayMs: 0,
    maxDelayMs: 0,
    classify: () => "retryable",
    ...overrides,
  };
}

function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  return runWithObservabilityContext({ correlationId: REQUEST_CORRELATION_ID }, () =>
    runInSpan({ traceId: REQUEST_TRACE_ID, spanId: REQUEST_SPAN_ID, sampled: true }, fn),
  );
}

describe("outboundTraceHeaders", () => {
  afterEach(() => resetSpanExporter());

  it("emits a W3C traceparent naming the current span, so a provider joins this trace", async () => {
    const headers = await inRequest(async () => outboundTraceHeaders());

    const parsed = parseTraceparent(headers["traceparent"]);
    expect(parsed?.traceId).toBe(REQUEST_TRACE_ID);
    expect(parsed?.spanId).toBe(REQUEST_SPAN_ID);
    expect(headers["x-correlation-id"]).toBe(REQUEST_CORRELATION_ID);
  });

  it("sends nothing when there is no ambient trace, rather than a misleading header", () => {
    expect(outboundTraceHeaders()).toEqual({});
  });
});

describe("callProvider joins the request's trace", () => {
  let collected: ReturnType<typeof collectSpans>;
  beforeEach(() => {
    collected = collectSpans();
  });
  afterEach(() => collected.restore());

  it("records a span under the originating trace id, not an orphan one", async () => {
    const result = await inRequest(() =>
      callProvider(descriptor(), async () => "charged", new ProviderCircuitBreaker()),
    );

    expect(result.ok).toBe(true);
    expect(collected.spans).toHaveLength(1);
    const span = collected.spans[0];
    expect(span?.name).toBe("provider.razorpay");
    expect(span?.traceId).toBe(REQUEST_TRACE_ID);
    expect(span?.parentSpanId).toBe(REQUEST_SPAN_ID);
    expect(span?.status).toBe("ok");
    expect(span?.attributes["correlation.id"]).toBe(REQUEST_CORRELATION_ID);
  });

  it("records one span per attempt, so retries are visible rather than averaged away", async () => {
    let calls = 0;
    const result = await inRequest(() =>
      callProvider(
        descriptor(),
        async () => {
          calls += 1;
          if (calls < 3) throw new Error("upstream 503");
          return "charged";
        },
        new ProviderCircuitBreaker(),
        () => 0,
      ),
    );

    expect(result).toMatchObject({ ok: true, attempts: 3 });
    expect(collected.spans).toHaveLength(3);
    expect(collected.spans.map((span) => span.status)).toEqual(["error", "error", "ok"]);
    expect(collected.spans.map((span) => span.attributes["provider.attempt"])).toEqual([1, 2, 3]);
    expect(new Set(collected.spans.map((span) => span.traceId))).toEqual(
      new Set([REQUEST_TRACE_ID]),
    );
  });

  it("an exporter that throws never changes the provider result", async () => {
    setSpanExporter({
      export: () => {
        throw new Error("collector unreachable");
      },
    });

    const result = await inRequest(() =>
      callProvider(descriptor(), async () => "charged", new ProviderCircuitBreaker()),
    );

    expect(result).toMatchObject({ ok: true, value: "charged" });
  });
});
