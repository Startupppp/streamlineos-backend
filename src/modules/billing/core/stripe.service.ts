import { HttpException, HttpStatus, Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env.validation";
import {
  stripeErrorSchema,
  stripeFetchedIntentSchema,
  stripePaymentIntentSchema,
} from "./dto/billing.schemas";
import {
  PLATFORM_PAYMENT_TIMEOUT_MS,
  type CreatePlatformOrderParams,
  type PlatformOrder,
  type PlatformOrderRecord,
  type PlatformPaymentProvider,
} from "./platform-payment-provider";
import { verifyStripeWebhook } from "./stripe-signature";

/**
 * The second provider, which is the whole point of ticket 01's interface.
 *
 * Razorpay serves India, which is the largest existing market and is not going
 * anywhere. This serves everywhere else: a prospect in Berlin or Chicago could
 * not give us money at all, and if they could they would have been quoted in
 * rupees.
 *
 * Written against Stripe's HTTP API rather than the SDK, deliberately and for
 * the same reason the ingress adapters are: this phase's rule is that payment
 * providers are exercised from **fixtures**, and a mocked SDK tests only that
 * the mock agrees with itself. The surface used here is four fields of one
 * endpoint plus a signature scheme, which is a great deal less than a dependency
 * that ships its own version of every type in the platform.
 */
@Injectable()
export class StripeService implements PlatformPaymentProvider {
  readonly providerKey = "stripe";

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private get secretKey(): string | undefined {
    return this.config.STRIPE_SECRET_KEY;
  }

  private get webhookSecret(): string | undefined {
    return this.config.STRIPE_WEBHOOK_SECRET;
  }

  isConfigured(): boolean {
    return Boolean(this.secretKey && this.config.STRIPE_PUBLISHABLE_KEY);
  }

  getPublishableKey(): string | null {
    return this.config.STRIPE_PUBLISHABLE_KEY ?? null;
  }

  /**
   * A PaymentIntent, which is Stripe's nearest thing to a Razorpay order.
   *
   * The idempotency key is the receipt. A retried create must not produce a
   * second intent -- and this path is reached from a durable workflow that
   * retries on any transport failure, so "the request timed out but the charge
   * went through" is the ordinary case rather than the exotic one.
   */
  async createOrder(params: CreatePlatformOrderParams): Promise<PlatformOrder> {
    if (!this.secretKey) {
      throw new HttpException(
        "Stripe is not configured on this deployment.",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    /**
     * Form encoding, because that is what Stripe's API takes.
     *
     * Notes become `metadata[key]`, which is where Stripe keeps the same
     * arbitrary pairs Razorpay calls notes -- so the caller passes one shape and
     * neither provider leaks its vocabulary upward.
     */
    const body = new URLSearchParams({
      amount: String(params.amount),
      // Stripe wants lowercase; the platform holds ISO 4217 in upper.
      currency: params.currency.toLowerCase(),
      "automatic_payment_methods[enabled]": "true",
    });
    for (const [key, value] of Object.entries(params.notes)) {
      body.set(`metadata[${key}]`, value);
    }
    body.set("metadata[receipt]", params.receipt);

    const response = await fetch("https://api.stripe.com/v1/payment_intents", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": params.receipt,
      },
      body,
      signal: AbortSignal.timeout(PLATFORM_PAYMENT_TIMEOUT_MS),
    });

    if (!response.ok) {
      const raw: unknown = await response.json().catch(() => ({}));
      const parsed = stripeErrorSchema.safeParse(raw);
      const message = parsed.success
        ? (parsed.data.error?.message ?? "Unknown error")
        : "Unknown error";
      throw new HttpException(
        `Stripe payment intent creation failed: ${message}`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    const data: unknown = await response.json();
    const intent = stripePaymentIntentSchema.parse(data);

    return {
      id: intent.id,
      amount: intent.amount,
      // Normalised back on the way out, so a row written from Stripe and one
      // written from Razorpay hold the same string for the same currency.
      currency: intent.currency.toUpperCase(),
    };
  }

  /**
   * Stripe has no client-side payment signature to verify.
   *
   * Razorpay hands the browser an `order|payment` HMAC that the server checks on
   * return. Stripe's equivalent confirmation is the webhook, which is signed and
   * verified below -- so returning false here is not a stub, it is the honest
   * answer: **there is no client signature, and treating its absence as success
   * would accept an unverified return.**
   *
   * Callers must therefore confirm a Stripe payment from the webhook, which is
   * the safer of the two flows in any case: a browser that never comes back
   * still credits the subscription.
   */

  /**
   * Reads a payment intent back, so activation can learn what was charged.
   *
   * `metadata` is Stripe's word for what Razorpay calls notes; both are returned
   * verbatim, so the caller reads the terms of the sale the same way whichever
   * provider took the money.
   */
  async fetchOrder(orderId: string): Promise<PlatformOrderRecord> {
    if (!this.secretKey) {
      throw new HttpException(
        "Stripe is not configured on this deployment.",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const response = await fetch(
      `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(orderId)}`,
      {
        headers: { Authorization: `Bearer ${this.secretKey}` },
        signal: AbortSignal.timeout(PLATFORM_PAYMENT_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      throw new HttpException(
        `Stripe payment intent lookup failed for ${orderId}`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    const data: unknown = await response.json();
    const intent = stripeFetchedIntentSchema.parse(data);

    return {
      id: intent.id,
      amount: intent.amount,
      currency: intent.currency.toUpperCase(),
      status: intent.status,
      notes: intent.metadata,
    };
  }

  verifyPaymentSignature(): boolean {
    return false;
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    const secret = this.webhookSecret;
    if (!secret) return false;

    return verifyStripeWebhook({
      rawBody,
      header: signature,
      secret,
      now: Math.floor(Date.now() / 1000),
    });
  }
}
