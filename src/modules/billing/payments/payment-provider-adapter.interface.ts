import { Injectable } from "@nestjs/common";

export interface PaymentCredentialWarning {
  code: string;
  message: string;
}

export type PaymentWebhookNormalization =
  | {
      ok: true;
      eventType: string;
      payload: Record<string, unknown>;
      providerEventId?: string;
    }
  | {
      ok: false;
      error: "invalid_json" | "invalid_payload";
    };

/**
 * Provider-specific behavior lives behind this interface so PaymentProviderSetupService,
 * webhook handling, and test transactions stay provider-agnostic. RazorpayAdapter is the first
 * implementation; Stripe/others register the same shape later without touching call sites.
 */
export interface PaymentProviderAdapter {
  readonly providerKey: string;

  /** Cheap, synchronous sanity check (e.g. key-prefix format) — not a live API call. */
  validateCredentialFormat?(environment: "test" | "live", keyId: string): PaymentCredentialWarning | null;

  /**
   * Returns true when the provider has the credentials it needs to process payments.
   * Used by callers that need to gate flows on provider availability without knowing
   * which provider or which specific credential is missing.
   */
  isReady(): boolean;

  /**
   * Returns the public key the browser must present to the provider to open the checkout
   * UI (e.g. Razorpay's key_id), or null when the provider is not configured.
   * This is the only piece of provider identity that legitimately crosses the seam:
   * the key is public by design and the browser cannot open checkout without it.
   * The private key and webhook secret never cross this boundary.
   */
  publicKeyId(): string | null;

  createOrder(params: {
    keyId: string;
    keySecret: string;
    amount: string;
    currency: string;
    receipt: string;
    notes?: Record<string, string>;
  }): Promise<{ providerOrderId: string; raw: unknown }>;

  verifyPaymentSignature(params: {
    orderId: string;
    paymentId: string;
    signature: string;
    keySecret: string;
  }): boolean;

  verifyWebhookSignature(params: {
    rawBody: string;
    signature: string;
    webhookSecret: string;
  }): boolean;

  /**
   * Converts a provider's raw webhook into the small provider-neutral shape used by billing.
   * Parsing and provider-specific envelope knowledge stay in the adapter; callers never need
   * to know whether an event was nested under `payload`, `data`, or another provider envelope.
   */
  normalizeWebhook(rawBody: string): PaymentWebhookNormalization;
}

@Injectable()
export class PaymentProviderAdapterRegistry {
  private readonly adapters = new Map<string, PaymentProviderAdapter>();

  register(adapter: PaymentProviderAdapter): void {
    this.adapters.set(adapter.providerKey, adapter);
  }

  get(providerKey: string): PaymentProviderAdapter | undefined {
    return this.adapters.get(providerKey);
  }
}
