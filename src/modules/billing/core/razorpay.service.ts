import { HttpException, HttpStatus, Inject, Injectable } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env.validation";
import {
  razorpayFetchedOrderSchema,
  razorpayOrderErrorSchema,
  razorpayOrderSchema,
  type RazorpayFetchedOrder,
  type RazorpayOrder,
} from "./dto/billing.schemas";
import type {
  CreatePlatformOrderParams,
  PlatformPaymentProvider,
} from "./platform-payment-provider";

@Injectable()
export class RazorpayService implements PlatformPaymentProvider {
  readonly providerKey = "razorpay";

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private get keyId(): string | undefined {
    return this.config.RAZORPAY_KEY_ID;
  }

  private get keySecret(): string | undefined {
    return this.config.RAZORPAY_KEY_SECRET;
  }

  private get webhookSecret(): string | undefined {
    return this.config.RAZORPAY_WEBHOOK_SECRET;
  }

  isConfigured(): boolean {
    return Boolean(this.keyId && this.keySecret);
  }

  /** The key the browser needs to open checkout. */
  getPublishableKey(): string | null {
    return this.keyId ?? null;
  }

  async createOrder(params: CreatePlatformOrderParams): Promise<RazorpayOrder> {
    const auth = Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64");
    const response = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        amount: params.amount,
        currency: params.currency,
        receipt: params.receipt,
        notes: params.notes,
      }),
    });

    if (!response.ok) {
      const raw: unknown = await response.json().catch(() => ({}));
      const parsed = razorpayOrderErrorSchema.safeParse(raw);
      const description = parsed.success
        ? parsed.data.error?.description ?? "Unknown error"
        : "Unknown error";
      throw new HttpException(
        `Razorpay order creation failed: ${description}`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    const data: unknown = await response.json();
    return razorpayOrderSchema.parse(data);
  }

  /**
   * Reads an order back, so activation can learn what was charged.
   *
   * A failure here is deliberately fatal to the caller: the alternative is
   * trusting the browser for the plan and the period, which is precisely the
   * hole this closes. Better a customer retries a verify than gets a tier they
   * did not pay for.
   */
  async fetchOrder(orderId: string): Promise<RazorpayFetchedOrder> {
    const auth = Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64");
    const response = await fetch(
      `https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}`,
      { headers: { Authorization: `Basic ${auth}` } },
    );

    if (!response.ok) {
      throw new HttpException(
        `Razorpay order lookup failed for ${orderId}`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    const data: unknown = await response.json();
    return razorpayFetchedOrderSchema.parse(data);
  }

  verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean {
    const secret = this.keySecret;
    if (!secret) return false;
    const expected = createHmac("sha256", secret)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");
    return this.constantTimeEquals(expected, signature);
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    const secret = this.webhookSecret;
    if (!secret) return false;
    try {
      const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
      return this.constantTimeEquals(expected, signature);
    } catch {
      return false;
    }
  }

  private constantTimeEquals(expected: string, provided: string): boolean {
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(provided, "utf8");
    if (a.length !== b.length) return false;
    try {
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
}
