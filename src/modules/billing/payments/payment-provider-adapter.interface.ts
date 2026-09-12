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

export interface ProviderPaymentSnapshot {
  readonly paymentId: string;
  readonly orderId: string | null;
  readonly status: "created" | "authorized" | "captured" | "refunded" | "failed";
  readonly amountMinor: number;
  readonly currency: string;
}

/** The configured provider runtime. Credential values are intentionally absent. */
export interface PaymentProviderRuntime {
  isReady(): boolean;
  publicKeyId(): string | null;
  createOrder(params: {
    amount: string;
    currency: string;
    receipt: string;
    notes?: Record<string, string>;
  }): Promise<{ providerOrderId: string; raw: unknown }>;
  verifyPaymentSignature(params: { orderId: string; paymentId: string; signature: string }): boolean;
  verifyWebhookSignature(params: { rawBody: string; signature: string }): boolean;
  normalizeWebhook(rawBody: string): PaymentWebhookNormalization;
  fetchPayment(paymentId: string): Promise<ProviderPaymentSnapshot | null>;
}

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
   * Binds decrypted provider configuration inside the concrete adapter. The value is opaque
   * here: generic billing code cannot name, inspect, or forward provider secret fields.
   */
  configure(credentials: unknown): PaymentProviderRuntime;

  /**
   * Converts a provider's raw webhook into the small provider-neutral shape used by billing.
   * Parsing and provider-specific envelope knowledge stay in the adapter; callers never need
   * to know whether an event was nested under `payload`, `data`, or another provider envelope.
   */
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
