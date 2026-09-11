/**
 * The regression net for the P0 in `billablePrice` and `BillingMarketplace.purchaseAddon`.
 *
 * A price is an amount AND the currency that amount is denominated in. At journal head
 * the two came from different places: the AMOUNT from the platform's INR-paise price list
 * (`PLAN_PRICES_PAISE`, or `billing_price_versions.amount_minor`), the CURRENCY from the
 * TENANT'S OWN ACCOUNTING BASE (`accounting_settings.base_currency`, via `currencyForOrg`).
 * Those two facts are unrelated: the base currency is what the tenant keeps its own books
 * in, and says nothing about what this vendor charges.
 *
 * `PATCH /accounting/settings {"baseCurrency":"USD"}` is allowed for any org with no
 * POSTED journals (accounting-settings.service.ts), and `baseCurrency` is validated only
 * as `z.string().length(3)`. So a new org sets USD, then `POST /billing/checkout` sends
 * the gateway `{ amount: "99900", currency: "USD" }` — $999.00 charged for a ₹999.00 plan,
 * ~85x — and `verifyAndActivate` then writes `subscription_payments.amount_paise = 99900`
 * stamped `currency = 'USD'`, so a column named paise holds cents and every revenue figure
 * derived from it is wrong. `purchaseAddon` had the same shape with no fallback at all:
 * `ai_credit_packs.price_in_paise` is a platform table with no org_id and paise in the
 * column name, labelled with whatever currency the buyer's books happen to use.
 *
 * The existing suite could not see it: billing-provider-contract.spec.ts mocks
 * `baseCurrency: 'INR'` and billing.service.spec.ts asserts `currency === 'INR'`, so both
 * agree with the broken code whenever the two sources happen to coincide. These tests make
 * them disagree.
 *
 * Hermetic on purpose — the defect is which JS expression supplies which field, and a real
 * Postgres would add nothing.
 */
import { ConflictException } from "@nestjs/common";
import { PaymentRequiredException } from "../../../common/http/api-exceptions";
import type { Db } from "../../../db/drizzle.module";
import { BillingPaymentActivation, type BillingPaymentActivationDeps } from "./billing-payment-activation";
import { BillingMarketplace } from "./billing-marketplace";
import { planSchema } from "./dto/billing.schemas";
import { AiCreditsService } from "./ai-credits.service";
import { PaymentProviderResolver, type OrganizationPaymentProvider } from "../payments/payment-provider-resolver.service";
import {
  FAKE_PLATFORM_PAYMENT_SIG,
  fakePlatformRegistry,
  type FakePlatformProvider,
} from "./testing/fake-platform-provider";
import { VersionedCatalogService } from "./versioned-catalog.service";
import { ANNUAL_DISCOUNT_PCT, PLAN_PRICES_PAISE, PLATFORM_PRICE_CURRENCY } from "./plan-entitlements.constants";
import { FAKE_PROVIDER_ORDER_ID, FAKE_PUBLIC_KEY_ID } from "../payments/testing/fake-provider-adapter";
import { determineTax } from "./tax/tax-determination";

/**
 * Captures exactly what would reach the PLATFORM's gateway — the money that
 * actually moves when we bill a tenant for their subscription.
 *
 * The registry is real; only the HTTP call behind it is not. `created` is the
 * list of orders the provider was asked for, in order.
 */
function makeRegistry(): { registry: ReturnType<typeof fakePlatformRegistry>["registry"]; sent: FakePlatformProvider["created"] } {
  const fake = fakePlatformRegistry();
  return { registry: fake.registry, sent: fake.razorpay.created };
}

/** The tenant-facing resolver, which the addon path still goes through. */
function makeProvider(sent: Array<{ amount: string; currency: string; receipt: string; notes?: Record<string, string> }>): PaymentProviderResolver {
  const provider: OrganizationPaymentProvider = {
    providerKey: "razorpay",
    environment: "test",
    isReady: () => true,
    publicKeyId: () => FAKE_PUBLIC_KEY_ID,
    createOrder: async (params) => {
      sent.push(params);
      return { providerOrderId: FAKE_PROVIDER_ORDER_ID, raw: {} };
    },
    verifyPaymentSignature: () => true,
    verifyWebhookSignature: () => true,
    normalizeWebhook: () => ({ ok: false, error: "invalid_payload" }),
  };
  return {
    resolve: jest.fn().mockResolvedValue(provider),
    resolveConfigured: jest.fn().mockResolvedValue(provider),
  } as unknown as PaymentProviderResolver;
}

/**
 * A db whose ONLY answer is the tenant's accounting base currency. If a billing amount is
 * ever labelled with what comes out of here, this fake is what proves it.
 */
function makeAccountingDb(baseCurrency: string) {
  const select = jest.fn().mockReturnValue({
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue([{ baseCurrency }]),
  });
  return { db: { select } as unknown as Db, select };
}

function makeCatalog(price: { amountMinor: number; currency: string } | null): VersionedCatalogService {
  return {
    getActivePriceForPlanTier: jest.fn().mockResolvedValue(price),
  } as unknown as VersionedCatalogService;
}

function makeActivation(
  overrides: { baseCurrency?: string; catalogPrice?: { amountMinor: number; currency: string } | null },
) {
  const { db, select } = makeAccountingDb(overrides.baseCurrency ?? "INR");
  const { registry, sent } = makeRegistry();
  const deps = {
    db,
    audit: { log: jest.fn() },
    aiCredits: { grantPlanCredits: jest.fn() },
    planLimits: { bust: jest.fn() },
    prorationLedger: { recordPlanChange: jest.fn() },
    catalog: makeCatalog(overrides.catalogPrice ?? null),
    revenueAnalytics: { emit: jest.fn() },
    registry,
    externalEffectLedger: { execute: jest.fn() },
  } as unknown as BillingPaymentActivationDeps;
  return { activation: new BillingPaymentActivation(deps), accountingSelect: select, sent };
}

/** ₹ net plus the domestic GST a buyer who has told us nothing is charged. */
function grossInr(netMinor: number): number {
  return determineTax(netMinor, { country: "IN" }).grossMinor;
}

describe("billing checkout — the amount and its currency come from one source", () => {
  /*
    The charge is the gross, so `netMinor` is the half these assertions are about:
    it is the priced amount, and `amount` is that amount plus the tax determined
    on it. Reading the pair off `netMinor`/`currency` keeps the question the same
    one — which expression supplied which field — now that a second, correct
    expression contributes to what is sent.
  */
  it("a USD-books tenant is still charged the platform's INR price, not $999", async () => {
    const { activation, sent } = makeActivation({ baseCurrency: "USD" });

    const order = await activation.createOrder("org1", "user1", "STARTER");

    // 99900 is MINOR UNITS of INR (paise) — ₹999.00. Labelling it USD charges $999.00.
    expect(sent).toHaveLength(1);
    expect(order.netMinor).toBe(PLAN_PRICES_PAISE.STARTER);
    expect(sent[0].amount).toBe(order.netMinor + order.taxMinor);
    expect(sent[0].currency).toBe("INR");
    expect(order.currency).toBe("INR");
  });

  it("the org's accounting base currency is never read on the checkout path at all", async () => {
    const { activation, accountingSelect } = makeActivation({ baseCurrency: "KWD" });

    await activation.createOrder("org1", "user1", "PROFESSIONAL");

    expect(accountingSelect).not.toHaveBeenCalled();
  });

  it("when the platform catalog prices a plan, BOTH halves come from that row", async () => {
    // A USD-denominated catalog price; the tenant keeps INR books. The pair must stay USD.
    const { activation, sent } = makeActivation({
      baseCurrency: "INR",
      catalogPrice: { amountMinor: 4999, currency: "USD" },
    });

    const order = await activation.createOrder("org1", "user1", "STARTER");

    // 4999 is MINOR UNITS of USD (cents) — $49.99. Labelling it INR charges ₹49.99.
    expect(sent[0]).toMatchObject({ currency: "USD" });
    expect(order.netMinor).toBe(4999);
    expect(order.currency).toBe("USD");
  });

  it("the annual discount scales the catalog amount and keeps the catalog currency", async () => {
    const { activation } = makeActivation({
      baseCurrency: "JPY",
      catalogPrice: { amountMinor: 4999, currency: "USD" },
    });

    const order = await activation.createOrder("org1", "user1", "STARTER", "annual");

    // minor units of USD, discounted across 12 months
    expect(order.netMinor).toBe(Math.round(4999 * 12 * (1 - ANNUAL_DISCOUNT_PCT)));
    expect(order.currency).toBe("USD");
  });

  it("PLAN_PRICES_PAISE is paired with a named currency rather than an implied one", () => {
    expect(PLATFORM_PRICE_CURRENCY).toBe("INR");
  });
});

describe("addon purchase — priceInPaise is paired with INR", () => {
  function makeMarketplace(sent: Array<{ amount: string; currency: string; receipt: string }>) {
    const aiCredits = {
      listPacks: jest.fn().mockResolvedValue([{ id: 7, name: "Pack", credits: 1000, priceInPaise: 49900 }]),
    } as unknown as AiCreditsService;
    return new BillingMarketplace(aiCredits, makeProvider(sent));
  }

  it("labels priceInPaise INR whatever the buyer's books say", async () => {
    const sent: Array<{ amount: string; currency: string; receipt: string }> = [];
    const result = await makeMarketplace(sent).purchaseAddon("org1", "ai_pack_7", 2);

    // 49900 paise x 2 = ₹998.00. There is no non-INR reading of a column named price_in_paise.
    expect(sent[0]).toMatchObject({ amount: "99800", currency: "INR" });
    expect(result.currency).toBe("INR");
    expect(result.amount).toBe(99800);
  });

  it("takes no currency collaborator, so no caller can inject the tenant's books again", () => {
    expect(BillingMarketplace.length).toBe(2);
  });
});

describe("activation — the payment row records the currency that was charged", () => {
  it("stamps subscription_payments with the price currency, not the tenant's base currency", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const tx = {
      query: { subscriptions: { findFirst: jest.fn().mockResolvedValue(null) } },
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockImplementation((row: Record<string, unknown>) => {
          inserted.push(row);
          const rows = [{ id: 1 }];
          return {
            returning: jest.fn().mockResolvedValue(rows),
            onConflictDoNothing: jest.fn().mockResolvedValue(rows),
            then: (resolve: (v: typeof rows) => unknown) => Promise.resolve(rows).then(resolve),
          };
        }),
      }),
    };
    const { db, select } = makeAccountingDb("USD");
    const deps = {
      db: {
        ...db,
        select,
        transaction: jest.fn().mockImplementation((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
      },
      audit: { log: jest.fn() },
      aiCredits: { grantPlanCredits: jest.fn() },
      planLimits: { bust: jest.fn() },
      prorationLedger: { recordPlanChange: jest.fn() },
      catalog: makeCatalog(null),
      revenueAnalytics: { emit: jest.fn() },
      registry: makeRegistry().registry,
      externalEffectLedger: { execute: jest.fn() },
    } as unknown as BillingPaymentActivationDeps;

    await new BillingPaymentActivation(deps).verifyAndActivate("org1", "user1", {
      plan: "STARTER",
      orderId: "order_1",
      paymentId: "pay_1",
      signature: FAKE_PLATFORM_PAYMENT_SIG,
    });

    const payment = inserted.find((row) => "amountPaise" in row);
    expect(payment).toBeDefined();
    // amountPaise is MINOR UNITS; the currency stamped beside it must denominate those
    // units. It records the gross, which is what the gateway actually took.
    expect(payment?.amountPaise).toBe(grossInr(PLAN_PRICES_PAISE.STARTER));
    expect(payment?.currency).toBe("INR");
  });
});

describe("checkout guards that must survive the change", () => {
  it("every purchasable plan is denominated in the platform's currency", async () => {
    for (const plan of planSchema.options) {
      const { activation, sent } = makeActivation({ baseCurrency: "USD" });
      const order = await activation.createOrder("org1", "user1", plan);

      expect(order.currency).toBe(PLATFORM_PRICE_CURRENCY);
      expect(order.netMinor).toBe(PLAN_PRICES_PAISE[plan]);
      expect(sent[0].currency).toBe(PLATFORM_PRICE_CURRENCY);
    }
  });

  /*
    The refusal names the currency, not a gateway.

    This used to assert a `ServiceUnavailableException` thrown ahead of the price
    — which is exactly the precondition that made the registry unreachable on a
    deployment configured for the other provider. The refusal has to know the
    currency to be able to say nothing can charge it, so it necessarily comes
    after the price; what matters is that nothing reaches a gateway.
  */
  it("a deployment with no platform gateway is refused, by currency", async () => {
    const fake = fakePlatformRegistry({ razorpay: false, stripe: false });
    const deps = {
      catalog: makeCatalog(null),
      registry: fake.registry,
    } as unknown as BillingPaymentActivationDeps;

    await expect(
      new BillingPaymentActivation(deps).createOrder("org1", "user1", "STARTER"),
    ).rejects.toBeInstanceOf(PaymentRequiredException);
    expect(fake.razorpay.created).toHaveLength(0);
    expect(fake.stripe.created).toHaveLength(0);
  });

  it("the coupon-collision path still maps to a 409, not a 500", async () => {
    // isUniqueViolationOn reads the SQLSTATE off `.cause`, so the wrapper shape matters.
    const wrapped = Object.assign(new Error("Failed query: insert into coupon_redemptions"), {
      cause: Object.assign(new Error("duplicate key"), {
        code: "23505",
        constraint_name: "uq_coupon_redemptions_coupon_org",
      }),
    });
    const deps = {
      db: { transaction: jest.fn().mockRejectedValue(wrapped) },
      audit: { log: jest.fn() },
      aiCredits: { grantPlanCredits: jest.fn() },
      planLimits: { bust: jest.fn() },
      prorationLedger: { recordPlanChange: jest.fn() },
      catalog: makeCatalog(null),
      revenueAnalytics: { emit: jest.fn() },
      registry: makeRegistry().registry,
      externalEffectLedger: { execute: jest.fn() },
    } as unknown as BillingPaymentActivationDeps;

    await expect(
      new BillingPaymentActivation(deps).verifyAndActivate("org1", "user1", {
        plan: "STARTER",
        orderId: "order_1",
        paymentId: "pay_1",
        signature: FAKE_PLATFORM_PAYMENT_SIG,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
