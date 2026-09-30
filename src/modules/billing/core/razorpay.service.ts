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
import {
  PLATFORM_PAYMENT_TIMEOUT_MS,
  type CreatePlatformOrderParams,
  type PlatformPaymentProvider,
} from "./platform-payment-provider";
import {
  PlatformProviderHttpError,
  callPlatformProvider,
} from "./platform-provider-outbound";

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
    if (!this.keyId || !this.keySecret) {
      throw new HttpException(
        "Razorpay is not configured on this deployment.",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const auth = Buffer.from(`${this.keyId}:${this.keySecret}`).toString(
      "base64",
    );
    const result = await callPlatformProvider(
      {
        provider: this.providerKey,
        operation: "create-order",
        safety: { kind: "write" },
        timeoutMs: PLATFORM_PAYMENT_TIMEOUT_MS,
      },
      async () => {
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
          signal: AbortSignal.timeout(PLATFORM_PAYMENT_TIMEOUT_MS),
        });

        if (!response.ok) {
          const raw: unknown = await response.json().catch(() => ({}));
          const parsed = razorpayOrderErrorSchema.safeParse(raw);
          const internalMessage = parsed.success
            ? (parsed.data.error?.description ?? "Unknown provider error")
            : "Unknown provider error";
          throw new PlatformProviderHttpError(response.status, internalMessage);
        }

        const data: unknown = await response.json();
        return razorpayOrderSchema.parse(data);
      },
    );
    return result.value;
  }

  async fetchOrder(orderId: string): Promise<RazorpayFetchedOrder> {
    if (!this.keyId || !this.keySecret) {
      throw new HttpException(
        "Razorpay is not configured on this deployment.",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const auth = Buffer.from(`${this.keyId}:${this.keySecret}`).toString(
      "base64",
    );
    const result = await callPlatformProvider(
      {
        provider: this.providerKey,
        operation: "fetch-order",
        safety: { kind: "read" },
        timeoutMs: PLATFORM_PAYMENT_TIMEOUT_MS,
      },
      async () => {
        const response = await fetch(
          `https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}`,
          {
            headers: { Authorization: `Basic ${auth}` },
            signal: AbortSignal.timeout(PLATFORM_PAYMENT_TIMEOUT_MS),
          },
        );

        if (!response.ok) throw new PlatformProviderHttpError(response.status);
        const data: unknown = await response.json();
        return razorpayFetchedOrderSchema.parse(data);
      },
    );
    return result.value;
  }

  verifyPaymentSignature(
    orderId: string,
    paymentId: string,
    signature: string,
  ): boolean {
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
      const expected = createHmac("sha256", secret)
        .update(rawBody)
        .digest("hex");
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
