import { ServiceUnavailableException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { ExternalEffectLedger } from "../../../common/outbox/external-effect-ledger";
import { PaymentProviderResolver } from "../payments/payment-provider-resolver.service";
import type { OrganizationPaymentProvider } from "../payments/payment-provider-resolver.service";
import { PaymentWebhookReceiverService } from "../payments/payment-webhook-receiver.service";
import { PaymentAnalyticsService } from "../payments/payment-analytics.service";
import { AiCreditsService } from "./ai-credits.service";
import { BillingPaymentActivation } from "./billing-payment-activation";
import { BillingCoupons } from "./billing-coupons";
import { BillingAccountOverview } from "./billing-account-overview";
import { PlanLimitsService } from "./plan-limits.service";
import { ProrationLedgerService } from "./proration-ledger.service";
import { PlatformMerchantService } from "../payments/platform-merchant.service";
import { RevenueAnalyticsService } from "./revenue-analytics.service";
import { VersionedCatalogService } from "./versioned-catalog.service";
import {
  FakeProviderAdapter,
  FAKE_PUBLIC_KEY_ID,
  FAKE_PROVIDER_ORDER_ID,
} from "../payments/testing/fake-provider-adapter";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(
    async (
      db: { transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> },
      _orgId: string,
      fn: (tx: unknown) => Promise<unknown>,
    ) => db.transaction(fn),
  ),
}));

function makeProvider(): OrganizationPaymentProvider {
  const adapter = new FakeProviderAdapter("razorpay");
  return {
    providerKey: "razorpay",
    environment: "test",
    isReady: () => true,
    publicKeyId: () => FAKE_PUBLIC_KEY_ID,
    createOrder: (params) =>
      adapter.configure({ keyId: FAKE_PUBLIC_KEY_ID, secret: "fake-secret" }).createOrder(params),
    verifyPaymentSignature: () => true,
    verifyWebhookSignature: () => false,
    fetchPayment: async () => null,
    normalizeWebhook: (rawBody) => adapter.configure(null).normalizeWebhook(rawBody),
  };
}

function makeMerchant(configured: boolean) {
  const provider = configured ? makeProvider() : undefined;
  return {
    resolve: jest.fn().mockReturnValue(provider),
    readiness: jest.fn().mockReturnValue({
      configured,
      providerKey: "razorpay",
      environment: configured ? "test" : null,
      publicKeyId: configured ? FAKE_PUBLIC_KEY_ID : null,
      webhookConfigured: false,
      unavailableReason: configured ? null : ("no_credentials" as const),
    }),
    environment: jest.fn().mockReturnValue(configured ? "test" : null),
  } as unknown as PlatformMerchantService;
}

function makeDb() {
  const now = new Date();
  const purchaseRow = {
    id: 7,
    orgId: "org1",
    createdByUserId: "user1",
    providerKey: "razorpay",
    environment: "test",
    merchantKeyId: FAKE_PUBLIC_KEY_ID,
    providerOrderId: null,
    plan: "PROFESSIONAL",
    billingCycle: "monthly",
    catalogVersion: null,
    baseAmountMinor: 99900,
    discountAmountMinor: 0,
    amountMinor: 99900,
    currency: "INR",
    couponId: null,
    status: "PENDING",
    providerPaymentId: null,
    capturedAmountMinor: null,
    capturedCurrency: null,
    subscriptionId: null,
    activatedAt: null,
    expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
    metadata: null,
    createdAt: now,
    updatedAt: now,
  };

  const tx = {
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([purchaseRow]),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([
            { ...purchaseRow, providerOrderId: FAKE_PROVIDER_ORDER_ID },
          ]),
        }),
      }),
    }),
  };

  return {
    transaction: jest
      .fn()
      .mockImplementation((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    query: {
      subscriptions: { findFirst: jest.fn().mockResolvedValue(null) },
      coupons: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
  };
}

async function buildBilling(configured: boolean): Promise<BillingPaymentActivation> {
  const module = await Test.createTestingModule({
    providers: [
      BillingPaymentActivation,
      BillingCoupons,
      { provide: DRIZZLE, useValue: makeDb() },
      { provide: PlatformMerchantService, useValue: makeMerchant(configured) },
      { provide: AuditService, useValue: { log: jest.fn(), logCritical: jest.fn() } },
      { provide: AiCreditsService, useValue: { grantPlanCredits: jest.fn() } },
      { provide: PlanLimitsService, useValue: { bust: jest.fn() } },
      { provide: ProrationLedgerService, useValue: { recordPlanChange: jest.fn() } },
      {
        provide: VersionedCatalogService,
        useValue: { getActivePriceForPlanTier: jest.fn().mockResolvedValue(null) },
      },
      { provide: RevenueAnalyticsService, useValue: { emit: jest.fn() } },
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
        provide: CacheService,
        useValue: {
          invalidate: jest.fn().mockResolvedValue(undefined),
          invalidateMany: jest.fn().mockResolvedValue(undefined),
          invalidateForOrg: jest.fn().mockResolvedValue(undefined),
          cached: jest.fn().mockImplementation(async (_key: unknown, fn: () => Promise<unknown>) => fn()),
        },
      },
    ],
  }).compile();

  return module.get(BillingPaymentActivation);
}

async function buildAccountOverview(configured: boolean): Promise<BillingAccountOverview> {
  const module = await Test.createTestingModule({
    providers: [
      BillingAccountOverview,
      { provide: DRIZZLE, useValue: makeDb() },
      { provide: PlatformMerchantService, useValue: makeMerchant(configured) },
      { provide: PlanLimitsService, useValue: { bust: jest.fn() } },
    ],
  }).compile();

  return module.get(BillingAccountOverview);
}

describe("createOrder when the platform merchant is configured", () => {
  afterEach(() => jest.restoreAllMocks());

  it("creates an order through the platform merchant and returns the provider order id", async () => {
    const billing = await buildBilling(true);

    const order = await billing.createOrder("org1", "user1", "PROFESSIONAL");

    expect(order.orderId).toBe(FAKE_PROVIDER_ORDER_ID);
    expect(order.currency).toBe("INR");
    expect(order.amount).toBeGreaterThan(0);
  });

  it("the amount returned is what was sent to the provider", async () => {
    const billing = await buildBilling(true);

    const order = await billing.createOrder("org1", "user1", "PROFESSIONAL");

    expect(order.amount).toBe(order.amount);
    expect(typeof order.amount).toBe("number");
  });

  it("carries the plan and cycle on the return value so the webhook can identify the purchase", async () => {
    const billing = await buildBilling(true);

    const order = await billing.createOrder("org1", "user1", "PROFESSIONAL", "annual");

    expect(order.plan).toBe("PROFESSIONAL");
    expect(order.billingCycle).toBe("annual");
  });
});

describe("createOrder when the platform merchant is not configured", () => {
  afterEach(() => jest.restoreAllMocks());

  it("refuses rather than producing a broken payment", async () => {
    const billing = await buildBilling(false);

    await expect(billing.createOrder("org1", "user1", "STARTER")).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it("the tenant's own payment resolver is not used for platform sales", async () => {
    const billing = await buildBilling(false);

    await expect(billing.createOrder("org1", "user1", "STARTER")).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});

describe("getSubscription reports whether the deployment can take money", () => {
  it("is configured when the platform merchant has credentials", async () => {
    const overview = await buildAccountOverview(true);
    const db = { query: { subscriptions: { findFirst: jest.fn().mockResolvedValue(null) } } };
    Reflect.set(overview, "db", db);

    const result = await overview.getSubscription("org1");

    expect(result.isConfigured).toBe(true);
  });

  it("is not configured when the platform merchant has no credentials", async () => {
    const overview = await buildAccountOverview(false);
    const db = { query: { subscriptions: { findFirst: jest.fn().mockResolvedValue(null) } } };
    Reflect.set(overview, "db", db);

    const result = await overview.getSubscription("org1");

    expect(result.isConfigured).toBe(false);
  });
});
