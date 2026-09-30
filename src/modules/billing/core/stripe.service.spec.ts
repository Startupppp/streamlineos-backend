import { StripeService } from "./stripe.service";
import type { AppConfig } from "../../../config/env.validation";

const CONFIGURED = {
  STRIPE_SECRET_KEY: "sk_test_x",
  STRIPE_PUBLISHABLE_KEY: "pk_test_x",
  STRIPE_WEBHOOK_SECRET: "whsec_x",
} as unknown as AppConfig;

/**
 * Stripe's own documented response, trimmed to what is read.
 *
 * A fixture rather than a mocked SDK, which is this phase's rule: a mocked SDK
 * tests that the mock agrees with itself, and the shape that actually breaks a
 * deployment is the one on the wire.
 */
const PAYMENT_INTENT = {
  id: "pi_3MtwBwLkdIwHu7ix28a3tqPa",
  object: "payment_intent",
  amount: 1900,
  currency: "eur",
  client_secret: "pi_3MtwBwLkdIwHu7ix28a3tqPa_secret_YrKJUKribcBjcG8HVhfZluoGH",
  status: "requires_payment_method",
};

function withFetch(response: { ok: boolean; body: unknown; status?: number }) {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 400),
    json: async () => response.body,
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("StripeService", () => {
  afterEach(() => jest.restoreAllMocks());

  it("reports itself unconfigured without credentials, so selection skips it", () => {
    expect(new StripeService({} as AppConfig).isConfigured()).toBe(false);
    expect(new StripeService(CONFIGURED).isConfigured()).toBe(true);
  });

  it("returns the three fields the interface promises, and nothing else", async () => {
    withFetch({ ok: true, body: PAYMENT_INTENT });

    const order = await new StripeService(CONFIGURED).createOrder({
      amount: 1900,
      currency: "EUR",
      receipt: "sub_42_2026_08",
      notes: { organizationId: "org-1" },
    });

    expect(order).toEqual({
      id: "pi_3MtwBwLkdIwHu7ix28a3tqPa",
      amount: 1900,
      // Normalised back to upper, so a row written from Stripe and one written
      // from Razorpay hold the same string for the same currency.
      currency: "EUR",
    });
  });

  /**
   * The retry that would otherwise charge twice.
   *
   * This path is reached from a durable workflow that retries on any transport
   * failure, so "the request timed out but the intent was created" is the
   * ordinary case rather than the exotic one.
   */
  it("sends the receipt as an idempotency key", async () => {
    const fetchMock = withFetch({ ok: true, body: PAYMENT_INTENT });

    await new StripeService(CONFIGURED).createOrder({
      amount: 1900,
      currency: "EUR",
      receipt: "sub_42_2026_08",
      notes: {},
    });

    const init = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(init.headers["Idempotency-Key"]).toBe("sub_42_2026_08");
  });

  it("sends the currency in the case Stripe expects", async () => {
    const fetchMock = withFetch({ ok: true, body: PAYMENT_INTENT });

    await new StripeService(CONFIGURED).createOrder({
      amount: 1900,
      currency: "EUR",
      receipt: "r1",
      notes: {},
    });

    const init = fetchMock.mock.calls[0]?.[1] as { body: URLSearchParams };
    expect(init.body.get("currency")).toBe("eur");
    expect(init.body.get("amount")).toBe("1900");
  });

  it("carries the caller's notes through as metadata", async () => {
    const fetchMock = withFetch({ ok: true, body: PAYMENT_INTENT });

    await new StripeService(CONFIGURED).createOrder({
      amount: 1900,
      currency: "EUR",
      receipt: "r1",
      notes: { organizationId: "org-1", plan: "STARTER" },
    });

    const init = fetchMock.mock.calls[0]?.[1] as { body: URLSearchParams };
    expect(init.body.get("metadata[organizationId]")).toBe("org-1");
    expect(init.body.get("metadata[plan]")).toBe("STARTER");
    expect(init.body.get("metadata[receipt]")).toBe("r1");
  });

  it("does not surface Stripe's response message when it refuses", async () => {
    const providerMessage = "Amount must be at least 50 cents sk_live_do_not_expose";
    withFetch({
      ok: false,
      body: { error: { message: providerMessage, code: "amount_too_small" } },
    });

    const error = await (
      new StripeService(CONFIGURED).createOrder({
        amount: 1,
        currency: "EUR",
        receipt: "r1",
        notes: {},
      })
    ).catch((caught: unknown) => caught);

    expect((error as Error).message).toMatch(/temporarily unavailable/i);
    expect((error as Error).message).not.toContain(providerMessage);
  });

  it("retries a retryable create because Stripe receives a stable idempotency key", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => PAYMENT_INTENT });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      new StripeService(CONFIGURED).createOrder({
        amount: 1900,
        currency: "EUR",
        receipt: "stable-receipt",
        notes: {},
      }),
    ).resolves.toMatchObject({ id: PAYMENT_INTENT.id });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit & { headers: Record<string, string> }).headers["Idempotency-Key"])
        .toBe("stable-receipt");
    }
  });

  it("refuses to attempt a charge at all when unconfigured", async () => {
    await expect(
      new StripeService({} as AppConfig).createOrder({
        amount: 1900,
        currency: "EUR",
        receipt: "r1",
        notes: {},
      }),
    ).rejects.toThrow(/not configured/i);
  });

  /**
   * Not a stub — the honest answer.
   *
   * Razorpay hands the browser an `order|payment` HMAC the server checks on
   * return. Stripe has no client-side equivalent; its confirmation is the
   * webhook. Returning true here would accept an unverified browser return as
   * proof of payment.
   */
  it("does not claim a client-side payment signature it has no way to check", () => {
    expect(new StripeService(CONFIGURED).verifyPaymentSignature()).toBe(false);
  });

  it("refuses a webhook when no secret is configured", () => {
    expect(new StripeService({} as AppConfig).verifyWebhookSignature("{}", "t=1,v1=a")).toBe(
      false,
    );
  });

  it("bounds every outbound call so a stalled provider cannot pin a pooled connection", async () => {
    const service = new StripeService(CONFIGURED);

    const createFetch = withFetch({ ok: true, body: PAYMENT_INTENT });
    await service.createOrder({
      amount: 1900,
      currency: "EUR",
      receipt: "rcpt_1",
      notes: {},
    });
    const createInit = createFetch.mock.calls[0]?.[1] as RequestInit;
    expect(createInit.signal).toBeInstanceOf(AbortSignal);

    const fetchFetch = withFetch({ ok: true, body: PAYMENT_INTENT });
    await service.fetchOrder("pi_3MtwBwLkdIwHu7ix28a3tqPa");
    const fetchInit = fetchFetch.mock.calls[0]?.[1] as RequestInit;
    expect(fetchInit.signal).toBeInstanceOf(AbortSignal);
  });
});
