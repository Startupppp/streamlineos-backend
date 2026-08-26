/**
 * How the platform charges a tenant for their subscription.
 *
 * Distinct from `billing/payments/payment-provider-adapter.interface.ts`, which
 * is the tenant-facing system: an organisation connecting *its own* Razorpay or
 * Stripe account to charge *its* customers. That one already has an interface
 * and a registry. This one is the other direction -- us billing them -- and
 * until now it was a concrete `RazorpayService` injected directly into the
 * billing service and controller.
 *
 * The distinction matters because Phase 3's problem is only in this direction:
 * a prospect in Berlin cannot pay us, and if they could they would be quoted in
 * rupees. The tenant-facing side was already provider-agnostic.
 *
 * Extracted with no behaviour change. The second implementation arrives in
 * ticket 02; this exists so that when it does, no call site branches on which
 * provider is in use.
 */

/**
 * What a caller needs back to open checkout in the browser.
 *
 * Exactly the three fields the billing service reads today. A receipt and the
 * provider's raw response were on this interface briefly and are not here now:
 * nothing consumes them, and an interface that promises more than its one
 * implementation returns is a second thing to keep true for no benefit.
 */
export interface PlatformOrder {
  /** The provider's own identifier for the order or intent. */
  readonly id: string;
  /** Minor units, matching what was requested. */
  readonly amount: number;
  readonly currency: string;
}

export interface CreatePlatformOrderParams {
  /** Minor units. The platform stores paise and cents alike as integers. */
  readonly amount: number;
  readonly receipt: string;
  readonly notes: Record<string, string>;
  /**
   * ISO 4217, and required.
   *
   * It was briefly optional with an INR default, which is what ticket 01
   * inherited from a hardcoded literal in the request body. A default here is
   * the currency bug with a longer fuse: a caller that forgets charges rupees to
   * somebody who was quoted dollars, and nothing in the type says so.
   */
  readonly currency: string;
}

export interface PlatformPaymentProvider {
  /** Stable key stored on the subscription, so a charge is attributable later. */
  readonly providerKey: string;

  /** Whether credentials are present. False means this provider cannot be used. */
  isConfigured(): boolean;

  /**
   * The key the browser needs to open checkout.
   *
   * Every provider in this class has one -- Razorpay calls it a key id, Stripe a
   * publishable key -- and it is safe to expose, which is why it is on the
   * interface rather than behind a provider check at the call site.
   */
  getPublishableKey(): string | null;

  createOrder(params: CreatePlatformOrderParams): Promise<PlatformOrder>;

  verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean;

  verifyWebhookSignature(rawBody: string, signature: string): boolean;
}

/** Injection token, because an interface does not survive to runtime. */
export const PLATFORM_PAYMENT_PROVIDER = Symbol("PLATFORM_PAYMENT_PROVIDER");
