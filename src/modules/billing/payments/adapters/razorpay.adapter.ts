import { Injectable, BadGatewayException, OnModuleInit, Optional } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { outboundRequest, OutboundRequestError, type OutboundRequestInit } from "../../../../common/http/outbound-request";
import { callProvider, type FailureClass } from "../../../../common/outbound/call-provider";
import { ProviderCircuitBreaker } from "../../../../common/outbound/provider-circuit-breaker";
import { PaymentProviderAdapterRegistry, type PaymentCredentialWarning, type PaymentProviderAdapter, type PaymentProviderRuntime, type PaymentWebhookNormalization } from "../payment-provider-adapter.interface";
import {
  webhookEnvelopeSchema,
  rawWebhookIdSchema,
  rawPaymentEntitySchema,
  tenantCredentialFieldsSchema,
} from "../dto/webhook.schemas";
export type RazorpayTransport = (url: string, init: OutboundRequestInit) => Promise<Response>;

interface RazorpayAdapterOptions {
  readonly transport?: RazorpayTransport;
  readonly breaker?: ProviderCircuitBreaker;
  readonly orderTimeoutMs?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

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

  private readonly _transport: RazorpayTransport;
  private readonly _breaker: ProviderCircuitBreaker;
  private readonly _orderTimeoutMs: number;
  private readonly _baseDelayMs: number;
  private readonly _maxDelayMs: number;

  constructor(
    private readonly registry: PaymentProviderAdapterRegistry,
    @Optional() opts?: RazorpayAdapterOptions,
  ) {
    this._transport = opts?.transport ?? outboundRequest;
    this._breaker = opts?.breaker ?? razorpayBreaker;
    this._orderTimeoutMs = opts?.orderTimeoutMs ?? 10_000;
    this._baseDelayMs = opts?.baseDelayMs ?? 200;
    this._maxDelayMs = opts?.maxDelayMs ?? 5_000;
  }

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
        timeoutMs: this._orderTimeoutMs,
        // An order may commit before an error response; the provider does not promise safe replay.
        maxAttempts: 1,
        baseDelayMs: this._baseDelayMs,
        maxDelayMs: this._maxDelayMs,
        classify: classifyRazorpayError,
      },
      async () => {
        const response = await this._transport("https://api.razorpay.com/v1/orders", {
          provider: "razorpay-tenant",
          timeoutMs: this._orderTimeoutMs,
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
      this._breaker,
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

    const idParsed = rawWebhookIdSchema.safeParse(raw);
    const providerEventId = idParsed.success ? idParsed.data.id : undefined;
    const providerPayload = parsed.data.payload;
    const payment = providerPayload.payment;
    const entity = payment && typeof payment === "object" && "entity" in payment ? payment.entity : undefined;
    const entityParsed = entity && typeof entity === "object" ? rawPaymentEntitySchema.safeParse(entity) : null;
    const normalizedEntity = entityParsed?.success
      ? Object.fromEntries(
          Object.entries({
            id: entityParsed.data.id,
            orderId: entityParsed.data.order_id,
            amount: entityParsed.data.amount,
            fee: entityParsed.data.fee,
            currency: entityParsed.data.currency,
            status: entityParsed.data.status,
            method: entityParsed.data.method,
            email: entityParsed.data.email,
            description: entityParsed.data.description,
            notes: entityParsed.data.notes,
            invoiceId: entityParsed.data.invoice_id,
            createdAt: entityParsed.data.created_at,
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
    const parsed = tenantCredentialFieldsSchema.safeParse(credentials);
    if (!parsed.success) return { keyId: null, secret: null, webhookSecret: null };
    return {
      keyId: parsed.data.keyId ?? null,
      secret: parsed.data.secret ?? null,
      webhookSecret: parsed.data.webhookSecret ?? null,
    };
  }
}
