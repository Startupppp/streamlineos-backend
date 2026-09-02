import { createServer } from "node:http";
import type { Server } from "node:http";
import { outboundRequest, OutboundRequestError } from "./outbound-request";

jest.mock("../logger/logger.service", () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../security/ssrf-guard", () => ({
  checkWebhookUrl: jest.fn(),
}));

import { checkWebhookUrl } from "../security/ssrf-guard";
import { parseTraceparent, runInSpan } from "../observability/tracing";
import { runWithObservabilityContext } from "../observability/observability-context";
const mockCheckWebhookUrl = checkWebhookUrl as jest.MockedFunction<typeof checkWebhookUrl>;

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";

function listenOnFreePort(server: Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("unexpected address type"));
        return;
      }
      resolve(addr.port);
    });
  });
}

describe("outboundRequest — the provider receives this trace, not a new one", () => {
  let server: Server;
  let port: number;
  const received: Record<string, string | undefined>[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      received.push({
        traceparent: req.headers["traceparent"] as string | undefined,
        correlation: req.headers["x-correlation-id"] as string | undefined,
        authorization: req.headers["authorization"] as string | undefined,
      });
      res.writeHead(200).end("{}");
    });
    port = await listenOnFreePort(server);
    mockCheckWebhookUrl.mockResolvedValue({ allowed: true });
  });

  afterAll((done) => {
    server.close(done);
  });

  beforeEach(() => {
    received.length = 0;
  });

  it("forwards a traceparent whose trace id is the request's, so both halves join", async () => {
    await runWithObservabilityContext({ correlationId: "cid-outbound" }, () =>
      runInSpan({ traceId: TRACE_ID, spanId: SPAN_ID, sampled: true }, () =>
        outboundRequest(`http://127.0.0.1:${String(port)}/charge`, {
          provider: "razorpay",
          timeoutMs: 2_000,
        }),
      ),
    );

    expect(received).toHaveLength(1);
    const parsed = parseTraceparent(received[0]?.traceparent);
    expect(parsed?.traceId).toBe(TRACE_ID);
    // Its own span, not the caller's: the provider's work nests under this call.
    expect(parsed?.spanId).not.toBe(SPAN_ID);
    expect(received[0]?.correlation).toBe("cid-outbound");
  });

  it("(bite proof) sends no trace headers at all when nothing is ambient", async () => {
    await outboundRequest(`http://127.0.0.1:${String(port)}/charge`, {
      provider: "razorpay",
      timeoutMs: 2_000,
    });

    expect(received[0]?.correlation).toBeUndefined();
  });

  it("never overwrites a header the adapter already set and may have signed", async () => {
    await runWithObservabilityContext({ correlationId: "cid-outbound" }, () =>
      outboundRequest(`http://127.0.0.1:${String(port)}/charge`, {
        provider: "razorpay",
        timeoutMs: 2_000,
        headers: { authorization: "Bearer scoped", "x-correlation-id": "adapter-chosen" },
      }),
    );

    expect(received[0]?.authorization).toBe("Bearer scoped");
    expect(received[0]?.correlation).toBe("adapter-chosen");
  });
});

describe("outboundRequest — hanging server is abandoned at the deadline", () => {
  let hangingServer: Server;
  let port: number;

  beforeAll(async () => {
    hangingServer = createServer((_req, _res) => {});
    port = await listenOnFreePort(hangingServer);
    mockCheckWebhookUrl.mockResolvedValue({ allowed: true });
  });

  afterAll((done) => {
    hangingServer.close(done);
  });

  it("rejects with OutboundRequestError outcome=timeout within the deadline", async () => {
    const start = Date.now();
    let caught: unknown;
    try {
      await outboundRequest(`http://127.0.0.1:${port}/`, {
        provider: "test-hanging",
        timeoutMs: 200,
      });
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - start;
    expect(caught).toBeInstanceOf(OutboundRequestError);
    expect((caught as OutboundRequestError).outcome).toBe("timeout");
    expect((caught as OutboundRequestError).provider).toBe("test-hanging");
    expect(elapsed).toBeLessThan(1_000);
  });
});

describe("outboundRequest — SSRF rejection delegates to checkWebhookUrl", () => {
  it("throws ssrf-blocked when the guard returns allowed: false", async () => {
    mockCheckWebhookUrl.mockResolvedValue({ allowed: false, reason: "blocked-address" });
    let caught: unknown;
    try {
      await outboundRequest("http://192.168.1.1/secret", {
        provider: "test-ssrf",
        timeoutMs: 5_000,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OutboundRequestError);
    expect((caught as OutboundRequestError).outcome).toBe("ssrf-blocked");
    expect((caught as OutboundRequestError).provider).toBe("test-ssrf");
  });
});

describe("outboundRequest — caller-supplied signal", () => {
  let slowServer: Server;
  let port: number;

  beforeAll(async () => {
    slowServer = createServer((_req, _res) => {});
    port = await listenOnFreePort(slowServer);
    mockCheckWebhookUrl.mockResolvedValue({ allowed: true });
  });

  afterAll((done) => {
    slowServer.close(done);
  });

  it("aborts when the caller signal fires before the helper timeout", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(
      outboundRequest(`http://127.0.0.1:${port}/`, {
        provider: "test-caller-signal",
        timeoutMs: 10_000,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(OutboundRequestError);
  });
});
