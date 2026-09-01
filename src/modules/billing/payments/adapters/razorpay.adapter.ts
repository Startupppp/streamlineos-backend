import { Injectable, BadGatewayException, OnModuleInit } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { outboundRequest, OutboundRequestError } from "../../../../common/http/outbound-request";
import { callProvider, type FailureClass } from "../../../../common/outbound/call-provider";
import { ProviderCircuitBreaker } from "../../../../common/outbound/provider-circuit-breaker";
import { PaymentProviderAdapterRegistry, type PaymentCredentialWarning, type PaymentProviderAdapter, type PaymentProviderRuntime, type PaymentWebhookNormalization } from "../payment-provider-adapter.interface";
import { webhookEnvelopeSchema } from "../dto/webhook.schemas";
interface TenantRazorpayCredentials {
  readonly keyId: string | null;
  readonly secret: string | null;
  readonly webhookSecret: string | null;
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

class RazorpayServerError extends Error {
  constructor(description: string) {
    super(description);
    this.name = "RazorpayServerError";
  }
}

class RazorpayClientError extends Error {
  constructor(description: string) {
    super(description);
    this.name = "RazorpayClientError";
  }
}

function classifyRazorpayError(error: unknown): FailureClass {
  if (error instanceof RazorpayClientError) return "terminal";
  if (error instanceof OutboundRequestError) return "retryable";
  if (error instanceof RazorpayServerError) return "retryable";
  return "retryable";
}

const razorpayBreaker = new ProviderCircuitBreaker();

@Injectable()
export class RazorpayAdapter implements PaymentProviderAdapter, OnModuleInit {
  readonly providerKey = "razorpay";

  constructor(
    private readonly registry: PaymentProviderAdapterRegistry,
  ) {}

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

  configure(credentials: unknown): PaymentProviderRuntime {
    const configured = this.toTenantCredentials(credentials);
    const keyId = configured.keyId;
    const keySecret = configured.secret;
    const webhookSecret = configured.webhookSecret;

    return {
      isReady: () => Boolean(keyId && keySecret),
      publicKeyId: () => keyId,
      createOrder: async (params: {
    amount: string;
    currency: string;
    receipt: string;
    notes?: Record<string, string>;
      }): Promise<{ providerOrderId: string; raw: unknown }> => {
    if (!keyId || !keySecret) throw new Error("Payment provider credentials are not configured");
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");

    const result = await callProvider(
      {
        provider: "razorpay-orders",
        timeoutMs: 10_000,
        maxAttempts: 3,
        baseDelayMs: 200,
        maxDelayMs: 5_000,
        classify: classifyRazorpayError,
      },
      async () => {
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
          if (response.status >= 500) throw new RazorpayServerError(description);
          throw new RazorpayClientError(description);
        }
        const data: unknown = await response.json();
        return razorpayOrderResponseSchema.parse(data);
      },
      razorpayBreaker,
    );

    if (!result.ok) {
      const msg = result.kind === "circuit-open"
        ? `Razorpay circuit breaker open, retry after ${result.retryAfterMs}ms`
        : `Razorpay order creation failed after ${result.attempts} attempt(s): ${result.error.message}`;
      throw new BadGatewayException(msg);
    }
    return { providerOrderId: result.value.id, raw: result.value };
      },

      verifyPaymentSignature: (params) => {
    if (!keySecret) return false;
    const expected = createHmac("sha256", keySecret)
      .update(`${params.orderId}|${params.paymentId}`)
      .digest("hex");
    return constantTimeEquals(expected, params.signature);
      },

      verifyWebhookSignature: (params) => {
    if (!webhookSecret) return false;
    try {
      const expected = createHmac("sha256", webhookSecret).update(params.rawBody).digest("hex");
      return constantTimeEquals(expected, params.signature);
    } catch {
      return false;
    }
      },

      normalizeWebhook: (rawBody): PaymentWebhookNormalization => {
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
    const providerPayload = parsed.data.payload;
    const payment = providerPayload.payment;
    const entity = payment && typeof payment === "object" && "entity" in payment ? payment.entity : undefined;
    const normalizedEntity = entity && typeof entity === "object"
      ? Object.fromEntries(
          Object.entries({
            id: (entity as Record<string, unknown>).id,
            orderId: (entity as Record<string, unknown>).order_id,
            amount: (entity as Record<string, unknown>).amount,
            fee: (entity as Record<string, unknown>).fee,
            currency: (entity as Record<string, unknown>).currency,
            status: (entity as Record<string, unknown>).status,
            method: (entity as Record<string, unknown>).method,
            email: (entity as Record<string, unknown>).email,
            description: (entity as Record<string, unknown>).description,
            notes: (entity as Record<string, unknown>).notes,
            invoiceId: (entity as Record<string, unknown>).invoice_id,
            createdAt: (entity as Record<string, unknown>).created_at,
          }).filter(([, value]) => value !== undefined),
        )
      : undefined;
    const normalizedPayload = normalizedEntity
      ? { ...providerPayload, payment: { entity: normalizedEntity } }
      : providerPayload;
    return {
      ok: true,
      eventType: parsed.data.event,
      payload: normalizedPayload,
      ...(providerEventId ? { providerEventId } : {}),
    };
      },
    };
  }

  private toTenantCredentials(credentials: unknown): TenantRazorpayCredentials {
    if (!credentials || typeof credentials !== "object") {
      return { keyId: null, secret: null, webhookSecret: null };
    }
    const value = credentials as Record<string, unknown>;
    return {
      keyId: typeof value.keyId === "string" ? value.keyId : null,
      secret: typeof value.secret === "string" ? value.secret : null,
      webhookSecret: typeof value.webhookSecret === "string" ? value.webhookSecret : null,
    };
  }
}
