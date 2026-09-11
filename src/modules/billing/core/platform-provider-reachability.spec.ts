import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { AppConfig } from "../../../config/env.validation";
import { AuditService } from "../../../common/audit/audit.service";
import { ExternalEffectLedger } from "../../../common/outbox/external-effect-ledger";
import { PaymentRequiredException } from "../../../common/http/api-exceptions";
import { PaymentProviderResolver } from "../payments/payment-provider-resolver.service";
import { PaymentWebhookReceiverService } from "../payments/payment-webhook-receiver.service";
import { PaymentAnalyticsService } from "../payments/payment-analytics.service";
import { AiCreditsService } from "./ai-credits.service";
import { BillingProfileService } from "./billing-profile.service";
import { BillingService } from "./billing.service";
import { PlanLimitsService } from "./plan-limits.service";
import { ProrationLedgerService } from "./proration-ledger.service";
import { PlatformPaymentRegistry } from "./platform-payment-registry";
import { RazorpayService } from "./razorpay.service";
import { RevenueAnalyticsService } from "./revenue-analytics.service";
import { StripeService } from "./stripe.service";
import { VersionedCatalogService } from "./versioned-catalog.service";

/**
 * Whether the registry is actually reachable from a sale.
 *
 * `PlatformPaymentRegistry.forCurrency` was written, tested and then guarded
 * behind `if (!this.razorpay.isConfigured()) throw` at the top of the same
 * method that calls it -- so on the one deployment ticket 02 exists for, a
 * Stripe-only one, nothing could be sold and the error blamed a gateway the
 * buyer was never going to be charged through. A unit test of the pure
 * selection function cannot see that; only a test that goes through
 * `createOrder` can.
 *
 * The merge lost the whole of that path a second time, by a different route:
 * `createOrder` came back resolving its provider from `PaymentProviderResolver`,
 * which reads the ORGANISATION's own `payment_providers` credentials -- the
 * gateway a tenant charges its own customers through. That is the opposite
 * direction of travel, so the platform's own subscription order was being
 * created inside the buyer's gateway. Everything below goes through the real
 * `PlatformPaymentRegistry` over the real provider services for exactly that
 * reason: a registry supplied as a `jest.fn()` would assert the wiring it is
 * meant to prove.
 */

const STRIPE_ONLY = {
  STRIPE_SECRET_KEY: "sk_test_x",
  STRIPE_PUBLISHABLE_KEY: "pk_test_x",
  STRIPE_WEBHOOK_SECRET: "whsec_x",
} as AppConfig;

const NOTHING_CONFIGURED = {} as AppConfig;

/**
 * Stripe's API, answering with the intent it was actually asked for.
 *
 * Echoing the request rather than a constant is what makes the assertions below
 * about what we sent Stripe, not about what a stub decided to say.
 */
function stubStripeApi() {
  const fetchMock = jest.fn().mockImplementation((_url: string, init: { body: URLSearchParams }) => {
    const sent = init.body;
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          id: "pi_reachability_001",
          object: "payment_intent",
          amount: Number(sent.get("amount")),
          currency: sent.get("currency"),
          status: "requires_payment_method",
        }),
    });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function makeDb() {
  return {
    query: {
      organizations: { findFirst: jest.fn().mockResolvedValue(null) },
      coupons: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
  };
}

async function buildBilling(config: AppConfig, country: string): Promise<BillingService> {
  const registry = new PlatformPaymentRegistry(
    new RazorpayService(config),
    new StripeService(config),
  );

  const module = await Test.createTestingModule({
    providers: [
      BillingService,
      { provide: DRIZZLE, useValue: makeDb() },
      { provide: PlatformPaymentRegistry, useValue: registry },
      { provide: AuditService, useValue: { log: jest.fn(), logCritical: jest.fn() } },
      { provide: AiCreditsService, useValue: { grantPlanCredits: jest.fn() } },
      { provide: PlanLimitsService, useValue: { bust: jest.fn() } },
      { provide: ProrationLedgerService, useValue: { recordPlanChange: jest.fn() } },
      // No dated catalog row, so the price comes from the per-currency list and
      // the buyer's own country decides which column of it applies.
      {
        provide: VersionedCatalogService,
        useValue: { getActivePriceForPlanTier: jest.fn().mockResolvedValue(null) },
      },
      { provide: RevenueAnalyticsService, useValue: { emit: jest.fn() } },
      /*
        The tenant-facing resolver answers nothing on purpose.

        It is the other direction of travel -- an organisation's own gateway,
        charging its own customers -- and a platform sale must not depend on it.
        Everything below still passes, which is the assertion.
      */
      {
        provide: PaymentProviderResolver,
        useValue: {
          resolve: jest.fn().mockResolvedValue(undefined),
          resolveConfigured: jest.fn().mockResolvedValue(undefined),
        },
      },
      { provide: ExternalEffectLedger, useValue: { execute: jest.fn() } },
      { provide: PaymentWebhookReceiverService, useValue: { recordSignatureFailure: jest.fn() } },
      { provide: PaymentAnalyticsService, useValue: { notifyOwner: jest.fn(), track: jest.fn() } },
      {
        // Where the buyer bills from -- the one fact that decides both the
        // currency they are quoted and the tax treatment applied to it.
        provide: BillingProfileService,
        useValue: {
          get: jest.fn().mockResolvedValue({ orgId: "org1", country, isTaxExempt: false }),
          update: jest.fn(),
        },
      },
    ],
  }).compile();

  return module.get(BillingService);
}

describe("createOrder on a Stripe-only deployment", () => {
  afterEach(() => jest.restoreAllMocks());

  it("sells to a German customer with no Razorpay credentials present", async () => {
    stubStripeApi();
    const billing = await buildBilling(STRIPE_ONLY, "DE");

    const order = await billing.createOrder("org1", "user1", "PROFESSIONAL");

    expect(order).toMatchObject({
      provider: "stripe",
      currency: "EUR",
      isPreferredProvider: true,
    });
  });

  it("charges Stripe the gross the tax rule produced, in euros", async () => {
    const fetchMock = stubStripeApi();
    const billing = await buildBilling(STRIPE_ONLY, "DE");

    const order = await billing.createOrder("org1", "user1", "PROFESSIONAL");

    const sent = fetchMock.mock.calls[0][1].body as URLSearchParams;
    expect(sent.get("currency")).toBe("eur");
    expect(Number(sent.get("amount"))).toBe(order.amount);
    expect(order.taxMinor).toBeGreaterThan(0);
    expect(order.amount).toBe(order.netMinor + order.taxMinor);
  });

  it("carries the plan and cycle on the intent, so the webhook can read them back", async () => {
    const fetchMock = stubStripeApi();
    const billing = await buildBilling(STRIPE_ONLY, "DE");

    await billing.createOrder("org1", "user1", "PROFESSIONAL", "annual");

    const sent = fetchMock.mock.calls[0][1].body as URLSearchParams;
    expect(sent.get("metadata[orgId]")).toBe("org1");
    expect(sent.get("metadata[plan]")).toBe("PROFESSIONAL");
    expect(sent.get("metadata[billingCycle]")).toBe("annual");
  });
});

describe("createOrder when the preferred provider is missing", () => {
  afterEach(() => jest.restoreAllMocks());

  /**
   * The half that matters more than the fallback itself.
   *
   * A rupee sale on a Stripe-only deployment still goes through -- refusing a
   * sale we can take is worse -- but the customer's statement will show a
   * conversion, and somebody has to be able to warn them. `isPreferredProvider`
   * is how the caller finds out, and it has to survive all the way out of
   * `createOrder` rather than being dropped between the registry and the reply.
   */
  it("says it fell back, rather than charging through a surprise silently", async () => {
    stubStripeApi();
    const billing = await buildBilling(STRIPE_ONLY, "IN");

    const order = await billing.createOrder("org1", "user1", "STARTER");

    expect(order).toMatchObject({
      provider: "stripe",
      currency: "INR",
      isPreferredProvider: false,
    });
  });

  it("refuses by naming the currency when nothing configured can charge it", async () => {
    const billing = await buildBilling(NOTHING_CONFIGURED, "DE");

    await expect(billing.createOrder("org1", "user1", "STARTER")).rejects.toThrow(
      PaymentRequiredException,
    );
  });

  /**
   * The old failure was a flat "Payment gateway not configured", which named
   * Razorpay's absence on a deployment that was never going to use it.
   */
  it("the refusal names the currency, not a gateway the buyer never chose", async () => {
    const billing = await buildBilling(NOTHING_CONFIGURED, "DE");

    await expect(billing.createOrder("org1", "user1", "STARTER")).rejects.toMatchObject({
      message: expect.stringContaining("EUR"),
    });
  });
});

describe("getSubscription reports whether the deployment can take money", () => {
  it("is configured when only Stripe has credentials", async () => {
    const billing = await buildBilling(STRIPE_ONLY, "DE");
    const db = { query: { subscriptions: { findFirst: jest.fn().mockResolvedValue(null) } } };
    Reflect.set(billing, "db", db);

    const result = await billing.getSubscription("org1");

    // The frontend disables every upgrade button on this flag; answering it from
    // the tenant's own connected gateway left a deployment that can perfectly
    // well sell unable to.
    expect(result.isConfigured).toBe(true);
  });

  it("is not configured when neither provider has credentials", async () => {
    const billing = await buildBilling(NOTHING_CONFIGURED, "DE");
    const db = { query: { subscriptions: { findFirst: jest.fn().mockResolvedValue(null) } } };
    Reflect.set(billing, "db", db);

    const result = await billing.getSubscription("org1");

    expect(result.isConfigured).toBe(false);
  });
});
