import { createHmac } from "node:crypto";
import { RazorpayAdapter } from "./adapters/razorpay.adapter";
import { PaymentProviderAdapterRegistry } from "./payment-provider-adapter.interface";

/**
 * Signature verification, with no dependency on the environment.
 *
 * These used to be skipped unless RAZORPAY_KEY_ID/SECRET/WEBHOOK_SECRET were set, which
 * made the strongest half of the Razorpay proof optional and put two more entries in the
 * conditional-suppression class that `check:test-suppressions` caps. Nothing here needs
 * the real credentials: the adapter is configured with a secret this file chooses, so the
 * suite is deterministic, always runs, and asserts the same property.
 *
 * The live sandbox half is not a test. It needs a reachable api.razorpay.com and real
 * test-mode keys, so it lives where this repo puts every other externally-gated check —
 * a script with a self-test: `pnpm verify:razorpay-sandbox`.
 */
const WEBHOOK_SECRET = "spec-local-webhook-secret-not-from-the-environment";

function makeRuntime() {
  const registry = new PaymentProviderAdapterRegistry();
  const adapter = new RazorpayAdapter(registry);
  return adapter.configure({
    keyId: "rzp_test_speclocal",
    secret: "spec-local-key-secret",
    webhookSecret: WEBHOOK_SECRET,
  });
}

describe("Razorpay adapter — webhook signature verification", () => {
  const runtime = makeRuntime();
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
    const wrongSig = createHmac("sha256", "wrong-secret-not-the-real-one").update(body).digest("hex");
    expect(runtime.verifyWebhookSignature({ rawBody: body, signature: wrongSig })).toBe(false);
  });

  it("an empty signature is rejected rather than treated as absent", () => {
    expect(runtime.verifyWebhookSignature({ rawBody: body, signature: "" })).toBe(false);
  });
});
