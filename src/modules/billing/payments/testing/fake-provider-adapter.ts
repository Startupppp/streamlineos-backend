import { z } from "zod";
import type { PaymentProviderAdapter, PaymentProviderRuntime, PaymentWebhookNormalization } from "../payment-provider-adapter.interface";
import { rawWebhookIdSchema, rawPaymentEntitySchema, tenantCredentialFieldsSchema } from "../dto/webhook.schemas";

const fakeEnvelopeSchema = z.object({
  event: z.string(),
  payload: z.record(z.string(), z.unknown()),
});

export const FAKE_WEBHOOK_SECRET = "fake-webhook-secret-at-least-32chars";
export const FAKE_VALID_WEBHOOK_SIG = "fake-valid-webhook-signature";
export const FAKE_VALID_PAYMENT_SIG = "fake-valid-payment-signature";
export const FAKE_PROVIDER_ORDER_ID = "fake_order_001";
export const FAKE_PUBLIC_KEY_ID = "fake_pub_key_001";

export class FakeProviderAdapter implements PaymentProviderAdapter {
  constructor(readonly providerKey: string = "razorpay") {}

  configure(_credentials: unknown): PaymentProviderRuntime {
    const parsedCredentials = tenantCredentialFieldsSchema.safeParse(_credentials);
    const credentials = parsedCredentials.success ? parsedCredentials.data : {};
    const keyId = credentials.keyId ?? FAKE_PUBLIC_KEY_ID;
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
      const raw: unknown = JSON.parse(rawBody);
      const parsedEnvelope = fakeEnvelopeSchema.safeParse(raw);
      if (!parsedEnvelope.success) {
        return { ok: false, error: "invalid_payload" };
      }
      const parsedId = rawWebhookIdSchema.safeParse(raw);
      const providerEventId = parsedId.success ? parsedId.data.id : undefined;
      const payload = parsedEnvelope.data.payload;
      const payment = payload.payment;
      const entity = payment && typeof payment === "object" && "entity" in payment
        ? payment.entity
        : undefined;
      const entityParsed = entity && typeof entity === "object" ? rawPaymentEntitySchema.safeParse(entity) : null;
      if (!entityParsed?.success) {
        return { ok: true, eventType: parsedEnvelope.data.event, payload, providerEventId };
      }
      const normalizedEntity = Object.fromEntries(
        Object.entries({
          id: entityParsed.data.id,
          orderId: entityParsed.data.order_id,
          amount: entityParsed.data.amount,
          fee: entityParsed.data.fee,
          currency: entityParsed.data.currency,
          status: entityParsed.data.status,
          method: entityParsed.data.method,
          email: entityParsed.data.email,
          description: entityParsed.data.description,
          notes: entityParsed.data.notes,
          invoiceId: entityParsed.data.invoice_id,
          createdAt: entityParsed.data.created_at,
        }).filter(([, entry]) => entry !== undefined),
      );
      return {
        ok: true,
        eventType: parsedEnvelope.data.event,
        payload: { ...payload, payment: { entity: normalizedEntity } },
        providerEventId,
      };
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
