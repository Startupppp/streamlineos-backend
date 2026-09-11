import { runWithObservabilityContext } from "../observability/observability-context";
import { resetSpanExporter, setSpanExporter, type FinishedSpan } from "../observability/tracing";

interface CapturedRequest {
  readonly headers: Record<string, string>;
}

const captured: CapturedRequest[] = [];

const mockRequest = (
  _url: unknown,
  options: { headers: Record<string, string> },
  callback: (res: unknown) => void,
): { on: () => void; end: () => void } => {
  captured.push({ headers: options.headers });
  const res = {
    statusCode: 204,
    setEncoding: (): void => undefined,
    on: (event: string, handler: () => void): void => {
      if (event === "end") setImmediate(handler);
    },
  };
  setImmediate(() => callback(res));
  return { on: (): void => undefined, end: (): void => undefined };
};

const mockResolveSafeWebhookTarget = jest.fn();

jest.mock("node:https", () => ({
  request: (...args: unknown[]) =>
    (mockRequest as unknown as (...a: unknown[]) => unknown)(...args),
}));
jest.mock("node:http", () => ({
  request: (...args: unknown[]) =>
    (mockRequest as unknown as (...a: unknown[]) => unknown)(...args),
}));
jest.mock("../security/ssrf-guard", () => ({
  resolveSafeWebhookTarget: (...args: unknown[]) => mockResolveSafeWebhookTarget(...args),
}));

import { postSafeWebhook } from "./safe-webhook-transport";

const REQUEST_ID = "1c5a3f90-7b21-4d64-9a55-2e8c0f6b41d7";

/**
 * The provider boundary that is easy to miss.
 *
 * Every other outbound call goes through `outboundRequest`, which propagates
 * trace context. This one does not — it pins DNS to the addresses the SSRF guard
 * resolved, which `fetch` cannot express, so it reimplements the transport on
 * `node:https` and reimplemented the omission with it. A tenant's webhook
 * delivery arrived at the receiver with no trace to continue, and a failure at
 * the far end could not be joined to the change that triggered it.
 */
describe("postSafeWebhook trace propagation", () => {
  beforeEach(() => {
    captured.length = 0;
    mockResolveSafeWebhookTarget.mockResolvedValue({
      url: new URL("https://hooks.example.test/path"),
      addresses: [{ address: "93.184.216.34", family: 4 }],
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
    resetSpanExporter();
  });

  it("sends traceparent and the correlation id the request is running under", async () => {
    await runWithObservabilityContext({ correlationId: REQUEST_ID, orgId: "org-1" }, () =>
      postSafeWebhook("https://hooks.example.test/path", "{}", { "content-type": "application/json" }, 1_000, 1_000),
    );

    const headers = captured[0]?.headers ?? {};
    expect(headers["x-correlation-id"]).toBe(REQUEST_ID);
    expect(headers["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    expect(headers["content-type"]).toBe("application/json");
  });

  /**
   * A webhook signature covers the header set the caller chose. Filling in a
   * name they left empty is additive; replacing one they signed would make every
   * delivery fail verification at the receiver, which is a far more expensive
   * failure than a missing trace.
   */
  it("never overwrites a header the caller already set, whatever its case", async () => {
    await runWithObservabilityContext({ correlationId: REQUEST_ID }, () =>
      postSafeWebhook(
        "https://hooks.example.test/path",
        "{}",
        { "X-Correlation-Id": "signed-by-the-adapter", traceparent: "00-" + "a".repeat(32) + "-" + "b".repeat(16) + "-01" },
        1_000,
        1_000,
      ),
    );

    const headers = captured[0]?.headers ?? {};
    expect(headers["X-Correlation-Id"]).toBe("signed-by-the-adapter");
    expect(headers["x-correlation-id"]).toBeUndefined();
    expect(headers["traceparent"]).toBe("00-" + "a".repeat(32) + "-" + "b".repeat(16) + "-01");
  });

  it("records the delivery as a span carrying the correlation id", async () => {
    const spans: FinishedSpan[] = [];
    setSpanExporter({ export: (span) => spans.push(span) });

    await runWithObservabilityContext({ correlationId: REQUEST_ID, orgId: "org-1" }, () =>
      postSafeWebhook("https://hooks.example.test/path", "{}", {}, 1_000, 1_000),
    );

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      name: "provider.webhook",
      status: "ok",
      attributes: { "correlation.id": REQUEST_ID, "org.id": "org-1" },
    });
  });

  /**
   * A span name is not a place a redactor can reach, and a customer's webhook
   * hostname is that customer's data — it must not be built into one.
   */
  it("keeps the customer's endpoint out of the span name", async () => {
    const spans: FinishedSpan[] = [];
    setSpanExporter({ export: (span) => spans.push(span) });

    await runWithObservabilityContext({ correlationId: REQUEST_ID }, () =>
      postSafeWebhook("https://hooks.example.test/path", "{}", {}, 1_000, 1_000),
    );

    expect(spans[0]?.name).not.toContain("hooks.example.test");
    expect(JSON.stringify(spans[0]?.attributes)).not.toContain("hooks.example.test");
  });

  /**
   * The span the receiver is told to continue must be this delivery's, not the
   * caller's — otherwise the far side's trace is a sibling of the call rather
   * than its child, and the two read as unrelated work that happened to share a
   * trace id.
   */
  it("names the delivery's own span in the header, not the enclosing one", async () => {
    const spans: FinishedSpan[] = [];
    setSpanExporter({ export: (span) => spans.push(span) });

    await runWithObservabilityContext({ correlationId: REQUEST_ID }, () =>
      postSafeWebhook("https://hooks.example.test/path", "{}", {}, 1_000, 1_000),
    );

    const sentSpanId = (captured[0]?.headers["traceparent"] ?? "").split("-")[2];
    expect(sentSpanId).toBe(spans[0]?.spanId);
  });

  it("still refuses a target the SSRF guard rejected", async () => {
    mockResolveSafeWebhookTarget.mockResolvedValue({ reason: "blocked-address" });

    await expect(
      postSafeWebhook("https://hooks.example.test/path", "{}", {}, 1_000, 1_000),
    ).rejects.toThrow("blocked-address");
    expect(captured).toHaveLength(0);
  });
});
