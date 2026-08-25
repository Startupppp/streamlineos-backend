import type { PaymentProviderAdapter, PaymentWebhookNormalization } from "../payment-provider-adapter.interface";

export const FAKE_WEBHOOK_SECRET = "fake-webhook-secret-at-least-32chars";
export const FAKE_VALID_WEBHOOK_SIG = "fake-valid-webhook-signature";
export const FAKE_VALID_PAYMENT_SIG = "fake-valid-payment-signature";
export const FAKE_PROVIDER_ORDER_ID = "fake_order_001";
export const FAKE_PUBLIC_KEY_ID = "fake_pub_key_001";

export class FakeProviderAdapter implements PaymentProviderAdapter {
  constructor(readonly providerKey: string = "razorpay") {}

  isReady(): boolean {
    return true;
  }

  publicKeyId(): string {
    return FAKE_PUBLIC_KEY_ID;
  }

  async createOrder(_params: {
    keyId: string;
    keySecret: string;
    amount: string;
    currency: string;
    receipt: string;
    notes?: Record<string, string>;
  }): Promise<{ providerOrderId: string; raw: unknown }> {
    return { providerOrderId: FAKE_PROVIDER_ORDER_ID, raw: {} };
  }

  verifyPaymentSignature(params: {
    orderId: string;
    paymentId: string;
    signature: string;
    keySecret: string;
  }): boolean {
    return params.signature === FAKE_VALID_PAYMENT_SIG;
  }

  verifyWebhookSignature(params: {
    rawBody: string;
    signature: string;
    webhookSecret: string;
  }): boolean {
    return (
      params.signature === FAKE_VALID_WEBHOOK_SIG &&
      params.webhookSecret === FAKE_WEBHOOK_SECRET
    );
  }

  normalizeWebhook(rawBody: string): PaymentWebhookNormalization {
    try {
      const raw = JSON.parse(rawBody) as { event?: unknown; payload?: unknown };
      if (typeof raw.event !== "string" || !raw.payload || typeof raw.payload !== "object") {
        return { ok: false, error: "invalid_payload" };
      }
      return { ok: true, eventType: raw.event, payload: raw.payload as Record<string, unknown> };
    } catch {
      return { ok: false, error: "invalid_json" };
    }
  }
}
