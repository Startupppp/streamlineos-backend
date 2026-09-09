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
 * Receipts support reconciliation; they do not prove idempotent replay.
 * Ambiguous order creation failures must not be retried automatically.
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
        body: typeof init.body === "string" ? init.body : undefined,
      });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        const address = this.server.address();
        if (!address || typeof address === "string") throw new Error("Missing test server port");
        this._port = address.port;
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.closeAllConnections();
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

describe("RazorpayAdapter — failure and recovery without automatic order replay", () => {
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

  function makeRuntime(timeoutMs = 2000) {
    const registry = new PaymentProviderAdapterRegistry();
    return new RazorpayAdapter(registry, {
      transport: server.makeTransport(),
      breaker: new ProviderCircuitBreaker(),
      orderTimeoutMs: timeoutMs,
      baseDelayMs: 1,
      maxDelayMs: 2,
    }).configure(CREDS);
  }

  it("a 5xx fails once and a later independent order succeeds after recovery", async () => {
    server.enqueue(ERR_500, { status: 200, body: ORDER_200 });
    const runtime = makeRuntime();
    await expect(runtime.createOrder({ amount: "10000", currency: "INR", receipt: "rec-failed" }))
      .rejects.toBeInstanceOf(BadGatewayException);
    expect(server.requestCount).toBe(1);
    const result = await runtime.createOrder({ amount: "10000", currency: "INR", receipt: "rec-recovery" });
    expect(result.providerOrderId).toBe("order_recovered123");
    expect(server.requestCount).toBe(2);
  });

  it("an ambiguous 5xx is not replayed", async () => {
    server.enqueue(ERR_500, ERR_500, ERR_500);
    await expect(
      makeRuntime().createOrder({ amount: "10000", currency: "INR", receipt: "rec-budget" }),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(server.requestCount).toBe(1);
  });

  it("a 4xx is terminal after exactly one attempt", async () => {
    server.enqueue(ERR_422);
    await expect(
      makeRuntime().createOrder({ amount: "10000", currency: "INR", receipt: "rec-terminal" }),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(server.requestCount).toBe(1);
  });

  it("a timeout surfaces as BadGatewayException without replaying the in-flight order", async () => {
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
    expect(calls).toBe(1);
  });

  it("the caller-supplied receipt is preserved for reconciliation", async () => {
    server.enqueue({ status: 200, body: ORDER_200 });
    await makeRuntime().createOrder({ amount: "10000", currency: "INR", receipt: "stable-receipt-abc" });
    expect(server.requestCount).toBe(1);
    for (const bodyStr of server.requestBodies) {
      expect(JSON.parse(bodyStr)).toMatchObject({ receipt: "stable-receipt-abc" });
    }
  });
});
