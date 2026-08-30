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
      expect(adapter.configure({ secret: keySecret }).verifyPaymentSignature({ orderId, paymentId, signature })).toBe(true);
    });

    it("rejects a signature signed with the wrong secret", () => {
      const signature = sign(orderId, paymentId, "wrong_secret");
      expect(adapter.configure({ secret: keySecret }).verifyPaymentSignature({ orderId, paymentId, signature })).toBe(false);
    });

    it("rejects a signature for a different order/payment pair", () => {
      const signature = sign(orderId, "different_payment", keySecret);
      expect(adapter.configure({ secret: keySecret }).verifyPaymentSignature({ orderId, paymentId, signature })).toBe(false);
    });

    it("rejects garbage input without throwing", () => {
      expect(adapter.configure({ secret: keySecret }).verifyPaymentSignature({ orderId, paymentId, signature: "not-hex-at-all" })).toBe(false);
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
      expect(adapter.configure({ webhookSecret }).verifyWebhookSignature({ rawBody, signature })).toBe(true);
    });

    it("rejects a tampered body", () => {
      const signature = sign(rawBody, webhookSecret);
      const tamperedBody = JSON.stringify({ event: "payment.captured", payload: { tampered: true } });
      expect(adapter.configure({ webhookSecret }).verifyWebhookSignature({ rawBody: tamperedBody, signature })).toBe(false);
    });

    it("rejects a signature signed with the wrong webhook secret", () => {
      const signature = sign(rawBody, "wrong_webhook_secret");
      expect(adapter.configure({ webhookSecret }).verifyWebhookSignature({ rawBody, signature })).toBe(false);
    });

    it("returns false instead of throwing on malformed signature input", () => {
      expect(adapter.configure({ webhookSecret }).verifyWebhookSignature({ rawBody, signature: "" })).toBe(false);
    });
  });

  describe("normalizeWebhook", () => {
    it("maps provider field names to the neutral billing payment contract", () => {
      const result = adapter.configure({}).normalizeWebhook(JSON.stringify({
        id: "evt_456",
        event: "payment.captured",
        payload: {
          payment: {
            entity: {
              id: "pay_456",
              order_id: "order_456",
              amount: 2500,
              fee: 50,
              currency: "INR",
              status: "captured",
              invoice_id: "inv_456",
              created_at: 1_700_000_000,
            },
          },
        },
      }));

      expect(result).toEqual({
        ok: true,
        eventType: "payment.captured",
        providerEventId: "evt_456",
        payload: {
          payment: {
            entity: {
              id: "pay_456",
              orderId: "order_456",
              amount: 2500,
              fee: 50,
              currency: "INR",
              status: "captured",
              invoiceId: "inv_456",
              createdAt: 1_700_000_000,
            },
          },
        },
      });
    });

    it("returns a provider-neutral event without exposing credential fields", () => {
      const result = adapter.configure({}).normalizeWebhook(JSON.stringify({
        id: "evt_123",
        event: "payment.captured",
        payload: { payment: { entity: { id: "pay_123", amount: 100 } } },
      }));

      expect(result).toEqual({
        ok: true,
        eventType: "payment.captured",
        providerEventId: "evt_123",
        payload: { payment: { entity: { id: "pay_123", amount: 100 } } },
      });
      expect(JSON.stringify(result)).not.toContain("secret");
    });

    it("distinguishes malformed JSON from an invalid provider envelope", () => {
      expect(adapter.configure({}).normalizeWebhook("not-json")).toEqual({ ok: false, error: "invalid_json" });
      expect(adapter.configure({}).normalizeWebhook(JSON.stringify({ payload: {} }))).toEqual({
        ok: false,
        error: "invalid_payload",
      });
    });
  });
});
