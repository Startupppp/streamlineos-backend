import { Injectable, BadGatewayException, OnModuleInit } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { PaymentProviderAdapterRegistry, type PaymentCredentialWarning, type PaymentProviderAdapter } from "../payment-provider-adapter.interface";

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

// Mirrors src/modules/billing/razorpay.service.ts's HMAC/order logic, parameterized by
// per-org encrypted credentials instead of platform-wide env vars — that service and its
// /billing/razorpay + /webhooks/razorpay endpoints are untouched (StreamlineOS billing tenants
// for their own SaaS plan, a separate concern). This adapter is for tenants charging their own
// customers via their own connected Razorpay account.
@Injectable()
export class RazorpayAdapter implements PaymentProviderAdapter, OnModuleInit {
  readonly providerKey = "razorpay";

  constructor(private readonly registry: PaymentProviderAdapterRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
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
}
