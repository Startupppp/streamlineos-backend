import { Injectable } from "@nestjs/common";

export interface PaymentCredentialWarning {
  code: string;
  message: string;
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

  createOrder(params: {
    orgId: string;
    environment: "test" | "live";
    amount: string;
    currency: string;
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
