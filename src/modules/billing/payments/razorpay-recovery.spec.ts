import * as http from "node:http";
import { BadGatewayException } from "@nestjs/common";
import { RazorpayAdapter, type RazorpayTransport } from "./adapters/razorpay.adapter";
import { PaymentProviderAdapterRegistry } from "./payment-provider-adapter.interface";
import { ProviderCircuitBreaker } from "../../../common/outbound/provider-circuit-breaker";

/**
 * Deterministic recovery proof for the Razorpay adapter.
 *
 * These tests never call api.razorpay.com and never need real credentials.
 * They inject a test transport that bypasses the SSRF guard (deliberately —
 * the SSRF guard is production-only; the seam is the adapter's `transport`
 * option) and drive the adapter against a local http.createServer whose
 * responses are scripted per case.
 *
 * Part 2 finding — Razorpay idempotency
 *   Razorpay's Orders API does NOT support a dedicated Idempotency-Key header.
 *   Source: https://razorpay.com/docs/api/orders/create — the page states:
 *   "receipt is treated as an idempotency key, so a second create call with
 *   the same value is rejected."  No HTTP header mechanism is documented.
 *   The compensating property is proven in the "receipt stability" case below:
 *   the adapter passes the caller-supplied receipt unchanged on every attempt,
 *   so if a duplicate order were ever created (e.g. two concurrent callers),
 *   both orders carry the same receipt and are reconcilable.
 */

interface QueuedResponse {
  readonly status: number;
  readonly body: unknown;
}

class FakeServer {
  private readonly server: http.Server;
  private readonly queue: QueuedResponse[] = [];
  private readonly _bodies: string[] = [];
  private _generation = 0;
  private _port = 0;

  constructor() {
    this.server = http.createServer((req, res) => {
      const queued = this.queue.shift() ?? { status: 500, body: { error: { description: "queue empty" } } };
      const gen = this._generation;
      let raw = "";
      req.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
      req.on("end", () => {
        if (this._generation === gen) this._bodies.push(raw);
        res.writeHead(queued.status, { "Content-Type": "application/json", Connection: "close" });
        res.end(JSON.stringify(queued.body));
      });
    });
  }

  get url(): string { return `http://127.0.0.1:${this._port}`; }
  get requestCount(): number { return this._bodies.length; }
  get requestBodies(): readonly string[] { return this._bodies; }

  enqueue(...responses: QueuedResponse[]): void {
    this.queue.push(...responses);
  }

  makeTransport(): RazorpayTransport {
    const serverUrl = this.url;
    return (_url, init) =>
      fetch(`${serverUrl}/v1/orders`, {
        method: init.method,
        headers: init.headers,
        body: init.body as BodyInit,
      });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        this._port = (this.server.address() as { port: number }).port;
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = this.server as http.Server & { closeAllConnections?: () => void };
      s.closeAllConnections?.();
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  reset(): void {
    this._generation++;
    this.queue.length = 0;
    this._bodies.length = 0;
  }
}

const CREDS = { keyId: "rzp_test_speclocal", secret: "spec-local-key-secret", webhookSecret: "spec-local-webhook-secret" };
const ORDER_200 = { id: "order_recovered123", amount: 10000, currency: "INR" };
const ERR_500 = { status: 500, body: { error: { description: "transient error" } } };
const ERR_422 = { status: 422, body: { error: { description: "bad request" } } };

describe("RazorpayAdapter — retry and recovery", () => {
  let server: FakeServer;

  beforeAll(async () => {
    server = new FakeServer();
    await server.listen();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.reset();
  });

  function makeRuntime(timeoutMs = 500) {
    const registry = new PaymentProviderAdapterRegistry();
    return new RazorpayAdapter(registry, {
      transport: server.makeTransport(),
      breaker: new ProviderCircuitBreaker(),
      orderTimeoutMs: timeoutMs,
      baseDelayMs: 1,
      maxDelayMs: 2,
    }).configure(CREDS);
  }

  it("a 5xx is retried and a subsequent 200 recovers — returns the parsed order", async () => {
    server.enqueue(ERR_500, { status: 200, body: ORDER_200 });
    const result = await makeRuntime().createOrder({ amount: "10000", currency: "INR", receipt: "rec-recovery" });
    expect(result.providerOrderId).toBe("order_recovered123");
    expect(server.requestCount).toBe(2);
  });

  it("the retry budget is bounded at exactly 3 attempts — server counts prove it, not elapsed time", async () => {
    server.enqueue(ERR_500, ERR_500, ERR_500);
    await expect(
      makeRuntime().createOrder({ amount: "10000", currency: "INR", receipt: "rec-budget" }),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(server.requestCount).toBe(3);
  });

  it("a 4xx is terminal — exactly one attempt, the 3-attempt budget is never consumed", async () => {
    server.enqueue(ERR_422);
    await expect(
      makeRuntime().createOrder({ amount: "10000", currency: "INR", receipt: "rec-terminal" }),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(server.requestCount).toBe(1);
  });

  it("a timeout is classified as retryable and exhausting the budget surfaces as BadGatewayException", async () => {
    let calls = 0;
    const delayingTransport: RazorpayTransport = async () => {
      calls++;
      await new Promise<void>((resolve) => setTimeout(resolve, 300).unref());
      return new Response("{}", { status: 200 });
    };
    const registry = new PaymentProviderAdapterRegistry();
    const runtime = new RazorpayAdapter(registry, {
      transport: delayingTransport,
      breaker: new ProviderCircuitBreaker(),
      orderTimeoutMs: 50,
      baseDelayMs: 1,
      maxDelayMs: 2,
    }).configure(CREDS);

    await expect(
      runtime.createOrder({ amount: "10000", currency: "INR", receipt: "rec-timeout" }),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(calls).toBe(3);
  });

  it("Part 2 — the caller-supplied receipt is sent unchanged on every retry (stable across retries)", async () => {
    server.enqueue(ERR_500, ERR_500, { status: 200, body: ORDER_200 });
    await makeRuntime().createOrder({ amount: "10000", currency: "INR", receipt: "stable-receipt-abc" });
    expect(server.requestCount).toBe(3);
    for (const bodyStr of server.requestBodies) {
      const body = JSON.parse(bodyStr) as Record<string, unknown>;
      expect(body["receipt"]).toBe("stable-receipt-abc");
    }
  });
});
