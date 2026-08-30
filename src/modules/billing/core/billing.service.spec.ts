import { BadRequestException, ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { outboxEvents, subscriptionPayments, subscriptions, couponRedemptions } from "../../../db/schema";
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
import { PaymentWebhookHealthService } from "../payments/payment-webhook-health.service";
import { PaymentAnalyticsService } from "../payments/payment-analytics.service";
import { PLAN_PRICES_PAISE } from "./plan-entitlements.constants";
import { COUPON_EXHAUSTED, COUPON_EXPIRED, COUPON_WRONG_PLAN } from "./coupon-pricing";
import {
  FakeProviderAdapter,
  FAKE_VALID_PAYMENT_SIG,
  FAKE_PROVIDER_ORDER_ID,
  FAKE_PUBLIC_KEY_ID,
} from "../payments/testing/fake-provider-adapter";

const VALID_INPUT = {
  razorpay_order_id: "order_test_1",
  razorpay_payment_id: "pay_test_abc123",
  razorpay_signature: FAKE_VALID_PAYMENT_SIG,
  plan: "STARTER" as const,
};

const WRONG_SIG_INPUT = { ...VALID_INPUT, razorpay_signature: "forged-signature" };

function makeProvider(withAdapter = true, providerKey = "razorpay"): OrganizationPaymentProvider | undefined {
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

// The transaction mock invokes its callback: a bare jest.fn() voids every assertion inside it.
function makeDb(options: {
  subscription?: { id: number; orgId: string; plan: string; status: string } | null;
  lockedCoupon?: { id: number; type?: string; value?: string; maxUses: number | null; usedCount: number } | null;
  coupon?: CouponRow | null;
  alreadyRedeemed?: boolean;
  transactionRejects?: unknown;
} = {}) {
  const subscription =
    options.subscription === undefined
      ? { id: 1, orgId: "org1", plan: "STARTER", status: "ACTIVE" }
      : options.subscription;

  const store = {
    outbox: [] as Array<Record<string, unknown>>,
    inserts: [] as unknown[],
    allInserts: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  };

  const tx = {
    query: { subscriptions: { findFirst: jest.fn().mockResolvedValue(subscription) } },
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockImplementation((table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        store.inserts.push(table);
        store.allInserts.push({ table, values });
        if (table === outboxEvents) store.outbox.push(values);
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
      limit: jest.fn().mockResolvedValue(
        options.lockedCoupon === undefined
          ? [{ id: 42, type: "PERCENTAGE", value: "10", maxUses: null, usedCount: 0 }]
          : options.lockedCoupon
            ? [options.lockedCoupon]
            : [],
      ),
    }),
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
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue([{
        totalPaid: "0", totalOutstanding: "0", draft: 0, issued: 0, paid: 0, failed: 0, voided: 0,
      }]),
    }),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
    execute: jest.fn().mockResolvedValue([]),
    _tx: tx,
    _store: store,
  };
}

async function buildService(
  db: unknown,
  providers: PaymentProviderResolver,
  aiCredits?: Record<string, jest.Mock>,
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
      { provide: PaymentWebhookHealthService, useValue: { recordSignatureFailure: jest.fn() } },
      { provide: PaymentAnalyticsService, useValue: { notifyOwner: jest.fn(), track: jest.fn() } },
    ],
  }).compile();
  return module.get(BillingService);
}

describe("BillingService.verifyAndActivate — goes through the registry", () => {
  it("happy path — returns success when transaction commits", async () => {
    const svc = await buildService(makeDb(), makeResolver());
    await expect(svc.verifyAndActivate("org1", "user1", VALID_INPUT)).resolves.toEqual({
      success: true,
      plan: "STARTER",
      status: "ACTIVE",
    });
  });

  it("23505 on subscription_payments insert — returns success without re-inserting", async () => {
    const db = makeDb({ transactionRejects: { code: "23505" } });
    const svc = await buildService(db, makeResolver());
    const result = await svc.verifyAndActivate("org1", "user1", VALID_INPUT);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, plan: "STARTER", status: "ACTIVE" });
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

  it("no configured provider — throws ServiceUnavailableException before any DB write", async () => {
    const db = makeDb();
    const svc = await buildService(db, makeResolver(false));
    await expect(svc.verifyAndActivate("org1", "user1", VALID_INPUT)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("no configured provider — error message does not leak key or secret", async () => {
    const svc = await buildService(makeDb(), makeResolver(false));
    const error = await svc.verifyAndActivate("org1", "user1", VALID_INPUT).catch((e: unknown) => e);
    const message = (error as { message?: string }).message ?? "";
    expect(message).not.toContain("fake-private");
    expect(message).not.toContain("fake-public");
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
    expect(payload.metadata).toMatchObject({ paymentId: VALID_INPUT.razorpay_payment_id });
  });

  it("a plan move enqueues the expansion and names the plan it came from", async () => {
    const db = makeDb({ subscription: { id: 1, orgId: "org1", plan: "STARTER", status: "ACTIVE" } });
    const svc = await buildService(db, makeResolver());

    await svc.verifyAndActivate("org1", "user1", { ...VALID_INPUT, plan: "PROFESSIONAL" });

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

describe("BillingService.createOrder — goes through the registry", () => {
  it("configured adapter — creates an order and returns providerOrderId and publicKeyId", async () => {
    const svc = await buildService(makeDb(), makeResolver());
    const result = await svc.createOrder("org1", "user1", "STARTER");
    expect(result.orderId).toBe(FAKE_PROVIDER_ORDER_ID);
    expect(result.keyId).toBe(FAKE_PUBLIC_KEY_ID);
    expect(result.plan).toBe("STARTER");
    expect(result.billingCycle).toBe("monthly");
    expect(result.currency).toBe("INR");
  });

  it("configured adapter annual cycle — computes discounted amount", async () => {
    const svc = await buildService(makeDb(), makeResolver());
    const result = await svc.createOrder("org1", "user1", "STARTER", "annual");
    expect(result.billingCycle).toBe("annual");
    expect(result.amount).toBe(Math.round(PLAN_PRICES_PAISE.STARTER * 12 * 0.8));
  });

  it("no configured provider — throws ServiceUnavailableException", async () => {
    const svc = await buildService(makeDb(), makeResolver(false));
    await expect(svc.createOrder("org1", "user1", "STARTER")).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("no configured provider — error message does not contain key or secret", async () => {
    const svc = await buildService(makeDb(), makeResolver(false));
    const error = await svc.createOrder("org1", "user1", "STARTER").catch((e: unknown) => e);
    const message = (error as { message?: string }).message ?? "";
    expect(message).not.toContain("fake-private");
    expect(message).not.toContain("fake-public");
  });
});

describe("c17-03 — the checkout prices a coupon under the rules redemption enforces", () => {
  it("applies the discount for an eligible coupon", async () => {
    const db = makeDb({ coupon: makeCoupon({ type: "FIXED", value: "100" }) });
    const svc = await buildService(db, makeResolver());

    const result = await svc.createOrder("org1", "user1", "STARTER", "monthly", 42);

    expect(result.discountAmount).toBe(10_000);
    expect(result.amount).toBe(PLAN_PRICES_PAISE.STARTER - 10_000);
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

  it("validateCoupon reports the same refusal the checkout would raise", async () => {
    const db = makeDb({ coupon: makeCoupon({ maxUses: 2, usedCount: 2 }) });
    const svc = await buildService(db, makeResolver());

    await expect(svc.validateCoupon("SAVE10", "org1", "STARTER")).resolves.toMatchObject({
      valid: false,
      message: COUPON_EXHAUSTED,
    });
  });
});

describe("c17-03 — a coupon can be used once", () => {
  it("the counter is incremented and the redemption inserted in the transaction that activates", async () => {
    const db = makeDb({ lockedCoupon: { id: 42, maxUses: 5, usedCount: 0 } });
    const svc = await buildService(db, makeResolver());

    const result = await svc.verifyAndActivate("org1", "user1", { ...VALID_INPUT, couponId: 42 });

    expect(result).toEqual({ success: true, plan: "STARTER", status: "ACTIVE" });
    expect(db._tx.select).toHaveBeenCalledTimes(1);
    expect(db._tx.insert).toHaveBeenCalledTimes(2);
    expect(db._tx.update).toHaveBeenCalledTimes(2);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("two simultaneous redemptions: the loser's unique violation becomes a conflict, not a silent success", async () => {
    const couponConflict = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "uq_coupon_redemptions_coupon_org",
    });
    const svc = await buildService(makeDb({ transactionRejects: couponConflict }), makeResolver());

    await expect(
      svc.verifyAndActivate("org1", "user1", { ...VALID_INPUT, couponId: 42 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("exactly one of two concurrent redemptions succeeds", async () => {
    const couponConflict = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "uq_coupon_redemptions_coupon_org",
    });
    const winner = await buildService(makeDb({ lockedCoupon: { id: 42, maxUses: 1, usedCount: 0 } }), makeResolver());
    const loser = await buildService(makeDb({ transactionRejects: couponConflict }), makeResolver());

    const outcomes = await Promise.allSettled([
      winner.verifyAndActivate("org1", "user1", { ...VALID_INPUT, couponId: 42 }),
      loser.verifyAndActivate("org1", "user2", { ...VALID_INPUT, couponId: 42 }),
    ]);

    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1);
  });

  it("an unrelated 23505 is still treated as a payment replay", async () => {
    const paymentConflict = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "uniq_subscription_payments_razorpay_payment",
    });
    const svc = await buildService(makeDb({ transactionRejects: paymentConflict }), makeResolver());

    await expect(svc.verifyAndActivate("org1", "user1", { ...VALID_INPUT, couponId: 42 })).resolves.toEqual({
      success: true,
      plan: "STARTER",
      status: "ACTIVE",
    });
  });

  describe("a usage limit above one is enforced at exactly that number", () => {
    it.each([
      [0, 3],
      [1, 3],
      [2, 3],
    ])("redemption %i of %i is allowed", async (usedCount, maxUses) => {
      const db = makeDb({ lockedCoupon: { id: 42, maxUses, usedCount } });
      const svc = await buildService(db, makeResolver());
      await expect(svc.verifyAndActivate("org1", "user1", { ...VALID_INPUT, couponId: 42 })).resolves.toMatchObject({
        success: true,
      });
    });

    it("the redemption at the limit is refused before any row is written", async () => {
      const db = makeDb({ lockedCoupon: { id: 42, maxUses: 3, usedCount: 3 } });
      const svc = await buildService(db, makeResolver());

      await expect(
        svc.verifyAndActivate("org1", "user1", { ...VALID_INPUT, couponId: 42 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(db._tx.insert).toHaveBeenCalledTimes(1);
    });

    it("a single-use coupon is refused on its second redemption", async () => {
      const db = makeDb({ lockedCoupon: { id: 42, maxUses: 1, usedCount: 1 } });
      const svc = await buildService(db, makeResolver());

      await expect(
        svc.verifyAndActivate("org1", "user1", { ...VALID_INPUT, couponId: 42 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it("a coupon that is gone by redemption time leaves the subscription activated and nothing recorded", async () => {
    const db = makeDb({ lockedCoupon: null });
    const svc = await buildService(db, makeResolver());

    await expect(svc.verifyAndActivate("org1", "user1", { ...VALID_INPUT, couponId: 99 })).resolves.toMatchObject({
      success: true,
    });
    expect(db._tx.insert).toHaveBeenCalledTimes(1);
  });
});

describe("BillingService.getSubscription — reads through the adapter", () => {
  it("configured adapter — returns isConfigured true and the public key id", async () => {
    const db = { query: { subscriptions: { findFirst: jest.fn().mockResolvedValue(null) } } };
    const svc = await buildService(db, makeResolver());
    const result = await svc.getSubscription("org1");
    expect(result.isConfigured).toBe(true);
    expect(result.razorpayKeyId).toBe(FAKE_PUBLIC_KEY_ID);
  });

  it("no adapter — returns isConfigured false and null key id", async () => {
    const db = { query: { subscriptions: { findFirst: jest.fn().mockResolvedValue(null) } } };
    const svc = await buildService(db, makeResolver(false));
    const result = await svc.getSubscription("org1");
    expect(result.isConfigured).toBe(false);
    expect(result.razorpayKeyId).toBeNull();
  });
});

describe("BillingService.getSummary — isConfigured reads through the adapter", () => {
  it("configured adapter — isConfigured is true", async () => {
    const svc = await buildService(makeDb({ subscription: null }), makeResolver());
    await expect(svc.getSummary("org1")).resolves.toMatchObject({ isConfigured: true });
  });

  it("no adapter — isConfigured is false", async () => {
    const svc = await buildService(makeDb({ subscription: null }), makeResolver(false));
    await expect(svc.getSummary("org1")).resolves.toMatchObject({ isConfigured: false });
  });
});

describe("billing-cycle — annual and monthly purchases are recorded correctly", () => {
  const msPerDay = 24 * 60 * 60 * 1000;

  it("annual purchase records 12-month discounted amount, not the monthly price", async () => {
    const db = makeDb({ subscription: null });
    const svc = await buildService(db, makeResolver());

    await svc.verifyAndActivate("org1", "user1", { ...VALID_INPUT, billingCycle: "annual" });

    const paymentInsert = db._store.allInserts.find((i) => i.table === subscriptionPayments);
    const annualPaise = Math.round(PLAN_PRICES_PAISE.STARTER * 12 * (1 - ANNUAL_DISCOUNT_PCT));
    expect(paymentInsert?.values.amount).toBe((annualPaise / 100).toFixed(2));
  });

  it("annual purchase sets currentPeriodEnd twelve months out", async () => {
    const db = makeDb({ subscription: null });
    const svc = await buildService(db, makeResolver());

    const before = Date.now();
    await svc.verifyAndActivate("org1", "user1", { ...VALID_INPUT, billingCycle: "annual" });

    const subInsert = db._store.allInserts.find((i) => i.table === subscriptions);
    const periodEnd = subInsert?.values.currentPeriodEnd as Date;
    const diff = periodEnd.getTime() - before;
    expect(diff).toBeGreaterThan(360 * msPerDay);
    expect(diff).toBeLessThan(370 * msPerDay);
  });

  it("monthly purchase records the monthly price and a one-month period", async () => {
    const db = makeDb({ subscription: null });
    const svc = await buildService(db, makeResolver());

    const before = Date.now();
    await svc.verifyAndActivate("org1", "user1", { ...VALID_INPUT, billingCycle: "monthly" });

    const paymentInsert = db._store.allInserts.find((i) => i.table === subscriptionPayments);
    expect(paymentInsert?.values.amount).toBe((PLAN_PRICES_PAISE.STARTER / 100).toFixed(2));

    const subInsert = db._store.allInserts.find((i) => i.table === subscriptions);
    const periodEnd = subInsert?.values.currentPeriodEnd as Date;
    const diff = periodEnd.getTime() - before;
    expect(diff).toBeGreaterThan(27 * msPerDay);
    expect(diff).toBeLessThan(32 * msPerDay);
  });

  it("absent billingCycle is treated as monthly — amount unchanged from today", async () => {
    const db = makeDb({ subscription: null });
    const svc = await buildService(db, makeResolver());

    await svc.verifyAndActivate("org1", "user1", VALID_INPUT);

    const paymentInsert = db._store.allInserts.find((i) => i.table === subscriptionPayments);
    expect(paymentInsert?.values.amount).toBe((PLAN_PRICES_PAISE.STARTER / 100).toFixed(2));
  });

  it("coupon on annual purchase records the discount actually applied, not null", async () => {
    const db = makeDb({
      subscription: null,
      lockedCoupon: { id: 42, type: "PERCENTAGE", value: "10", maxUses: null, usedCount: 0 },
    });
    const svc = await buildService(db, makeResolver());

    await svc.verifyAndActivate("org1", "user1", {
      ...VALID_INPUT,
      billingCycle: "annual",
      couponId: 42,
    });

    const redemptionInsert = db._store.allInserts.find((i) => i.table === couponRedemptions);
    const annualPaise = Math.round(PLAN_PRICES_PAISE.STARTER * 12 * (1 - ANNUAL_DISCOUNT_PCT));
    const discountPaise = Math.round(annualPaise * 0.1);
    expect(redemptionInsert?.values.amount).toBe((discountPaise / 100).toFixed(2));
  });

  it("coupon on monthly purchase records the monthly discount, not the annual one", async () => {
    const db = makeDb({
      subscription: null,
      lockedCoupon: { id: 42, type: "PERCENTAGE", value: "10", maxUses: null, usedCount: 0 },
    });
    const svc = await buildService(db, makeResolver());

    await svc.verifyAndActivate("org1", "user1", { ...VALID_INPUT, billingCycle: "monthly", couponId: 42 });

    const redemptionInsert = db._store.allInserts.find((i) => i.table === couponRedemptions);
    const discountPaise = Math.round(PLAN_PRICES_PAISE.STARTER * 0.1);
    expect(redemptionInsert?.values.amount).toBe((discountPaise / 100).toFixed(2));
  });
});

describe("BillingService — provider-substitution seam proof", () => {
  it("'razorpay' fake produces a successful order with its provider identifier", async () => {
    const adapter = new FakeProviderAdapter();
    const svc = await buildService(makeDb(), makeResolver(true, adapter.providerKey));
    const result = await svc.createOrder("org1", "user1", "STARTER");
    expect(result.orderId).toBe(FAKE_PROVIDER_ORDER_ID);
    expect(adapter.providerKey).toBe("razorpay");
  });

  it("'stripe' fake produces the same domain outcome with a different provider identifier", async () => {
    const adapter = new FakeProviderAdapter("stripe");
    const svc = await buildService(makeDb(), makeResolver(true, adapter.providerKey));
    const result = await svc.createOrder("org1", "user1", "STARTER");
    expect(result.orderId).toBe(FAKE_PROVIDER_ORDER_ID);
    expect(adapter.providerKey).toBe("stripe");
  });
});
