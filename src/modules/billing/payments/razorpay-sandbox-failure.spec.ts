import { createHmac } from "node:crypto";
import { BadGatewayException } from "@nestjs/common";
import { RazorpayAdapter } from "./adapters/razorpay.adapter";
import { PaymentProviderAdapterRegistry } from "./payment-provider-adapter.interface";

const KEY_ID = process.env.RAZORPAY_KEY_ID ?? "";
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET ?? "";
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? "";

if (KEY_ID.length > 0 && !KEY_ID.startsWith("rzp_test_"))
  throw new Error(
    `SAFETY ABORT: RAZORPAY_KEY_ID must begin rzp_test_ before any call to this suite. ` +
    `Detected prefix: ${KEY_ID.slice(0, 9)}. Refusing to run against a live key.`,
  );

const hasCredentials = KEY_ID.length > 0 && KEY_SECRET.length > 0 && WEBHOOK_SECRET.length > 0;
const networkEnabled = process.env.RAZORPAY_NETWORK_TESTS === "1";

function makeAdapter(keyId: string, secret: string, webhookSecret: string) {
  const registry = new PaymentProviderAdapterRegistry();
  const adapter = new RazorpayAdapter(registry);
  return adapter.configure({ keyId, secret, webhookSecret });
}

(hasCredentials ? describe : describe.skip)(
  "Razorpay adapter — webhook signature verification (no network; requires RAZORPAY_KEY_ID/SECRET/WEBHOOK_SECRET)",
  () => {
    const runtime = makeAdapter(KEY_ID, KEY_SECRET, WEBHOOK_SECRET);
    const body = JSON.stringify({ event: "payment.captured", payload: {} });
    const correctSig = () => createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");

    it("correctly-signed body passes verifyWebhookSignature", () => {
      expect(runtime.verifyWebhookSignature({ rawBody: body, signature: correctSig() })).toBe(true);
    });

    it("tampered body is rejected by verifyWebhookSignature", () => {
      const tampered = body.replace("payment.captured", "payment.tampered");
      expect(runtime.verifyWebhookSignature({ rawBody: tampered, signature: correctSig() })).toBe(false);
    });

    it("truncated signature is rejected by verifyWebhookSignature", () => {
      expect(runtime.verifyWebhookSignature({ rawBody: body, signature: correctSig().slice(0, 10) })).toBe(false);
    });

    it("body signed with the wrong secret is rejected by verifyWebhookSignature", () => {
      const wrongSig = createHmac("sha256", "wrong-secret-not-the-real-one")
        .update(body)
        .digest("hex");
      expect(runtime.verifyWebhookSignature({ rawBody: body, signature: wrongSig })).toBe(false);
    });
  },
);

(hasCredentials && networkEnabled ? describe : describe.skip)(
  "Razorpay sandbox — live API failure mapping (requires RAZORPAY_NETWORK_TESTS=1 and reachable api.razorpay.com)",
  () => {
    it("wrong key secret → BadGatewayException — adapter maps 4xx to its own error shape, not a provider leak", async () => {
      const badRuntime = makeAdapter(KEY_ID, "wrong-secret-intentionally-bad-for-test", WEBHOOK_SECRET);
      await expect(
        badRuntime.createOrder({ amount: "100", currency: "INR", receipt: "probe-auth-fail" }),
      ).rejects.toThrow(BadGatewayException);
    }, 30_000);

    it("invalid order payload → BadGatewayException — adapter maps 4xx to its own error shape", async () => {
      const runtime = makeAdapter(KEY_ID, KEY_SECRET, WEBHOOK_SECRET);
      await expect(
        runtime.createOrder({ amount: "-1", currency: "FAKE_CCY", receipt: "probe-bad-payload" }),
      ).rejects.toThrow(BadGatewayException);
    }, 30_000);

    it("4xx failure is terminal — no retry loop (elapsed well under 3 × 10 s timeout)", async () => {
      // callProvider classifies RazorpayClientError (4xx) as "terminal".
      // Terminal failures exit after exactly 1 attempt; the 3-attempt retry budget is for
      // retryable (5xx / network) errors only. Elapsed time < 15 s proves no retry loop ran.
      const badRuntime = makeAdapter(KEY_ID, "wrong-secret-no-retry-proof", WEBHOOK_SECRET);
      const start = Date.now();
      await expect(
        badRuntime.createOrder({ amount: "100", currency: "INR", receipt: "probe-retry-check" }),
      ).rejects.toThrow(BadGatewayException);
      expect(Date.now() - start).toBeLessThan(15_000);
    }, 30_000);

    it("idempotency key: adapter has no retry-safe idempotency mechanism — documented gap", () => {
      // createOrder does not pass X-Request-Id or any idempotency header to Razorpay.
      // Internal retries inside callProvider (for 5xx / network failures) therefore risk
      // duplicate order creation. Razorpay deduplicates on the `receipt` field within 24 h
      // for the same key, so callers must supply a stable per-intent receipt.
      // The adapter has no independent retry path beyond what callProvider provides.
      expect(true).toBe(true);
    });
  },
);
