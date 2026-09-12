import type {
  CreatePlatformOrderParams,
  PlatformOrder,
  PlatformOrderRecord,
  PlatformPaymentProvider,
} from "../platform-payment-provider";
import { PlatformPaymentRegistry } from "../platform-payment-registry";

/**
 * A platform gateway with no network behind it.
 *
 * Deliberately paired with the REAL `PlatformPaymentRegistry` rather than a
 * stand-in for it: the currency-to-provider rule and its "was this the preferred
 * one" answer are the things under test at most of these call sites, and a double
 * for the registry would be a second implementation of them that agrees with
 * itself. Only the HTTP call is fake.
 */
export const FAKE_PLATFORM_PUBLIC_KEY = "platform_pub_key_001";
export const FAKE_PLATFORM_ORDER_ID = "order_platform_001";
export const FAKE_PLATFORM_PAYMENT_SIG = "platform-valid-payment-signature";
export const FAKE_PLATFORM_WEBHOOK_SIG = "platform-valid-webhook-signature";

export class FakePlatformProvider implements PlatformPaymentProvider {
  /** Everything that would have reached the gateway, in order. */
  readonly created: CreatePlatformOrderParams[] = [];

  constructor(
    readonly providerKey: string,
    private readonly configured: boolean,
  ) {}

  isConfigured(): boolean {
    return this.configured;
  }

  getPublishableKey(): string | null {
    return this.configured ? FAKE_PLATFORM_PUBLIC_KEY : null;
  }

  createOrder(params: CreatePlatformOrderParams): Promise<PlatformOrder> {
    this.created.push(params);
    return Promise.resolve({
      id: FAKE_PLATFORM_ORDER_ID,
      amount: params.amount,
      currency: params.currency,
    });
  }

  fetchOrder(orderId: string): Promise<PlatformOrderRecord> {
    const order = this.created[this.created.length - 1];
    return Promise.resolve({
      id: orderId,
      amount: order?.amount ?? 0,
      currency: order?.currency ?? "INR",
      status: "paid",
      notes: order?.notes ?? {},
    });
  }

  verifyPaymentSignature(_orderId: string, _paymentId: string, signature: string): boolean {
    return this.configured && signature === FAKE_PLATFORM_PAYMENT_SIG;
  }

  verifyWebhookSignature(_rawBody: string, signature: string): boolean {
    return this.configured && signature === FAKE_PLATFORM_WEBHOOK_SIG;
  }
}

export interface FakePlatformRegistry {
  readonly registry: PlatformPaymentRegistry;
  readonly razorpay: FakePlatformProvider;
  readonly stripe: FakePlatformProvider;
}

/** Razorpay-only by default, which is the deployment every existing spec assumed. */
export function fakePlatformRegistry(
  available: { razorpay?: boolean; stripe?: boolean } = {},
): FakePlatformRegistry {
  const razorpay = new FakePlatformProvider("razorpay", available.razorpay ?? true);
  const stripe = new FakePlatformProvider("stripe", available.stripe ?? false);
  return { registry: new PlatformPaymentRegistry(razorpay, stripe), razorpay, stripe };
}
