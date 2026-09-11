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
import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { BillingPaymentActivation, type BillingPaymentActivationDeps } from "./billing-payment-activation";
import { BillingMarketplace } from "./billing-marketplace";
import { planSchema } from "./dto/billing.schemas";
import { AiCreditsService } from "./ai-credits.service";
import { PaymentProviderResolver, type OrganizationPaymentProvider } from "../payments/payment-provider-resolver.service";
import { VersionedCatalogService } from "./versioned-catalog.service";
import { ANNUAL_DISCOUNT_PCT, PLAN_PRICES_PAISE, PLATFORM_PRICE_CURRENCY } from "./plan-entitlements.constants";
import { FAKE_PROVIDER_ORDER_ID, FAKE_PUBLIC_KEY_ID } from "../payments/testing/fake-provider-adapter";

interface GatewayOrder {
  amount: string;
  currency: string;
  receipt: string;
  notes?: Record<string, string>;
}

/** Captures exactly what would reach the payment gateway — the money that actually moves. */
function makeProvider(sent: GatewayOrder[]): PaymentProviderResolver {
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
  sent: GatewayOrder[],
) {
  const { db, select } = makeAccountingDb(overrides.baseCurrency ?? "INR");
  const deps = {
    db,
    audit: { log: jest.fn() },
    aiCredits: { grantPlanCredits: jest.fn() },
    planLimits: { bust: jest.fn() },
    prorationLedger: { recordPlanChange: jest.fn() },
    catalog: makeCatalog(overrides.catalogPrice ?? null),
    revenueAnalytics: { emit: jest.fn() },
    providers: makeProvider(sent),
    externalEffectLedger: { execute: jest.fn() },
  } as unknown as BillingPaymentActivationDeps;
  return { activation: new BillingPaymentActivation(deps), accountingSelect: select };
}

describe("billing checkout — the amount and its currency come from one source", () => {
  it("a USD-books tenant is still charged the platform's INR price, not $999", async () => {
    const sent: GatewayOrder[] = [];
    const { activation } = makeActivation({ baseCurrency: "USD" }, sent);

    const order = await activation.createOrder("org1", "user1", "STARTER");

    // 99900 is MINOR UNITS of INR (paise) — ₹999.00. Labelling it USD charges $999.00.
    expect(sent).toHaveLength(1);
    expect(sent[0].amount).toBe(String(PLAN_PRICES_PAISE.STARTER));
    expect(sent[0].currency).toBe("INR");
    expect(order.currency).toBe("INR");
  });

  it("the org's accounting base currency is never read on the checkout path at all", async () => {
    const sent: GatewayOrder[] = [];
    const { activation, accountingSelect } = makeActivation({ baseCurrency: "KWD" }, sent);

    await activation.createOrder("org1", "user1", "PROFESSIONAL");

    expect(accountingSelect).not.toHaveBeenCalled();
  });

  it("when the platform catalog prices a plan, BOTH halves come from that row", async () => {
    const sent: GatewayOrder[] = [];
    // A USD-denominated catalog price; the tenant keeps INR books. The pair must stay USD.
    const { activation } = makeActivation(
      { baseCurrency: "INR", catalogPrice: { amountMinor: 4999, currency: "USD" } },
      sent,
    );

    const order = await activation.createOrder("org1", "user1", "STARTER");

    // 4999 is MINOR UNITS of USD (cents) — $49.99. Labelling it INR charges ₹49.99.
    expect(sent[0]).toMatchObject({ amount: "4999", currency: "USD" });
    expect(order.amount).toBe(4999);
    expect(order.currency).toBe("USD");
  });

  it("the annual discount scales the catalog amount and keeps the catalog currency", async () => {
    const sent: GatewayOrder[] = [];
    const { activation } = makeActivation(
      { baseCurrency: "JPY", catalogPrice: { amountMinor: 4999, currency: "USD" } },
      sent,
    );

    const order = await activation.createOrder("org1", "user1", "STARTER", "annual");

    // minor units of USD, discounted across 12 months
    expect(order.amount).toBe(Math.round(4999 * 12 * (1 - ANNUAL_DISCOUNT_PCT)));
    expect(order.currency).toBe("USD");
  });

  it("PLAN_PRICES_PAISE is paired with a named currency rather than an implied one", () => {
    expect(PLATFORM_PRICE_CURRENCY).toBe("INR");
  });
});

describe("addon purchase — priceInPaise is paired with INR", () => {
  function makeMarketplace(sent: GatewayOrder[]) {
    const aiCredits = {
      listPacks: jest.fn().mockResolvedValue([{ id: 7, name: "Pack", credits: 1000, priceInPaise: 49900 }]),
    } as unknown as AiCreditsService;
    return new BillingMarketplace(aiCredits, makeProvider(sent));
  }

  it("labels priceInPaise INR whatever the buyer's books say", async () => {
    const sent: GatewayOrder[] = [];
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
    const sent: GatewayOrder[] = [];
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
      providers: makeProvider(sent),
      externalEffectLedger: { execute: jest.fn() },
    } as unknown as BillingPaymentActivationDeps;

    await new BillingPaymentActivation(deps).verifyAndActivate("org1", "user1", {
      plan: "STARTER",
      orderId: "order_1",
      paymentId: "pay_1",
      signature: "sig",
    });

    const payment = inserted.find((row) => "amountPaise" in row);
    expect(payment).toBeDefined();
    // amountPaise is MINOR UNITS; the currency stamped beside it must denominate those units.
    expect(payment?.amountPaise).toBe(PLAN_PRICES_PAISE.STARTER);
    expect(payment?.currency).toBe("INR");
  });
});

describe("checkout guards that must survive the change", () => {
  it("every purchasable plan is denominated in the platform's currency", async () => {
    for (const plan of planSchema.options) {
      const sent: GatewayOrder[] = [];
      const { activation } = makeActivation({ baseCurrency: "USD" }, sent);
      const order = await activation.createOrder("org1", "user1", plan);

      expect(order.currency).toBe(PLATFORM_PRICE_CURRENCY);
      expect(order.amount).toBe(PLAN_PRICES_PAISE[plan]);
      expect(sent[0].currency).toBe(PLATFORM_PRICE_CURRENCY);
    }
  });

  it("an unconfigured gateway is still refused before any price is computed", async () => {
    const sent: GatewayOrder[] = [];
    const deps = {
      catalog: makeCatalog(null),
      providers: { resolveConfigured: jest.fn().mockResolvedValue(undefined) },
    } as unknown as BillingPaymentActivationDeps;

    await expect(
      new BillingPaymentActivation(deps).createOrder("org1", "user1", "STARTER"),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(sent).toHaveLength(0);
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
      providers: makeProvider([]),
      externalEffectLedger: { execute: jest.fn() },
    } as unknown as BillingPaymentActivationDeps;

    await expect(
      new BillingPaymentActivation(deps).verifyAndActivate("org1", "user1", {
        plan: "STARTER",
        orderId: "order_1",
        paymentId: "pay_1",
        signature: "sig",
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
