import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import {
  couponRedemptions,
  coupons,
  outboxEvents,
  subscriptionPayments,
  subscriptionPurchases,
  subscriptions,
} from "../../../db/schema";
import type { SubscriptionPurchase } from "../../../db/schema/billing/subscription-purchases";
import { ANNUAL_DISCOUNT_PCT } from "./plan-entitlements.constants";
import { BillingService } from "./billing.service";
import { AiCreditsService } from "./ai-credits.service";
import { AuditService } from "../../../common/audit/audit.service";
import { PlanLimitsService } from "./plan-limits.service";
import { ProrationLedgerService } from "./proration-ledger.service";
import { VersionedCatalogService } from "./versioned-catalog.service";
import { RevenueAnalyticsService } from "./revenue-analytics.service";
import { OutboxConsumerRegistry } from "../../../common/outbox/outbox-consumer.registry";
import { ExternalEffectLedger } from "../../../common/outbox/external-effect-ledger";
import { PaymentProviderResolver, type OrganizationPaymentProvider } from "../payments/payment-provider-resolver.service";
import type { ProviderPaymentSnapshot } from "../payments/payment-provider-adapter.interface";
import { PaymentWebhookReceiverService } from "../payments/payment-webhook-receiver.service";
import { PaymentAnalyticsService } from "../payments/payment-analytics.service";
import { BillingProfileService } from "./billing-profile.service";
import { PlatformMerchantService } from "../payments/platform-merchant.service";
import { CacheService } from "../../../common/cache/cache.service";
import { PLAN_PRICES_PAISE } from "./plan-entitlements.constants";
import { COUPON_EXHAUSTED, COUPON_EXPIRED, COUPON_WRONG_PLAN } from "./coupon-pricing";
import {
  FakeProviderAdapter,
  FAKE_VALID_PAYMENT_SIG,
  FAKE_PROVIDER_ORDER_ID,
  FAKE_PUBLIC_KEY_ID,
} from "../payments/testing/fake-provider-adapter";

const ORDER_ID = "order_test_1";
const PAYMENT_ID = "pay_test_abc123";
const MONTHLY_PAISE = PLAN_PRICES_PAISE.STARTER;
const ANNUAL_PAISE = Math.round(PLAN_PRICES_PAISE.STARTER * 12 * (1 - ANNUAL_DISCOUNT_PCT));

const VALID_INPUT = {
  orderId: ORDER_ID,
  paymentId: PAYMENT_ID,
  signature: FAKE_VALID_PAYMENT_SIG,
};

const WRONG_SIG_INPUT = { ...VALID_INPUT, signature: "forged-signature" };

function makePurchase(overrides: Partial<SubscriptionPurchase> = {}): SubscriptionPurchase {
  const now = new Date("2026-01-01T00:00:00Z");
  return {
    id: 7,
    orgId: "org1",
    createdByUserId: "user1",
    providerKey: "razorpay",
    environment: "test",
    merchantKeyId: FAKE_PUBLIC_KEY_ID,
    providerOrderId: ORDER_ID,
    plan: "STARTER",
    billingCycle: "monthly",
    catalogVersion: null,
    baseAmountMinor: MONTHLY_PAISE,
    discountAmountMinor: 0,
    amountMinor: MONTHLY_PAISE,
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
    ...overrides,
  };
}

function snapshotFor(purchase: SubscriptionPurchase): ProviderPaymentSnapshot {
  return {
    paymentId: PAYMENT_ID,
    orderId: purchase.providerOrderId,
    status: "captured",
    amountMinor: purchase.amountMinor,
    currency: purchase.currency,
  };
}

function makeProvider(
  withAdapter = true,
  providerKey = "razorpay",
  snapshot: ProviderPaymentSnapshot | null = snapshotFor(makePurchase()),
): OrganizationPaymentProvider | undefined {
  if (!withAdapter) return undefined;
  const adapter = new FakeProviderAdapter(providerKey);
  return {
    providerKey,
    environment: "test",
    isReady: () => adapter.isReady(),
    publicKeyId: () => adapter.publicKeyId(),
    createOrder: (params) => adapter.createOrder({ ...params, keyId: "fake-public", keySecret: "fake-private" }),
    verifyPaymentSignature: (params) => adapter.verifyPaymentSignature({ ...params, keySecret: "fake-private" }),
    verifyWebhookSignature: (params) => adapter.verifyWebhookSignature({ ...params, webhookSecret: "fake-webhook-secret-at-least-32chars" }),
    fetchPayment: () => Promise.resolve(snapshot),
    normalizeWebhook: (rawBody) => adapter.normalizeWebhook(rawBody),
  };
}

function makeResolver(withAdapter = true, providerKey = "razorpay") {
  const provider = makeProvider(withAdapter, providerKey);
  return {
    resolve: jest.fn().mockResolvedValue(provider),
    resolveConfigured: jest.fn().mockResolvedValue(provider),
  } as unknown as PaymentProviderResolver;
}

interface MerchantOptions {
  configured?: boolean;
  snapshot?: ProviderPaymentSnapshot | null;
  publicKeyId?: string | null;
  environment?: "test" | "live" | null;
  providerKey?: string;
}

function makePlatformMerchant(options: MerchantOptions = {}) {
  const configured = options.configured ?? true;
  const providerKey = options.providerKey ?? "razorpay";
  const snapshot = options.snapshot === undefined ? snapshotFor(makePurchase()) : options.snapshot;
  const publicKeyId = options.publicKeyId === undefined
    ? (configured ? FAKE_PUBLIC_KEY_ID : null)
    : options.publicKeyId;
  const environment = options.environment === undefined
    ? (configured ? "test" : null)
    : options.environment;
  const provider = configured ? makeProvider(true, providerKey, snapshot) : undefined;

  return {
    providerKey,
    resolve: jest.fn().mockReturnValue(provider),
    readiness: jest.fn().mockReturnValue({
      configured,
      providerKey,
      environment,
      publicKeyId,
      webhookConfigured: configured,
      unavailableReason: configured ? null : "no_credentials",
    }),
    environment: jest.fn().mockReturnValue(environment),
  } as unknown as PlatformMerchantService;
}

interface CouponRow {
  id: number;
  type: string;
  value: string;
  maxUses: number | null;
  usedCount: number;
  applicablePlans: string[] | null;
  expiresAt: Date | null;
  isActive?: boolean;
}

function makeCoupon(overrides: Partial<CouponRow> = {}): CouponRow {
  return {
    id: 42,
    type: "PERCENTAGE",
    value: "10",
    maxUses: null,
    usedCount: 0,
    applicablePlans: null,
    expiresAt: null,
    isActive: true,
    ...overrides,
  };
}

const SUMMARY_ROW = {
  count: 0,
  totalPaid: "0",
  totalOutstanding: "0",
  draft: 0,
  issued: 0,
  paid: 0,
  failed: 0,
  voided: 0,
};

interface DbOptions {
  subscription?: { id: number; orgId: string; plan: string; status: string } | null;
  purchase?: SubscriptionPurchase | null;
  purchaseReads?: (SubscriptionPurchase | null)[];
  lockedPurchase?: SubscriptionPurchase | null;
  activatedPurchase?: SubscriptionPurchase | null;
  couponReserved?: boolean;
  lockedCoupon?: { id: number; type?: string; value?: string; maxUses: number | null; usedCount: number } | null;
  coupon?: CouponRow | null;
  alreadyRedeemed?: boolean;
  transactionRejects?: unknown;
}

// The transaction mock invokes its callback: a bare jest.fn() voids every assertion inside it.
function makeDb(options: DbOptions = {}) {
  const subscription =
    options.subscription === undefined
      ? { id: 1, orgId: "org1", plan: "STARTER", status: "ACTIVE" }
      : options.subscription;

  const basePurchase = options.purchase === undefined ? makePurchase() : options.purchase;
  const purchaseReads = options.purchaseReads ?? [basePurchase];
  const lockedPurchase = options.lockedPurchase === undefined ? basePurchase : options.lockedPurchase;
  const activatedPurchase =
    options.activatedPurchase === undefined
      ? (basePurchase ? makePurchase({ ...basePurchase, status: "ACTIVATED" }) : null)
      : options.activatedPurchase;
  const couponReserved = options.couponReserved ?? true;

  const store = {
    outbox: [] as Array<Record<string, unknown>>,
    inserts: [] as unknown[],
    allInserts: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
    allUpdates: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  };

  let purchaseReadIndex = 0;
  function nextPurchaseRead(): SubscriptionPurchase | null {
    const index = Math.min(purchaseReadIndex, purchaseReads.length - 1);
    purchaseReadIndex += 1;
    return purchaseReads[index] ?? null;
  }

  const lockedCouponRows =
    options.lockedCoupon === undefined
      ? [{ id: 42, type: "PERCENTAGE", value: "10", maxUses: null, usedCount: 0 }]
      : options.lockedCoupon
        ? [options.lockedCoupon]
        : [];

  function selectRowsFor(table: unknown, scope: "db" | "tx"): Record<string, unknown>[] {
    if (table === subscriptionPurchases) {
      const row = scope === "db" ? nextPurchaseRead() : lockedPurchase;
      return row ? [row] : [];
    }
    if (table === coupons) return lockedCouponRows;
    return [SUMMARY_ROW];
  }

  function updateRowsFor(table: unknown): Record<string, unknown>[] {
    if (table === subscriptionPurchases) return activatedPurchase ? [activatedPurchase] : [];
    if (table === coupons) return couponReserved ? [{ id: 42 }] : [];
    return [];
  }

  function makeSelectChain(scope: "db" | "tx") {
    let table: unknown = null;
    const rows = () => selectRowsFor(table, scope);
    const chain: Record<string, unknown> = {};
    chain["from"] = (t: unknown) => {
      table = t;
      return chain;
    };
    chain["innerJoin"] = () => chain;
    chain["leftJoin"] = () => chain;
    chain["where"] = () => chain;
    chain["for"] = () => chain;
    chain["orderBy"] = () => chain;
    chain["groupBy"] = () => chain;
    chain["offset"] = () => chain;
    chain["limit"] = () => Promise.resolve(rows());
    chain["then"] = (resolve: (value: Record<string, unknown>[]) => unknown) =>
      Promise.resolve(rows()).then(resolve);
    return chain;
  }

  function makeUpdateChain(table: unknown) {
    const rows = () => updateRowsFor(table);
    const chain: Record<string, unknown> = {};
    chain["set"] = (values: Record<string, unknown>) => {
      store.allUpdates.push({ table, values });
      return chain;
    };
    chain["where"] = () => chain;
    chain["returning"] = () => Promise.resolve(rows());
    chain["then"] = (resolve: (value: Record<string, unknown>[]) => unknown) =>
      Promise.resolve(rows()).then(resolve);
    return chain;
  }

  function makeInsert() {
    return jest.fn().mockImplementation((table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        store.inserts.push(table);
        store.allInserts.push({ table, values });
        if (table === outboxEvents) store.outbox.push(values);
        const rows =
          table === subscriptionPurchases
            ? [makePurchase({ ...(basePurchase ?? makePurchase()), id: 7 })]
            : [{ id: 1 }];
        return {
          onConflictDoNothing: () => ({ returning: () => Promise.resolve(rows) }),
          returning: () => Promise.resolve(rows),
          then: (resolve: (value: typeof rows) => unknown) => Promise.resolve(rows).then(resolve),
        };
      },
    }));
  }

  const tx = {
    query: { subscriptions: { findFirst: jest.fn().mockResolvedValue(subscription) } },
    update: jest.fn().mockImplementation((table: unknown) => makeUpdateChain(table)),
    insert: makeInsert(),
    select: jest.fn().mockImplementation(() => makeSelectChain("tx")),
    execute: jest.fn().mockResolvedValue([]),
  };

  const transaction = options.transactionRejects
    ? jest.fn().mockRejectedValue(options.transactionRejects)
    : jest.fn().mockImplementation((fn: (t: typeof tx) => Promise<unknown>) => fn(tx));

  return {
    transaction,
    query: {
      subscriptions: { findFirst: jest.fn().mockResolvedValue(subscription) },
      coupons: { findFirst: jest.fn().mockResolvedValue(options.coupon ?? null) },
      couponRedemptions: { findFirst: jest.fn().mockResolvedValue(options.alreadyRedeemed ? { id: 1 } : null) },
    },
    select: jest.fn().mockImplementation(() => makeSelectChain("db")),
    update: jest.fn().mockImplementation((table: unknown) => makeUpdateChain(table)),
    insert: makeInsert(),
    execute: jest.fn().mockResolvedValue([]),
    _tx: tx,
    _store: store,
  };
}

async function buildService(
  db: unknown,
  providers: PaymentProviderResolver,
  aiCredits?: Record<string, jest.Mock>,
  merchant: PlatformMerchantService = makePlatformMerchant(),
): Promise<BillingService> {
  const module = await Test.createTestingModule({
    providers: [
      BillingService,
      RevenueAnalyticsService,
      { provide: DRIZZLE, useValue: db },
      { provide: OutboxConsumerRegistry, useValue: { register: jest.fn(), get: jest.fn() } },
      {
        provide: AiCreditsService,
        useValue: aiCredits ?? {
          grantPlanCredits: jest.fn().mockResolvedValue(undefined),
          listPacks: jest.fn().mockResolvedValue([]),
        },
      },
      { provide: AuditService, useValue: { log: jest.fn(), logCritical: jest.fn() } },
      { provide: PlanLimitsService, useValue: { bust: jest.fn(), resolveTier: jest.fn().mockResolvedValue({ plan: "STARTER" }) } },

      { provide: ProrationLedgerService, useValue: { recordPlanChange: jest.fn().mockResolvedValue(undefined) } },

      { provide: VersionedCatalogService, useValue: { getActivePriceForPlanTier: jest.fn().mockResolvedValue(null) } },
      { provide: PaymentProviderResolver, useValue: providers },
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
      { provide: PlatformMerchantService, useValue: merchant },
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
  return module.get(BillingService);
}

describe("BillingService.verifyAndActivate — binds the confirmation to the stored purchase", () => {
  it("happy path — returns the plan and cycle recorded on the purchase, not one the caller chose", async () => {
    const svc = await buildService(makeDb(), makeResolver());
    await expect(svc.verifyAndActivate("org1", "user1", VALID_INPUT)).resolves.toMatchObject({
      success: true,
      plan: "STARTER",
      billingCycle: "monthly",
      status: "ACTIVE",
      alreadyActivated: false,
    });
  });

  it("an unrelated unique violation propagates instead of being reported as success", async () => {
    const paymentConflict = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "uniq_subscription_payments_razorpay_payment",
    });
    const db = makeDb({ transactionRejects: paymentConflict });
    const svc = await buildService(db, makeResolver());
    await expect(svc.verifyAndActivate("org1", "user1", VALID_INPUT)).rejects.toThrow("duplicate key");
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("non-23505 DB error propagates — service does not swallow unexpected failures", async () => {
    const svc = await buildService(makeDb({ transactionRejects: new Error("deadlock detected") }), makeResolver());
    await expect(svc.verifyAndActivate("org1", "user1", VALID_INPUT)).rejects.toThrow("deadlock detected");
  });

  it("wrong signature — throws BadRequestException", async () => {
    const svc = await buildService(makeDb(), makeResolver());
    await expect(svc.verifyAndActivate("org1", "user1", WRONG_SIG_INPUT)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("wrong signature — NO partial record written (transaction never called)", async () => {
    const db = makeDb();
    const svc = await buildService(db, makeResolver());
    await expect(svc.verifyAndActivate("org1", "user1", WRONG_SIG_INPUT)).rejects.toBeInstanceOf(BadRequestException);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("no configured merchant — throws ServiceUnavailableException before any DB write", async () => {
    const db = makeDb();
    const svc = await buildService(db, makeResolver(), undefined, makePlatformMerchant({ configured: false }));
    await expect(svc.verifyAndActivate("org1", "user1", VALID_INPUT)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("no configured merchant — error message does not leak key or secret", async () => {
    const svc = await buildService(makeDb(), makeResolver(), undefined, makePlatformMerchant({ configured: false }));
    const error = await svc.verifyAndActivate("org1", "user1", VALID_INPUT).catch((e: unknown) => e);
    const message = (error as { message?: string }).message ?? "";
    expect(message).not.toContain("fake-private");
    expect(message).not.toContain("fake-public");
  });

  it("an order id with no purchase record is refused", async () => {
    const db = makeDb({ purchase: null });
    const svc = await buildService(db, makeResolver());
    await expect(svc.verifyAndActivate("org1", "user1", VALID_INPUT)).rejects.toBeInstanceOf(NotFoundException);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

describe("BillingService.verifyAndActivate — cross-tenant and merchant substitution", () => {
  it("another organisation's order id returns 404, not 403, and writes nothing", async () => {
    const db = makeDb({ purchase: makePurchase({ orgId: "org_other" }) });
    const svc = await buildService(db, makeResolver());

    const error = await svc.verifyAndActivate("org1", "user1", VALID_INPUT).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db._store.allInserts).toHaveLength(0);
  });

  it("a purchase created under a different merchant key is refused", async () => {
    const db = makeDb({ purchase: makePurchase({ merchantKeyId: "rotated_key_999" }) });
    const svc = await buildService(db, makeResolver());
    await expect(svc.verifyAndActivate("org1", "user1", VALID_INPUT)).rejects.toBeInstanceOf(BadRequestException);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("a test-environment purchase is refused against a live merchant", async () => {
    const db = makeDb({ purchase: makePurchase({ environment: "test" }) });
    const merchant = makePlatformMerchant({ environment: "live" });
    const svc = await buildService(db, makeResolver(), undefined, merchant);
    await expect(svc.verifyAndActivate("org1", "user1", VALID_INPUT)).rejects.toBeInstanceOf(BadRequestException);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

describe("BillingService.verifyAndActivate — the provider's own view of the payment decides", () => {
  it("a payment the provider does not know is refused", async () => {
    const db = makeDb();
    const svc = await buildService(db, makeResolver(), undefined, makePlatformMerchant({ snapshot: null }));
    await expect(svc.verifyAndActivate("org1", "user1", VALID_INPUT)).rejects.toBeInstanceOf(BadRequestException);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("an authorized-but-not-captured payment is refused", async () => {
    const purchase = makePurchase();
    const db = makeDb({ purchase });
    const merchant = makePlatformMerchant({
      snapshot: { ...snapshotFor(purchase), status: "authorized" },
    });
    const svc = await buildService(db, makeResolver(), undefined, merchant);

    const error = await svc.verifyAndActivate("org1", "user1", VALID_INPUT).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as { message: string }).message).toContain("authorized");
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("a payment against a different order is refused", async () => {
    const purchase = makePurchase();
    const db = makeDb({ purchase });
    const merchant = makePlatformMerchant({
      snapshot: { ...snapshotFor(purchase), orderId: "order_somebody_else" },
    });
    const svc = await buildService(db, makeResolver(), undefined, merchant);
    await expect(svc.verifyAndActivate("org1", "user1", VALID_INPUT)).rejects.toBeInstanceOf(BadRequestException);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("an amount mismatch marks the purchase FAILED and does not activate", async () => {
    const purchase = makePurchase();
    const db = makeDb({ purchase });
    const merchant = makePlatformMerchant({
      snapshot: { ...snapshotFor(purchase), amountMinor: 1 },
    });
    const svc = await buildService(db, makeResolver(), undefined, merchant);

    await expect(svc.verifyAndActivate("org1", "user1", VALID_INPUT)).rejects.toBeInstanceOf(BadRequestException);

    const failed = db._store.allUpdates.find((u) => u.table === subscriptionPurchases);
    expect(failed?.values.status).toBe("FAILED");
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("a currency mismatch marks the purchase FAILED and does not activate", async () => {
    const purchase = makePurchase();
    const db = makeDb({ purchase });
    const merchant = makePlatformMerchant({
      snapshot: { ...snapshotFor(purchase), currency: "USD" },
    });
    const svc = await buildService(db, makeResolver(), undefined, merchant);

    await expect(svc.verifyAndActivate("org1", "user1", VALID_INPUT)).rejects.toBeInstanceOf(BadRequestException);

    const failed = db._store.allUpdates.find((u) => u.table === subscriptionPurchases);
    expect(failed?.values.status).toBe("FAILED");
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

describe("BillingService.verifyAndActivate — activation happens once", () => {
  it("a purchase already ACTIVATED returns the stored outcome and grants no further credits", async () => {
    const aiCredits = {
      grantPlanCredits: jest.fn().mockResolvedValue(undefined),
      listPacks: jest.fn().mockResolvedValue([]),
    };
    const activated = makePurchase({ status: "ACTIVATED", activatedAt: new Date("2026-01-02T00:00:00Z") });
    const db = makeDb({ purchase: activated });
    const svc = await buildService(db, makeResolver(), aiCredits);

    const result = await svc.verifyAndActivate("org1", "user1", VALID_INPUT);

    expect(result).toMatchObject({ success: true, plan: "STARTER", alreadyActivated: true });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(aiCredits.grantPlanCredits).not.toHaveBeenCalled();
  });

  it("a concurrent confirmation that loses the conditional transition returns the stored outcome", async () => {
    const pending = makePurchase();
    const winner = makePurchase({ status: "ACTIVATED", activatedAt: new Date("2026-01-02T00:00:00Z") });
    const aiCredits = {
      grantPlanCredits: jest.fn().mockResolvedValue(undefined),
      listPacks: jest.fn().mockResolvedValue([]),
    };
    const db = makeDb({
      purchase: pending,
      purchaseReads: [pending, winner],
      activatedPurchase: null,
    });
    const svc = await buildService(db, makeResolver(), aiCredits);

    const result = await svc.verifyAndActivate("org1", "user1", VALID_INPUT);

    expect(result).toMatchObject({ success: true, alreadyActivated: true });
    expect(aiCredits.grantPlanCredits).not.toHaveBeenCalled();
  });

  it("a capture arriving after the purchase expired is still fulfilled, not stranded", async () => {
    const expired = makePurchase({ status: "EXPIRED" });
    const db = makeDb({
      purchase: expired,
      lockedPurchase: expired,
      activatedPurchase: makePurchase({ status: "ACTIVATED" }),
    });
    const svc = await buildService(db, makeResolver());

    await expect(svc.verifyAndActivate("org1", "user1", VALID_INPUT)).resolves.toMatchObject({ success: true });

    const paymentInsert = db._store.allInserts.find((i) => i.table === subscriptionPayments);
    expect(paymentInsert?.values.metadata).toMatchObject({ lateCapture: true });
  });
});

describe("BillingService cross-tenant isolation", () => {
  it("does not return another organization's subscription", async () => {
    const db = makeDb({ subscription: null });
    const findSubscription = db.query.subscriptions.findFirst as jest.Mock;
    findSubscription.mockImplementation(async (query: { where?: unknown }) => {
      if (query.where === undefined)
        return { id: 1, orgId: "org_a", plan: "STARTER", status: "ACTIVE" };
      return null;
    });
    const svc = await buildService(db, makeResolver());

    const result = await svc.getSubscription("org_b");

    expect(result.subscription).toBeNull();
    expect(findSubscription).toHaveBeenCalledTimes(1);
  });
});

describe("c17-02 — the checkout does not report success it cannot back", () => {
  it("fails the request when the plan credit grant fails, rather than returning success", async () => {
    const aiCredits = {
      grantPlanCredits: jest.fn().mockRejectedValue(new Error("db unavailable")),
      listPacks: jest.fn().mockResolvedValue([]),
    };
    const svc = await buildService(makeDb(), makeResolver(), aiCredits);

    await expect(svc.verifyAndActivate("org1", "user1", VALID_INPUT)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("says the payment was recorded, so the customer is not told the charge failed", async () => {
    const aiCredits = {
      grantPlanCredits: jest.fn().mockRejectedValue(new Error("db unavailable")),
      listPacks: jest.fn().mockResolvedValue([]),
    };
    const svc = await buildService(makeDb(), makeResolver(), aiCredits);

    const error = await svc.verifyAndActivate("org1", "user1", VALID_INPUT).catch((e: unknown) => e);

    expect((error as { message: string }).message).toContain("Payment recorded");
    expect((error as { message: string }).message).toContain("retry");
  });
});

describe("c17-05 — an activation enqueues its revenue event in the activating transaction", () => {
  it("a first paid activation enqueues new business", async () => {
    const db = makeDb({ subscription: null });
    const svc = await buildService(db, makeResolver());

    await svc.verifyAndActivate("org1", "user1", VALID_INPUT);

    expect(db._store.outbox).toHaveLength(1);
    expect(db._store.outbox[0]).toMatchObject({ eventType: "billing.revenue-event", organizationId: "org1" });
    expect(db._store.outbox[0]?.payload).toMatchObject({
      type: "new_subscription",
      plan: "STARTER",
      mrr: PLAN_PRICES_PAISE.STARTER,
    });
  });

  it("a trial converting to paid enqueues new business, carrying the payment id", async () => {
    const db = makeDb({ subscription: { id: 1, orgId: "org1", plan: "STARTER", status: "TRIAL" } });
    const svc = await buildService(db, makeResolver());

    await svc.verifyAndActivate("org1", "user1", VALID_INPUT);

    const payload = db._store.outbox[0]?.payload as { type: string; metadata: Record<string, unknown> };
    expect(payload.type).toBe("new_subscription");
    expect(payload.metadata).toMatchObject({ paymentId: PAYMENT_ID });
  });

  it("a plan move enqueues the expansion and names the plan it came from", async () => {
    const purchase = makePurchase({ plan: "PROFESSIONAL", amountMinor: PLAN_PRICES_PAISE.PROFESSIONAL, baseAmountMinor: PLAN_PRICES_PAISE.PROFESSIONAL });
    const db = makeDb({
      subscription: { id: 1, orgId: "org1", plan: "STARTER", status: "ACTIVE" },
      purchase,
    });
    const merchant = makePlatformMerchant({ snapshot: snapshotFor(purchase) });
    const svc = await buildService(db, makeResolver(), undefined, merchant);

    await svc.verifyAndActivate("org1", "user1", VALID_INPUT);

    expect(db._store.outbox[0]?.payload).toMatchObject({
      type: "upgrade",
      previousPlan: "STARTER",
      mrr: PLAN_PRICES_PAISE.PROFESSIONAL - PLAN_PRICES_PAISE.STARTER,
    });
  });

  it("a lapsed subscription paying again enqueues a reactivation", async () => {
    const db = makeDb({ subscription: { id: 1, orgId: "org1", plan: "STARTER", status: "CANCELLED" } });
    const svc = await buildService(db, makeResolver());

    await svc.verifyAndActivate("org1", "user1", VALID_INPUT);

    expect(db._store.outbox[0]?.payload).toMatchObject({ type: "reactivation" });
  });

  it("renewing the same plan enqueues nothing — a renewal is not new revenue", async () => {
    const db = makeDb({ subscription: { id: 1, orgId: "org1", plan: "STARTER", status: "ACTIVE" } });
    const svc = await buildService(db, makeResolver());

    await svc.verifyAndActivate("org1", "user1", VALID_INPUT);

    expect(db._store.outbox).toHaveLength(0);
  });

  it("a rolled-back activation enqueues nothing, because the emit is inside that transaction", async () => {
    const db = makeDb({ transactionRejects: new Error("deadlock detected") });
    const svc = await buildService(db, makeResolver());

    await expect(svc.verifyAndActivate("org1", "user1", VALID_INPUT)).rejects.toThrow("deadlock detected");

    expect(db._store.outbox).toHaveLength(0);
  });
});

describe("BillingService.createOrder — records an authoritative purchase", () => {
  it("configured merchant — creates an order and returns providerOrderId and publicKeyId", async () => {
    const svc = await buildService(makeDb(), makeResolver());
    const result = await svc.createOrder("org1", "user1", "STARTER");
    expect(result.orderId).toBe(FAKE_PROVIDER_ORDER_ID);
    expect(result.keyId).toBe(FAKE_PUBLIC_KEY_ID);
    expect(result.plan).toBe("STARTER");
    expect(result.billingCycle).toBe("monthly");
    expect(result.currency).toBe("INR");
    expect(result.environment).toBe("test");
  });

  it("the purchase row carries the immutable plan, cycle and amount the confirmation will read back", async () => {
    const db = makeDb();
    const svc = await buildService(db, makeResolver());

    await svc.createOrder("org1", "user1", "STARTER", "annual");

    const purchaseInsert = db._store.allInserts.find((i) => i.table === subscriptionPurchases);
    expect(purchaseInsert?.values).toMatchObject({
      orgId: "org1",
      plan: "STARTER",
      billingCycle: "annual",
      amountMinor: ANNUAL_PAISE,
      currency: "INR",
      merchantKeyId: FAKE_PUBLIC_KEY_ID,
      environment: "test",
      status: "PENDING",
    });
  });

  it("configured merchant annual cycle — computes discounted amount", async () => {
    const svc = await buildService(makeDb(), makeResolver());
    const result = await svc.createOrder("org1", "user1", "STARTER", "annual");
    expect(result.billingCycle).toBe("annual");
    expect(result.amount).toBe(ANNUAL_PAISE);
  });

  it("no configured merchant — throws ServiceUnavailableException", async () => {
    const svc = await buildService(makeDb(), makeResolver(), undefined, makePlatformMerchant({ configured: false }));
    await expect(svc.createOrder("org1", "user1", "STARTER")).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("no configured merchant — error message does not contain key or secret", async () => {
    const svc = await buildService(makeDb(), makeResolver(), undefined, makePlatformMerchant({ configured: false }));
    const error = await svc.createOrder("org1", "user1", "STARTER").catch((e: unknown) => e);
    const message = (error as { message?: string }).message ?? "";
    expect(message).not.toContain("fake-private");
    expect(message).not.toContain("fake-public");
  });

  it("provider network failure on createOrder propagates, leaving an unclaimed intent row rather than no record at all", async () => {
    const networkError = new Error("ECONNRESET");
    const failingProvider: OrganizationPaymentProvider = {
      providerKey: "razorpay",
      environment: "test",
      isReady: () => true,
      publicKeyId: () => FAKE_PUBLIC_KEY_ID,
      createOrder: jest.fn().mockRejectedValue(networkError),
      verifyPaymentSignature: () => false,
      verifyWebhookSignature: () => false,
      fetchPayment: () => Promise.resolve(null),
      normalizeWebhook: () => ({ ok: false, error: "invalid_json" as const }),
    };
    const merchant = {
      providerKey: "razorpay",
      resolve: jest.fn().mockReturnValue(failingProvider),
      readiness: jest.fn().mockReturnValue({
        configured: true,
        providerKey: "razorpay",
        environment: "test",
        publicKeyId: FAKE_PUBLIC_KEY_ID,
        webhookConfigured: true,
        unavailableReason: null,
      }),
      environment: jest.fn().mockReturnValue("test"),
    } as unknown as PlatformMerchantService;
    const db = makeDb();
    const svc = await buildService(db, makeResolver(), undefined, merchant);

    await expect(svc.createOrder("org1", "user1", "STARTER")).rejects.toThrow("ECONNRESET");

    const intent = db._store.allInserts.find((i) => i.table === subscriptionPurchases);
    expect(intent).toBeDefined();
    expect(intent?.values).toMatchObject({ orgId: "org1", plan: "STARTER", status: "PENDING" });
    expect(intent?.values).toMatchObject({ providerOrderId: null });
  });
});

describe("c17-03 — the checkout prices a coupon under the rules redemption enforces", () => {
  it("applies the discount for an eligible coupon", async () => {
    const db = makeDb({ coupon: makeCoupon({ type: "FIXED", value: "100" }) });
    const svc = await buildService(db, makeResolver());

    const result = await svc.createOrder("org1", "user1", "STARTER", "monthly", 42);

    expect(result.discountAmount).toBe(10_000);
    expect(result.amount).toBe(MONTHLY_PAISE - 10_000);
  });

  it("the discount is recorded on the purchase, so confirmation cannot reprice it", async () => {
    const db = makeDb({ coupon: makeCoupon({ type: "FIXED", value: "100" }) });
    const svc = await buildService(db, makeResolver());

    await svc.createOrder("org1", "user1", "STARTER", "monthly", 42);

    const purchaseInsert = db._store.allInserts.find((i) => i.table === subscriptionPurchases);
    expect(purchaseInsert?.values).toMatchObject({
      baseAmountMinor: MONTHLY_PAISE,
      discountAmountMinor: 10_000,
      amountMinor: MONTHLY_PAISE - 10_000,
      couponId: 42,
    });
  });

  it("refuses an exhausted coupon instead of discounting an order redemption will reject", async () => {
    const db = makeDb({ coupon: makeCoupon({ maxUses: 1, usedCount: 1 }) });
    const svc = await buildService(db, makeResolver());

    await expect(svc.createOrder("org1", "user1", "STARTER", "monthly", 42)).rejects.toThrow(COUPON_EXHAUSTED);
  });

  it("refuses an expired coupon", async () => {
    const db = makeDb({ coupon: makeCoupon({ expiresAt: new Date("2000-01-01") }) });
    const svc = await buildService(db, makeResolver());

    await expect(svc.createOrder("org1", "user1", "STARTER", "monthly", 42)).rejects.toThrow(COUPON_EXPIRED);
  });

  it("refuses a coupon that does not apply to the plan being bought", async () => {
    const db = makeDb({ coupon: makeCoupon({ applicablePlans: ["ENTERPRISE"] }) });
    const svc = await buildService(db, makeResolver());

    await expect(svc.createOrder("org1", "user1", "STARTER", "monthly", 42)).rejects.toThrow(COUPON_WRONG_PLAN);
  });

  it("refuses a coupon this organisation has already redeemed", async () => {
    const db = makeDb({ coupon: makeCoupon(), alreadyRedeemed: true });
    const svc = await buildService(db, makeResolver());

    await expect(svc.createOrder("org1", "user1", "STARTER", "monthly", 42)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("a coupon exhausted between evaluation and reservation is refused, not silently discounted", async () => {
    const db = makeDb({ coupon: makeCoupon(), couponReserved: false });
    const svc = await buildService(db, makeResolver());

    await expect(svc.createOrder("org1", "user1", "STARTER", "monthly", 42)).rejects.toBeInstanceOf(BadRequestException);
    expect(db._store.allInserts.find((i) => i.table === subscriptionPurchases)).toBeUndefined();
  });

  it("validateCoupon reports the same refusal the checkout would raise", async () => {
    const db = makeDb({ coupon: makeCoupon({ maxUses: 2, usedCount: 2 }) });
    const svc = await buildService(db, makeResolver());

    await expect(svc.validateCoupon("SAVE10", "org1", "STARTER")).resolves.toMatchObject({
      valid: false,
      message: COUPON_EXHAUSTED,
    });
  });
});

describe("c17-03 — a coupon reserved at order time is redeemed at activation", () => {
  it("the redemption row is written in the activating transaction", async () => {
    const purchase = makePurchase({ couponId: 42, discountAmountMinor: 9_990, amountMinor: MONTHLY_PAISE - 9_990 });
    const db = makeDb({ purchase });
    const merchant = makePlatformMerchant({ snapshot: snapshotFor(purchase) });
    const svc = await buildService(db, makeResolver(), undefined, merchant);

    await expect(svc.verifyAndActivate("org1", "user1", VALID_INPUT)).resolves.toMatchObject({ success: true });

    const redemption = db._store.allInserts.find((i) => i.table === couponRedemptions);
    expect(redemption?.values).toMatchObject({ couponId: 42, orgId: "org1" });
  });

  it("a purchase with no coupon writes no redemption row", async () => {
    const db = makeDb();
    const svc = await buildService(db, makeResolver());

    await svc.verifyAndActivate("org1", "user1", VALID_INPUT);

    expect(db._store.allInserts.find((i) => i.table === couponRedemptions)).toBeUndefined();
  });

  it("the loser's coupon unique violation becomes a conflict, not a silent success", async () => {
    const couponConflict = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "uq_coupon_redemptions_coupon_org",
    });
    const purchase = makePurchase({ couponId: 42 });
    const db = makeDb({ purchase, transactionRejects: couponConflict });
    const merchant = makePlatformMerchant({ snapshot: snapshotFor(purchase) });
    const svc = await buildService(db, makeResolver(), undefined, merchant);

    await expect(svc.verifyAndActivate("org1", "user1", VALID_INPUT)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("BillingService.getSubscription — readiness comes from the platform merchant", () => {
  it("configured merchant — returns isConfigured true and the public key id", async () => {
    const db = { query: { subscriptions: { findFirst: jest.fn().mockResolvedValue(null) } } };
    const svc = await buildService(db, makeResolver());
    const result = await svc.getSubscription("org1");
    expect(result.isConfigured).toBe(true);
    expect(result.publicKeyId).toBe(FAKE_PUBLIC_KEY_ID);
  });

  it("a tenant with no payment_providers row of its own can still check out", async () => {
    const db = { query: { subscriptions: { findFirst: jest.fn().mockResolvedValue(null) } } };
    const svc = await buildService(db, makeResolver(false));
    const result = await svc.getSubscription("brand-new-org");
    expect(result.isConfigured).toBe(true);
    expect(result.platformCheckout).toMatchObject({ configured: true, unavailableReason: null });
  });

  it("no platform merchant — returns isConfigured false, a null key id and a reason", async () => {
    const db = { query: { subscriptions: { findFirst: jest.fn().mockResolvedValue(null) } } };
    const svc = await buildService(db, makeResolver(), undefined, makePlatformMerchant({ configured: false }));
    const result = await svc.getSubscription("org1");
    expect(result.isConfigured).toBe(false);
    expect(result.publicKeyId).toBeNull();
    expect(result.platformCheckout).toMatchObject({ unavailableReason: "no_credentials" });
  });

  it("the readiness payload never carries a secret", async () => {
    const db = { query: { subscriptions: { findFirst: jest.fn().mockResolvedValue(null) } } };
    const svc = await buildService(db, makeResolver());
    const result = await svc.getSubscription("org1");
    const serialized = JSON.stringify(result.platformCheckout);
    expect(serialized).not.toContain("fake-private");
    expect(serialized).not.toContain("secret");
  });
});

describe("BillingService.getSummary — isConfigured reads the platform merchant", () => {
  it("configured platform merchant — isConfigured is true", async () => {
    const svc = await buildService(makeDb({ subscription: null }), makeResolver());
    await expect(svc.getSummary("org1")).resolves.toMatchObject({ isConfigured: true });
  });

  it("unconfigured platform merchant — isConfigured is false", async () => {
    const svc = await buildService(
      makeDb({ subscription: null }),
      makeResolver(),
      undefined,
      makePlatformMerchant({ configured: false }),
    );
    await expect(svc.getSummary("org1")).resolves.toMatchObject({ isConfigured: false });
  });

  it("agrees with getSubscription for a tenant that has no payment_providers row", async () => {
    const db = makeDb({ subscription: null });
    const svc = await buildService(db, makeResolver(false));
    const [summary, subscription] = await Promise.all([
      svc.getSummary("org1"),
      svc.getSubscription("org1"),
    ]);
    expect(summary.isConfigured).toBe(subscription.isConfigured);
  });
});

describe("billing-cycle — the purchase decides the term, not the caller", () => {
  const msPerDay = 24 * 60 * 60 * 1000;

  it("an annual purchase confirmed by order id alone records the annual discounted amount", async () => {
    const purchase = makePurchase({
      billingCycle: "annual",
      baseAmountMinor: ANNUAL_PAISE,
      amountMinor: ANNUAL_PAISE,
    });
    const db = makeDb({ subscription: null, purchase });
    const merchant = makePlatformMerchant({ snapshot: snapshotFor(purchase) });
    const svc = await buildService(db, makeResolver(), undefined, merchant);

    await svc.verifyAndActivate("org1", "user1", VALID_INPUT);

    const paymentInsert = db._store.allInserts.find((i) => i.table === subscriptionPayments);
    expect(paymentInsert?.values.amountPaise).toBe(ANNUAL_PAISE);
  });

  it("an annual purchase sets currentPeriodEnd twelve months out", async () => {
    const purchase = makePurchase({
      billingCycle: "annual",
      baseAmountMinor: ANNUAL_PAISE,
      amountMinor: ANNUAL_PAISE,
    });
    const db = makeDb({ subscription: null, purchase });
    const merchant = makePlatformMerchant({ snapshot: snapshotFor(purchase) });
    const svc = await buildService(db, makeResolver(), undefined, merchant);

    const before = Date.now();
    await svc.verifyAndActivate("org1", "user1", VALID_INPUT);

    const subInsert = db._store.allInserts.find((i) => i.table === subscriptions);
    const periodEnd = subInsert?.values.currentPeriodEnd;
    if (!(periodEnd instanceof Date)) throw new Error("currentPeriodEnd was not a Date");
    const diff = periodEnd.getTime() - before;
    expect(diff).toBeGreaterThan(360 * msPerDay);
    expect(diff).toBeLessThan(370 * msPerDay);
  });

  it("an annual purchase reports an annual cycle back to the caller", async () => {
    const purchase = makePurchase({
      billingCycle: "annual",
      baseAmountMinor: ANNUAL_PAISE,
      amountMinor: ANNUAL_PAISE,
    });
    const db = makeDb({ subscription: null, purchase });
    const merchant = makePlatformMerchant({ snapshot: snapshotFor(purchase) });
    const svc = await buildService(db, makeResolver(), undefined, merchant);

    await expect(svc.verifyAndActivate("org1", "user1", VALID_INPUT)).resolves.toMatchObject({
      billingCycle: "annual",
    });
  });

  it("a monthly purchase records the monthly price and a one-month period", async () => {
    const db = makeDb({ subscription: null });
    const svc = await buildService(db, makeResolver());

    const before = Date.now();
    await svc.verifyAndActivate("org1", "user1", VALID_INPUT);

    const paymentInsert = db._store.allInserts.find((i) => i.table === subscriptionPayments);
    expect(paymentInsert?.values.amountPaise).toBe(MONTHLY_PAISE);

    const subInsert = db._store.allInserts.find((i) => i.table === subscriptions);
    const periodEnd = subInsert?.values.currentPeriodEnd;
    if (!(periodEnd instanceof Date)) throw new Error("currentPeriodEnd was not a Date");
    const diff = periodEnd.getTime() - before;
    expect(diff).toBeGreaterThan(27 * msPerDay);
    expect(diff).toBeLessThan(32 * msPerDay);
  });

  it("the discounted amount on the purchase is what gets recorded, not the list price", async () => {
    const purchase = makePurchase({
      baseAmountMinor: MONTHLY_PAISE,
      discountAmountMinor: 9_990,
      amountMinor: MONTHLY_PAISE - 9_990,
      couponId: 42,
    });
    const db = makeDb({ subscription: null, purchase });
    const merchant = makePlatformMerchant({ snapshot: snapshotFor(purchase) });
    const svc = await buildService(db, makeResolver(), undefined, merchant);

    await svc.verifyAndActivate("org1", "user1", VALID_INPUT);

    const paymentInsert = db._store.allInserts.find((i) => i.table === subscriptionPayments);
    expect(paymentInsert?.values.amountPaise).toBe(MONTHLY_PAISE - 9_990);
  });
});

describe("BillingService — provider-substitution seam proof", () => {
  it("'razorpay' fake produces a successful order with its provider identifier", async () => {
    const svc = await buildService(makeDb(), makeResolver(), undefined, makePlatformMerchant({ providerKey: "razorpay" }));
    const result = await svc.createOrder("org1", "user1", "STARTER");
    expect(result.orderId).toBe(FAKE_PROVIDER_ORDER_ID);
  });

  it("'stripe' fake produces the same domain outcome with a different provider identifier", async () => {
    const db = makeDb();
    const svc = await buildService(db, makeResolver(), undefined, makePlatformMerchant({ providerKey: "stripe" }));
    const result = await svc.createOrder("org1", "user1", "STARTER");
    expect(result.orderId).toBe(FAKE_PROVIDER_ORDER_ID);
    const purchaseInsert = db._store.allInserts.find((i) => i.table === subscriptionPurchases);
    expect(purchaseInsert?.values.providerKey).toBe("stripe");
  });
});
