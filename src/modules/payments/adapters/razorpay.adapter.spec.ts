import { createHmac } from "node:crypto";
import { RazorpayAdapter } from "./razorpay.adapter";
import { PaymentProviderAdapterRegistry } from "../payment-provider-adapter.interface";

describe("RazorpayAdapter", () => {
  const adapter = new RazorpayAdapter(new PaymentProviderAdapterRegistry());

  describe("validateCredentialFormat", () => {
    it("accepts a test key in the test environment", () => {
      expect(adapter.validateCredentialFormat("test", "rzp_test_abc123")).toBeNull();
    });

    it("accepts a live key in the live environment", () => {
      expect(adapter.validateCredentialFormat("live", "rzp_live_abc123")).toBeNull();
    });

    it("flags a live key saved as a test credential", () => {
      const warning = adapter.validateCredentialFormat("test", "rzp_live_abc123");
      expect(warning?.code).toBe("live_key_in_test_environment");
    });

    it("flags a test key saved as a live credential", () => {
      const warning = adapter.validateCredentialFormat("live", "rzp_test_abc123");
      expect(warning?.code).toBe("test_key_in_live_environment");
    });

    it("flags a key with no recognizable Razorpay prefix", () => {
      const warning = adapter.validateCredentialFormat("test", "sk_test_notrazorpay");
      expect(warning?.code).toBe("unrecognized_key_format");
    });
  });

  describe("verifyPaymentSignature", () => {
    const keySecret = "test_secret_123";
    const orderId = "order_abc";
    const paymentId = "pay_xyz";

    function sign(orderId: string, paymentId: string, secret: string): string {
      return createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
    }

    it("accepts a correctly signed payment", () => {
      const signature = sign(orderId, paymentId, keySecret);
      expect(adapter.verifyPaymentSignature({ orderId, paymentId, signature, keySecret })).toBe(true);
    });

    it("rejects a signature signed with the wrong secret", () => {
      const signature = sign(orderId, paymentId, "wrong_secret");
      expect(adapter.verifyPaymentSignature({ orderId, paymentId, signature, keySecret })).toBe(false);
    });

    it("rejects a signature for a different order/payment pair", () => {
      const signature = sign(orderId, "different_payment", keySecret);
      expect(adapter.verifyPaymentSignature({ orderId, paymentId, signature, keySecret })).toBe(false);
    });

    it("rejects garbage input without throwing", () => {
      expect(adapter.verifyPaymentSignature({ orderId, paymentId, signature: "not-hex-at-all", keySecret })).toBe(false);
    });
  });

  describe("verifyWebhookSignature", () => {
    const webhookSecret = "webhook_secret_456";
    const rawBody = JSON.stringify({ event: "payment.captured", payload: {} });

    function sign(body: string, secret: string): string {
      return createHmac("sha256", secret).update(body).digest("hex");
    }

    it("accepts a correctly signed webhook body", () => {
      const signature = sign(rawBody, webhookSecret);
      expect(adapter.verifyWebhookSignature({ rawBody, signature, webhookSecret })).toBe(true);
    });

    it("rejects a tampered body", () => {
      const signature = sign(rawBody, webhookSecret);
      const tamperedBody = JSON.stringify({ event: "payment.captured", payload: { tampered: true } });
      expect(adapter.verifyWebhookSignature({ rawBody: tamperedBody, signature, webhookSecret })).toBe(false);
    });

    it("rejects a signature signed with the wrong webhook secret", () => {
      const signature = sign(rawBody, "wrong_webhook_secret");
      expect(adapter.verifyWebhookSignature({ rawBody, signature, webhookSecret })).toBe(false);
    });

    it("returns false instead of throwing on malformed signature input", () => {
      expect(adapter.verifyWebhookSignature({ rawBody, signature: "", webhookSecret })).toBe(false);
    });
  });
});
