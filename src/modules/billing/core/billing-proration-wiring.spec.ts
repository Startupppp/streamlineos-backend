import { Test } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AuditService } from "../../../common/audit/audit.service";
import { ExternalEffectLedger } from "../../../common/outbox/external-effect-ledger";
import { OutboxConsumerRegistry } from "../../../common/outbox/outbox-consumer.registry";
import {
  PaymentProviderResolver,
  type OrganizationPaymentProvider,
} from "../payments/payment-provider-resolver.service";
import { PlatformPaymentRegistry } from "./platform-payment-registry";
import { fakePlatformRegistry, FAKE_PLATFORM_PAYMENT_SIG } from "./testing/fake-platform-provider";
import { PaymentAnalyticsService } from "../payments/payment-analytics.service";
import { PaymentWebhookReceiverService } from "../payments/payment-webhook-receiver.service";
import { FakeProviderAdapter } from "../payments/testing/fake-provider-adapter";
import { AiCreditsService } from "./ai-credits.service";
import { BillingProfileService } from "./billing-profile.service";
import { BillingService } from "./billing.service";
import { PlanLimitsService } from "./plan-limits.service";
import { ProrationLedgerService } from "./proration-ledger.service";
import { RevenueAnalyticsService } from "./revenue-analytics.service";
import { VersionedCatalogService } from "./versioned-catalog.service";

const NOW = new Date();
const PERIOD_START = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000);
const PERIOD_END = new Date(NOW.getTime() + 20 * 24 * 60 * 60 * 1000);

const UPGRADE_INPUT = {
  orderId: "order_test_1",
  paymentId: "pay_test_abc123",
  // The PLATFORM gateway signs a subscription charge; the tenant-facing adapter
  // signs the other direction of travel and its constant no longer applies here.
  signature: FAKE_PLATFORM_PAYMENT_SIG,
  plan: "PROFESSIONAL" as const,
};

function priceVersion(id: number, amountMinor: number) {
  return {
    id,
    planId: id,
    amountMinor,
    currency: "INR",
    billingInterval: "MONTH",
    taxBehavior: "EXCLUSIVE",
    effectiveFrom: PERIOD_START,
    effectiveUntil: null,
  };
}

function makeResolver() {
  const adapter = new FakeProviderAdapter("razorpay");
  const provider: OrganizationPaymentProvider = {
    providerKey: "razorpay",
    environment: "test",
    isReady: () => adapter.isReady(),
    publicKeyId: () => adapter.publicKeyId(),
    createOrder: (params) =>
      adapter.createOrder({ ...params, keyId: "fake-public", keySecret: "fake-private" }),
    verifyPaymentSignature: (params) =>
      adapter.verifyPaymentSignature({ ...params, keySecret: "fake-private" }),
    verifyWebhookSignature: (params) =>
      adapter.verifyWebhookSignature({
        ...params,
        webhookSecret: "fake-webhook-secret-at-least-32chars",
      }),
    normalizeWebhook: (rawBody) => adapter.normalizeWebhook(rawBody),
  };
  return {
    resolve: jest.fn().mockResolvedValue(provider),
    resolveConfigured: jest.fn().mockResolvedValue(provider),
  } as unknown as PaymentProviderResolver;
}

/** The transaction double invokes its callback; a bare jest.fn() would void every assertion inside it. */
function makeDb(subscription: Record<string, unknown> | null) {
  const tx = {
    query: { subscriptions: { findFirst: jest.fn().mockResolvedValue(subscription) } },
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockImplementation(() => ({
      values: () => {
        const rows = [{ id: 1 }];
        return {
          returning: () => Promise.resolve(rows),
          then: (resolve: (value: typeof rows) => unknown) => Promise.resolve(rows).then(resolve),
        };
      },
    })),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      for: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([{ id: 42, maxUses: null, usedCount: 0 }]),
    }),
    execute: jest.fn().mockResolvedValue([]),
  };

  return {
    _tx: tx,
    transaction: jest
      .fn()
      .mockImplementation((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    query: {
      subscriptions: { findFirst: jest.fn().mockResolvedValue(subscription) },
      coupons: { findFirst: jest.fn().mockResolvedValue(null) },
      couponRedemptions: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue([]),
    }),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
    execute: jest.fn().mockResolvedValue([]),
  };
}

async function buildService(options: {
  subscription: Record<string, unknown> | null;
  recordPlanChange: jest.Mock;
  prices: Record<string, ReturnType<typeof priceVersion> | null>;
}) {
  const db = makeDb(options.subscription);
  const moduleRef = await Test.createTestingModule({
    providers: [
      BillingService,
      RevenueAnalyticsService,
      { provide: DRIZZLE, useValue: db },
      { provide: OutboxConsumerRegistry, useValue: { register: jest.fn(), get: jest.fn() } },
      {
        provide: AiCreditsService,
        useValue: {
          grantPlanCredits: jest.fn().mockResolvedValue(undefined),
          listPacks: jest.fn().mockResolvedValue([]),
        },
      },
      { provide: AuditService, useValue: { log: jest.fn(), logCritical: jest.fn() } },
      {
        provide: PlanLimitsService,
        useValue: { bust: jest.fn(), resolveTier: jest.fn().mockResolvedValue({ plan: "STARTER" }) },
      },
      { provide: ProrationLedgerService, useValue: { recordPlanChange: options.recordPlanChange } },
      {
        provide: VersionedCatalogService,
        useValue: {
          getActivePriceForPlanTier: jest
            .fn()
            .mockImplementation((tier: string) => Promise.resolve(options.prices[tier] ?? null)),
        },
      },
      { provide: PaymentProviderResolver, useValue: makeResolver() },
      { provide: PlatformPaymentRegistry, useValue: fakePlatformRegistry().registry },
      {
        provide: ExternalEffectLedger,
        useValue: {
          execute: jest.fn().mockImplementation(async (_effect: unknown, send: () => Promise<void>) => {
            await send();
            return "EXECUTED";
          }),
        },
      },
      { provide: PaymentWebhookReceiverService, useValue: { recordSignatureFailure: jest.fn() } },
      { provide: PaymentAnalyticsService, useValue: { notifyOwner: jest.fn(), track: jest.fn() } },
      { provide: BillingProfileService, useValue: { get: jest.fn(), update: jest.fn() } },
    ],
  }).compile();

  return { service: moduleRef.get(BillingService), db };
}

const ACTIVE_STARTER = {
  id: 7,
  orgId: "org1",
  plan: "STARTER",
  status: "ACTIVE",
  currentPeriodStart: PERIOD_START,
  currentPeriodEnd: PERIOD_END,
};

const PRICES = {
  STARTER: priceVersion(1, 100_000),
  PROFESSIONAL: priceVersion(2, 300_000),
};

beforeEach(() => jest.clearAllMocks());

describe("BillingService — a plan change produces a proration line", () => {
  it("records the change against the subscription, inside the payment transaction", async () => {
    const recordPlanChange = jest.fn().mockResolvedValue(undefined);
    const { service, db } = await buildService({
      subscription: ACTIVE_STARTER,
      recordPlanChange,
      prices: PRICES,
    });

    await service.verifyAndActivate("org1", "user1", UPGRADE_INPUT);

    expect(recordPlanChange).toHaveBeenCalledTimes(1);
    const [line, executor] = recordPlanChange.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(line).toMatchObject({
      orgId: "org1",
      subscriptionId: 7,
      oldPriceVersionId: 1,
      newPriceVersionId: 2,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });
    expect(executor).toBe(db._tx);
  });

  it("passes no amount and no line type, so the ledger derives both from the price versions", async () => {
    const recordPlanChange = jest.fn().mockResolvedValue(undefined);
    const { service } = await buildService({
      subscription: ACTIVE_STARTER,
      recordPlanChange,
      prices: PRICES,
    });

    await service.verifyAndActivate("org1", "user1", UPGRADE_INPUT);

    const [line] = recordPlanChange.mock.calls[0] as [Record<string, unknown>];
    expect(line).not.toHaveProperty("amountMinor");
    expect(line).not.toHaveProperty("lineType");
    expect(line["idempotencyKey"]).toMatch(/^sub:7:2:/);
  });

  it("records nothing when the plan did not actually change", async () => {
    const recordPlanChange = jest.fn().mockResolvedValue(undefined);
    const { service } = await buildService({
      subscription: ACTIVE_STARTER,
      recordPlanChange,
      prices: PRICES,
    });

    await service.verifyAndActivate("org1", "user1", { ...UPGRADE_INPUT, plan: "STARTER" });

    expect(recordPlanChange).not.toHaveBeenCalled();
  });

  it("records nothing for a first subscription, which is a purchase and not a proration", async () => {
    const recordPlanChange = jest.fn().mockResolvedValue(undefined);
    const { service } = await buildService({
      subscription: null,
      recordPlanChange,
      prices: PRICES,
    });

    await service.verifyAndActivate("org1", "user1", UPGRADE_INPUT);

    expect(recordPlanChange).not.toHaveBeenCalled();
  });
});

describe("BillingService — an unseeded price catalog cannot fail a captured payment", () => {
  it("still activates the plan, and reports the missing price version rather than swallowing it", async () => {
    const errors: unknown[] = [];
    jest.spyOn(Logger.prototype, "error").mockImplementation((...args: unknown[]) => void errors.push(args));

    const recordPlanChange = jest.fn().mockResolvedValue(undefined);
    const { service } = await buildService({
      subscription: ACTIVE_STARTER,
      recordPlanChange,
      prices: { STARTER: null, PROFESSIONAL: null },
    });

    await expect(service.verifyAndActivate("org1", "user1", UPGRADE_INPUT)).resolves.toMatchObject({
      success: true,
      plan: "PROFESSIONAL",
    });
    expect(recordPlanChange).not.toHaveBeenCalled();
    expect(JSON.stringify(errors)).toContain("no active price version");
  });

  it("records nothing when the change falls outside the billed period", async () => {
    const recordPlanChange = jest.fn().mockResolvedValue(undefined);
    const { service } = await buildService({
      subscription: {
        ...ACTIVE_STARTER,
        currentPeriodStart: new Date("2020-01-01T00:00:00Z"),
        currentPeriodEnd: new Date("2020-02-01T00:00:00Z"),
      },
      recordPlanChange,
      prices: PRICES,
    });

    await service.verifyAndActivate("org1", "user1", UPGRADE_INPUT);

    expect(recordPlanChange).not.toHaveBeenCalled();
  });

  it("records nothing when the subscription has no billed period to prorate", async () => {
    const recordPlanChange = jest.fn().mockResolvedValue(undefined);
    const { service } = await buildService({
      subscription: { ...ACTIVE_STARTER, currentPeriodStart: null, currentPeriodEnd: null },
      recordPlanChange,
      prices: PRICES,
    });

    await service.verifyAndActivate("org1", "user1", UPGRADE_INPUT);

    expect(recordPlanChange).not.toHaveBeenCalled();
  });
});
