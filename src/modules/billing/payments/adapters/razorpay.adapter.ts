import { Injectable, BadGatewayException, OnModuleInit, Optional, Inject } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { outboundRequest } from "../../../../common/http/outbound-request";
import { PaymentProviderAdapterRegistry, type PaymentCredentialWarning, type PaymentProviderAdapter, type PaymentWebhookNormalization } from "../payment-provider-adapter.interface";
import { webhookEnvelopeSchema } from "../dto/webhook.schemas";
import { APP_CONFIG } from "../../../../config/config.module";

interface RazorpayCredentials {
  readonly RAZORPAY_KEY_ID?: string | undefined;
  readonly RAZORPAY_KEY_SECRET?: string | undefined;
}

const razorpayOrderResponseSchema = z.object({
  id: z.string(),
  amount: z.number(),
  currency: z.string(),
});

const razorpayOrderErrorSchema = z.object({
  error: z.object({ description: z.string().optional() }).optional(),
});

function constantTimeEquals(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

@Injectable()
export class RazorpayAdapter implements PaymentProviderAdapter, OnModuleInit {
  readonly providerKey = "razorpay";

  constructor(
    private readonly registry: PaymentProviderAdapterRegistry,
    @Optional() @Inject(APP_CONFIG) private readonly credentials?: RazorpayCredentials,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  isReady(): boolean {
    return Boolean(this.credentials?.RAZORPAY_KEY_ID && this.credentials?.RAZORPAY_KEY_SECRET);
  }

  publicKeyId(): string | null {
    return this.credentials?.RAZORPAY_KEY_ID ?? null;
  }

  validateCredentialFormat(environment: "test" | "live", keyId: string): PaymentCredentialWarning | null {
    const isTestKey = keyId.startsWith("rzp_test_");
    const isLiveKey = keyId.startsWith("rzp_live_");

    if (!isTestKey && !isLiveKey) {
      return {
        code: "unrecognized_key_format",
        message: "This doesn't look like a Razorpay key ID (expected an rzp_test_ or rzp_live_ prefix).",
      };
    }
    if (environment === "test" && isLiveKey) {
      return {
        code: "live_key_in_test_environment",
        message: "This looks like a live key (rzp_live_) but you're saving it as a test credential.",
      };
    }
    if (environment === "live" && isTestKey) {
      return {
        code: "test_key_in_live_environment",
        message: "This looks like a test key (rzp_test_) but you're saving it as a live credential.",
      };
    }
    return null;
  }

  async createOrder(params: {
    keyId: string;
    keySecret: string;
    amount: string;
    currency: string;
    receipt: string;
    notes?: Record<string, string>;
  }): Promise<{ providerOrderId: string; raw: unknown }> {
    const auth = Buffer.from(`${params.keyId}:${params.keySecret}`).toString("base64");
    const response = await outboundRequest("https://api.razorpay.com/v1/orders", {
      provider: "razorpay-tenant",
      timeoutMs: 10_000,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        amount: params.amount,
        currency: params.currency,
        receipt: params.receipt,
        notes: params.notes ?? {},
      }),
    });

    if (!response.ok) {
      const raw: unknown = await response.json().catch(() => ({}));
      const parsed = razorpayOrderErrorSchema.safeParse(raw);
      const description = parsed.success ? parsed.data.error?.description ?? "Unknown error" : "Unknown error";
      throw new BadGatewayException(`Razorpay order creation failed: ${description}`);
    }

    const data: unknown = await response.json();
    const order = razorpayOrderResponseSchema.parse(data);
    return { providerOrderId: order.id, raw: order };
  }

  verifyPaymentSignature(params: { orderId: string; paymentId: string; signature: string; keySecret: string }): boolean {
    const expected = createHmac("sha256", params.keySecret)
      .update(`${params.orderId}|${params.paymentId}`)
      .digest("hex");
    return constantTimeEquals(expected, params.signature);
  }

  verifyWebhookSignature(params: { rawBody: string; signature: string; webhookSecret: string }): boolean {
    try {
      const expected = createHmac("sha256", params.webhookSecret).update(params.rawBody).digest("hex");
      return constantTimeEquals(expected, params.signature);
    } catch {
      return false;
    }
  }

  normalizeWebhook(rawBody: string): PaymentWebhookNormalization {
    let raw: unknown;
    try {
      raw = JSON.parse(rawBody);
    } catch {
      return { ok: false, error: "invalid_json" };
    }

    const parsed = webhookEnvelopeSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "invalid_payload" };

    const providerEventId =
      typeof (raw as { id?: unknown }).id === "string" ? (raw as { id: string }).id : undefined;
    return {
      ok: true,
      eventType: parsed.data.event,
      payload: parsed.data.payload,
      ...(providerEventId ? { providerEventId } : {}),
    };
  }
}
