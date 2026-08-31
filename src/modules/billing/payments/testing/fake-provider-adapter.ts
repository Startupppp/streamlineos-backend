import type { PaymentProviderAdapter, PaymentProviderRuntime, PaymentWebhookNormalization } from "../payment-provider-adapter.interface";

export const FAKE_WEBHOOK_SECRET = "fake-webhook-secret-at-least-32chars";
export const FAKE_VALID_WEBHOOK_SIG = "fake-valid-webhook-signature";
export const FAKE_VALID_PAYMENT_SIG = "fake-valid-payment-signature";
export const FAKE_PROVIDER_ORDER_ID = "fake_order_001";
export const FAKE_PUBLIC_KEY_ID = "fake_pub_key_001";

export class FakeProviderAdapter implements PaymentProviderAdapter {
  constructor(readonly providerKey: string = "razorpay") {}

  configure(_credentials: unknown): PaymentProviderRuntime {
    const credentials = _credentials && typeof _credentials === "object" ? _credentials as { keyId?: unknown; secret?: unknown; webhookSecret?: unknown } : {};
    const keyId = typeof credentials.keyId === "string" ? credentials.keyId : FAKE_PUBLIC_KEY_ID;
    const hasSecret = typeof credentials.secret === "string" || typeof credentials.webhookSecret === "string";
    return {
      isReady: () => hasSecret,
      publicKeyId: () => keyId,
      createOrder: async (_params: {
    amount: string;
    currency: string;
    receipt: string;
    notes?: Record<string, string>;
      }): Promise<{ providerOrderId: string; raw: unknown }> => ({ providerOrderId: FAKE_PROVIDER_ORDER_ID, raw: {} }),

      verifyPaymentSignature: (params: {
    orderId: string;
    paymentId: string;
    signature: string;
      }): boolean => {
    return params.signature === FAKE_VALID_PAYMENT_SIG;
      },

      verifyWebhookSignature: (params: {
    rawBody: string;
    signature: string;
      }): boolean => {
    return (
      params.signature === FAKE_VALID_WEBHOOK_SIG &&
      credentials.webhookSecret === FAKE_WEBHOOK_SECRET
    );
      },

      normalizeWebhook: (rawBody): PaymentWebhookNormalization => {
    try {
      const raw = JSON.parse(rawBody) as { event?: unknown; payload?: unknown };
      if (typeof raw.event !== "string" || !raw.payload || typeof raw.payload !== "object") {
        return { ok: false, error: "invalid_payload" };
      }
      const payload = raw.payload as Record<string, unknown>;
      const payment = payload.payment;
      const entity = payment && typeof payment === "object" && "entity" in payment
        ? (payment as { entity?: unknown }).entity
        : undefined;
      if (!entity || typeof entity !== "object") {
        return { ok: true, eventType: raw.event, payload };
      }
      const value = entity as Record<string, unknown>;
      const normalizedEntity = Object.fromEntries(
        Object.entries({
          id: value.id,
          orderId: value.order_id,
          amount: value.amount,
          fee: value.fee,
          currency: value.currency,
          status: value.status,
          method: value.method,
          email: value.email,
          description: value.description,
          notes: value.notes,
          invoiceId: value.invoice_id,
          createdAt: value.created_at,
        }).filter(([, entry]) => entry !== undefined),
      );
      return { ok: true, eventType: raw.event, payload: { ...payload, payment: { entity: normalizedEntity } } };
    } catch {
      return { ok: false, error: "invalid_json" };
    }
      },
    };
  }

  // Concrete fake-provider compatibility helpers; the provider-neutral interface exposes configure().
  isReady(): boolean { return this.configure({ secret: "fake" }).isReady(); }
  publicKeyId(): string { return this.configure({}).publicKeyId() ?? FAKE_PUBLIC_KEY_ID; }
  createOrder(params: { keyId: string; keySecret: string; amount: string; currency: string; receipt: string; notes?: Record<string, string> }) {
    return this.configure({ keyId: params.keyId, secret: params.keySecret }).createOrder(params);
  }
  verifyPaymentSignature(params: { orderId: string; paymentId: string; signature: string; keySecret: string }): boolean {
    return this.configure({ secret: params.keySecret }).verifyPaymentSignature(params);
  }
  verifyWebhookSignature(params: { rawBody: string; signature: string; webhookSecret: string }): boolean {
    return this.configure({ webhookSecret: params.webhookSecret }).verifyWebhookSignature(params);
  }
  normalizeWebhook(rawBody: string): PaymentWebhookNormalization { return this.configure(null).normalizeWebhook(rawBody); }
}
