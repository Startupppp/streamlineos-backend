import { BadRequestException, ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { BillingService } from "./billing.service";
import {
  PLATFORM_PAYMENT_PROVIDER,
  type PlatformOrder,
  type PlatformOrderRecord,
  type PlatformPaymentProvider,
} from "./platform-payment-provider";
import { AiCreditsService } from "./ai-credits.service";
import { AuditService } from "../../../common/audit/audit.service";
import { ExternalEffectLedger } from "../../../common/outbox/external-effect-ledger";
import { RevenueAnalyticsService } from "./revenue-analytics.service";
import { PlanLimitsService } from "./plan-limits.service";
import { PaymentProviderResolver, type OrganizationPaymentProvider } from "../payments/payment-provider-resolver.service";
import {
  FakeProviderAdapter,
  FAKE_VALID_PAYMENT_SIG,
} from "../payments/testing/fake-provider-adapter";

const VALID_INPUT = {
  razorpay_order_id: "order_test_1",
  razorpay_payment_id: "pay_test_abc123",
  razorpay_signature: FAKE_VALID_PAYMENT_SIG,
  plan: "STARTER" as const,
};

/** What the platform provider hands back when it opens checkout. */
const PLATFORM_ORDER_ID = "order_platform_test_1";
const PLATFORM_PUBLIC_KEY = "rzp_test_key";

/**
 * The order the provider holds for `VALID_INPUT`, which is what activation now
 * reads its commercial facts from.
 */
const paidOrder = {
  id: VALID_INPUT.razorpay_order_id,
  amount: 99900,
  currency: "INR",
  status: "paid",
  notes: { orgId: "org1", plan: "STARTER", billingCycle: "monthly", userId: "u1" },
};

/*
  Typed as the interface, deliberately.

  This mock previously returned `getKeyId` -- a method the interface does not
  have -- and omitted `providerKey`, `getPublishableKey` and
  `verifyWebhookSignature`, which it does. Every test passed while the double
  and the real adapter had no shape in common, so a `provider: undefined` write
  went unnoticed. Annotating it means the compiler fails here the next time the
  interface moves, which is the only thing that keeps a double honest.
*/
function makeRazorpay(
  configured = true,
  signatureValid = true,
  order: PlatformOrderRecord = paidOrder,
  providerKey = "razorpay",
): jest.Mocked<PlatformPaymentProvider> {
  return {
    providerKey,
    isConfigured: jest.fn().mockReturnValue(configured),
    // A provider with no credentials has no publishable key to hand the browser.
    getPublishableKey: jest.fn().mockReturnValue(configured ? PLATFORM_PUBLIC_KEY : null),
    createOrder: jest.fn().mockImplementation(
      (params: { amount: number; currency: string }): Promise<PlatformOrder> =>
        Promise.resolve({ id: PLATFORM_ORDER_ID, amount: params.amount, currency: params.currency }),
    ),
    fetchOrder: jest.fn().mockResolvedValue(order),
    verifyPaymentSignature: jest.fn().mockReturnValue(signatureValid),
    verifyWebhookSignature: jest.fn().mockReturnValue(true),
  } as unknown as jest.Mocked<PlatformPaymentProvider>;
}

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

function makeAiCredits() {
  return {
    grantPlanCredits: jest.fn().mockResolvedValue(undefined),
    listPacks: jest.fn().mockResolvedValue([]),
  };
}

function makeAudit() {
  return { log: jest.fn() };
}

function makePlanLimits() {
  return { bust: jest.fn(), resolveTier: jest.fn().mockResolvedValue({ plan: "STARTER" }) };
}

function makeSuccessDb() {
  const txMock = {
    query: {
      subscriptions: {
        findFirst: jest.fn().mockResolvedValue({
          id: 1,
          orgId: "org1",
          plan: "STARTER",
          status: "ACTIVE",
        }),
      },
    },
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockResolvedValue([]),
  };
  return {
    transaction: jest.fn().mockImplementation(
      (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
    ),
  };
}

/*
  `execute` runs the effect and records it; the fake must therefore INVOKE the
  callback, or every assertion about what the effect did (credit grants, in
  particular) silently passes against work that never happened.
*/
function makeEffectLedger() {
  return {
    execute: jest.fn(async (_descriptor: unknown, run: () => Promise<unknown>) => run()),
  } as unknown as ExternalEffectLedger;
}

async function buildService(
  db: unknown,
  providers: PaymentProviderResolver = makeResolver(),
  aiCredits?: ReturnType<typeof makeAiCredits>,
  razorpay: jest.Mocked<PlatformPaymentProvider> = makeRazorpay(),
): Promise<BillingService> {
  const module = await Test.createTestingModule({
    providers: [
      BillingService,
      { provide: DRIZZLE, useValue: db },
      { provide: PLATFORM_PAYMENT_PROVIDER, useValue: razorpay },
      { provide: AiCreditsService, useValue: aiCredits ?? makeAiCredits() },
      { provide: AuditService, useValue: makeAudit() },
      { provide: PlanLimitsService, useValue: makePlanLimits() },
      { provide: RevenueAnalyticsService, useValue: { recordEvent: jest.fn().mockResolvedValue(undefined) } },
      { provide: ExternalEffectLedger, useValue: makeEffectLedger() },
      { provide: PaymentProviderResolver, useValue: providers },
    ],
  }).compile();
  return module.get(BillingService);
}

describe("BillingService.verifyAndActivate — goes through the registry", () => {
  it("happy path — returns success when transaction commits", async () => {
    const svc = await buildService(makeSuccessDb(), makeResolver());
    const result = await svc.verifyAndActivate("org1", "user1", VALID_INPUT);
    expect(result).toEqual({ success: true, plan: "STARTER", status: "ACTIVE" });
  });

  it("23505 on subscription_payments insert — returns success without re-inserting", async () => {
    const conflictDb = {
      transaction: jest.fn().mockRejectedValue({ code: "23505" }),
    };
    const svc = await buildService(conflictDb, makeResolver());
    const result = await svc.verifyAndActivate("org1", "user1", VALID_INPUT);
    expect(conflictDb.transaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, plan: "STARTER", status: "ACTIVE" });
  });

  it("non-23505 DB error propagates — service does not swallow unexpected failures", async () => {
    const errDb = {
      transaction: jest.fn().mockRejectedValue(new Error("deadlock detected")),
    };
    const svc = await buildService(errDb, makeResolver());
    await expect(svc.verifyAndActivate("org1", "user1", VALID_INPUT)).rejects.toThrow("deadlock detected");
  });

  it("invalid signature — throws BadRequestException before any DB write", async () => {
    const db = makeSuccessDb();
    const svc = await buildService(db, makeResolver(), undefined, makeRazorpay(true, false));
    await expect(
      svc.verifyAndActivate("org1", "user1", VALID_INPUT),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("wrong signature — throws BadRequestException", async () => {
    const svc = await buildService(makeSuccessDb(), makeResolver(), undefined, makeRazorpay(true, false));
    await expect(svc.verifyAndActivate("org1", "user1", WRONG_SIG_INPUT)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("wrong signature — NO partial record written (transaction never called)", async () => {
    const db = makeSuccessDb();
    const svc = await buildService(db, makeResolver(), undefined, makeRazorpay(true, false));
    await expect(svc.verifyAndActivate("org1", "user1", WRONG_SIG_INPUT)).rejects.toBeInstanceOf(BadRequestException);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("Razorpay not configured — throws ServiceUnavailableException before any DB write", async () => {
    const db = makeSuccessDb();
    const svc = await buildService(db, makeResolver(), undefined, makeRazorpay(false));
    await expect(
      svc.verifyAndActivate("org1", "user1", VALID_INPUT),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("no configured provider — throws ServiceUnavailableException before any DB write", async () => {
    const db = makeSuccessDb();
    const svc = await buildService(db, makeResolver(), undefined, makeRazorpay(false));
    await expect(svc.verifyAndActivate("org1", "user1", VALID_INPUT)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("no configured provider — error message does not leak key or secret", async () => {
    const svc = await buildService(makeSuccessDb(), makeResolver(), undefined, makeRazorpay(false));
    const error = await svc.verifyAndActivate("org1", "user1", VALID_INPUT).catch((e: unknown) => e);
    const message = (error as { message?: string }).message ?? "";
    expect(message).not.toContain("fake-private");
    expect(message).not.toContain("fake-public");
  });
});

describe("BillingService.createOrder — goes through the registry", () => {
  it("configured provider — creates an order and returns its id and publishable key", async () => {
    const svc = await buildService({});
    const result = await svc.createOrder("org1", "user1", "STARTER");
    expect(result.orderId).toBe(PLATFORM_ORDER_ID);
    expect(result.keyId).toBe(PLATFORM_PUBLIC_KEY);
    expect(result.plan).toBe("STARTER");
    expect(result.billingCycle).toBe("monthly");
    expect(result.currency).toBe("INR");
  });

  it("configured provider annual cycle — computes discounted amount", async () => {
    const svc = await buildService({});
    const result = await svc.createOrder("org1", "user1", "STARTER", "annual");
    expect(result.billingCycle).toBe("annual");
    expect(result.orderId).toBe(PLATFORM_ORDER_ID);
  });

  it("no configured provider — throws ServiceUnavailableException", async () => {
    const svc = await buildService({}, makeResolver(), undefined, makeRazorpay(false));
    await expect(svc.createOrder("org1", "user1", "STARTER")).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("no configured provider — error message does not contain key or secret", async () => {
    const svc = await buildService({}, makeResolver(), undefined, makeRazorpay(false));
    const error = await svc.createOrder("org1", "user1", "STARTER").catch((e: unknown) => e);
    const message = (error as { message?: string }).message ?? "";
    expect(message).not.toContain("fake-private");
    expect(message).not.toContain("fake-public");
  });
});

describe("BillingService.getSubscription — reads through the platform provider", () => {
  it("configured provider — returns isConfigured true and the publishable key", async () => {
    const db = {
      query: { subscriptions: { findFirst: jest.fn().mockResolvedValue(null) } },
    };
    const svc = await buildService(db);
    const result = await svc.getSubscription("org1");
    expect(result.isConfigured).toBe(true);
    expect(result.razorpayKeyId).toBe(PLATFORM_PUBLIC_KEY);
  });

  it("no configured provider — returns isConfigured false and null key id", async () => {
    const db = {
      query: { subscriptions: { findFirst: jest.fn().mockResolvedValue(null) } },
    };
    const svc = await buildService(db, makeResolver(), undefined, makeRazorpay(false));
    const result = await svc.getSubscription("org1");
    expect(result.isConfigured).toBe(false);
    expect(result.razorpayKeyId).toBeNull();
  });
});

describe("BillingService.getSummary — isConfigured reads through the platform provider", () => {
  function makeSummaryDb() {
    return {
      query: {
        subscriptions: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{
            totalPaid: "0",
            totalOutstanding: "0",
            draft: 0,
            issued: 0,
            paid: 0,
            failed: 0,
            voided: 0,
          }]),
        }),
      }),
    };
  }

  it("configured provider — isConfigured is true", async () => {
    const svc = await buildService(makeSummaryDb());
    const result = await svc.getSummary("org1");
    expect(result.isConfigured).toBe(true);
  });

  it("no configured provider — isConfigured is false", async () => {
    const svc = await buildService(makeSummaryDb(), makeResolver(), undefined, makeRazorpay(false));
    const result = await svc.getSummary("org1");
    expect(result.isConfigured).toBe(false);
  });
});

describe("BillingService.verifyAndActivate — coupon redemption enforcement", () => {
  function makeCouponTxMock(coupon: { usedCount: number; maxUses: number | null }) {
    const selectChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      for: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([{ id: 42, maxUses: coupon.maxUses, usedCount: coupon.usedCount }]),
    };
    return {
      query: {
        subscriptions: {
          findFirst: jest.fn().mockResolvedValue({ id: 1, orgId: "org1", plan: "STARTER", status: "ACTIVE" }),
        },
      },
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockResolvedValue([]),
      select: jest.fn().mockReturnValue(selectChain),
    };
  }

  it("concurrent same-org redemption — unique constraint violation becomes ConflictException, not a silent replay", async () => {
    const couponConflict = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "uq_coupon_redemptions_coupon_org",
    });
    const db = { transaction: jest.fn().mockRejectedValue(couponConflict) };
    const svc = await buildService(db, makeResolver());
    await expect(
      svc.verifyAndActivate("org1", "user1", { ...VALID_INPUT, couponId: 1 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("unrelated 23505 (payment replay) still returns success even when couponId is present", async () => {
    const paymentConflict = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "uniq_subscription_payments_razorpay_payment",
    });
    const db = { transaction: jest.fn().mockRejectedValue(paymentConflict) };
    const svc = await buildService(db, makeResolver());
    const result = await svc.verifyAndActivate("org1", "user1", { ...VALID_INPUT, couponId: 1 });
    expect(result).toEqual({ success: true, plan: "STARTER", status: "ACTIVE" });
  });

  it("coupon at maxUses — throws BadRequestException before the redemption row is inserted", async () => {
    const txMock = makeCouponTxMock({ usedCount: 3, maxUses: 3 });
    const db = {
      transaction: jest.fn().mockImplementation((fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock)),
    };
    const svc = await buildService(db, makeResolver());
    await expect(
      svc.verifyAndActivate("org1", "user1", { ...VALID_INPUT, couponId: 42 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(txMock.insert).toHaveBeenCalledTimes(1);
  });

  it("valid coupon — redemption inserted and counter incremented in the same transaction that activates the subscription", async () => {
    const txMock = makeCouponTxMock({ usedCount: 0, maxUses: 5 });
    const db = {
      transaction: jest.fn().mockImplementation((fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock)),
    };
    const svc = await buildService(db, makeResolver());
    const result = await svc.verifyAndActivate("org1", "user1", { ...VALID_INPUT, couponId: 42 });
    expect(result).toEqual({ success: true, plan: "STARTER", status: "ACTIVE" });
    expect(txMock.insert).toHaveBeenCalledTimes(2);
    expect(txMock.update).toHaveBeenCalledTimes(2);
    expect(txMock.select).toHaveBeenCalledTimes(1);
  });

  it("coupon not found or inactive — redemption skipped, subscription still activates", async () => {
    const selectChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      for: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };
    const txMock = {
      query: {
        subscriptions: {
          findFirst: jest.fn().mockResolvedValue({ id: 1, orgId: "org1", plan: "STARTER", status: "ACTIVE" }),
        },
      },
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockResolvedValue([]),
      select: jest.fn().mockReturnValue(selectChain),
    };
    const db = {
      transaction: jest.fn().mockImplementation((fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock)),
    };
    const svc = await buildService(db, makeResolver());
    const result = await svc.verifyAndActivate("org1", "user1", { ...VALID_INPUT, couponId: 99 });
    expect(result).toEqual({ success: true, plan: "STARTER", status: "ACTIVE" });
    expect(txMock.insert).toHaveBeenCalledTimes(1);
  });
});

describe("BillingService — provider-substitution seam proof", () => {
  it("'razorpay' produces a successful order with its provider identifier", async () => {
    const razorpay = makeRazorpay(true, true, paidOrder, "razorpay");
    const svc = await buildService({}, makeResolver(), undefined, razorpay);
    const result = await svc.createOrder("org1", "user1", "STARTER");
    expect(result.orderId).toBe(PLATFORM_ORDER_ID);
    expect(result.keyId).toBe(PLATFORM_PUBLIC_KEY);
    expect(razorpay.providerKey).toBe("razorpay");
  });

  it("'stripe' produces the same domain outcome with a different provider identifier", async () => {
    const stripe = makeRazorpay(true, true, paidOrder, "stripe");
    const svc = await buildService({}, makeResolver(), undefined, stripe);
    const result = await svc.createOrder("org1", "user1", "STARTER");
    expect(result.orderId).toBe(PLATFORM_ORDER_ID);
    expect(result.keyId).toBe(PLATFORM_PUBLIC_KEY);
    expect(stripe.providerKey).toBe("stripe");
  });

  it("the billing outcome is identical regardless of which adapter implementation backs the registry", () => {
    const adapterA = new FakeProviderAdapter();
    const adapterB = new FakeProviderAdapter("stripe");
    expect(adapterA.providerKey).not.toBe(adapterB.providerKey);
    expect(adapterA.publicKeyId()).toBe(adapterB.publicKeyId());
    expect(adapterA.isReady()).toBe(adapterB.isReady());
  });
});

/*
  The terms of the sale come from the order, not the request body.

  These assert consequences rather than calls, per the phase bar: what the
  subscription ends up saying, and how long it lasts -- not that a lookup
  happened. Each one fails loudly against the previous implementation.
*/
describe("BillingService.verifyAndActivate — the buyer does not state what they bought", () => {
  async function buildService(razorpay: jest.Mocked<PlatformPaymentProvider>, db: unknown) {
    const module = await Test.createTestingModule({
      providers: [
        BillingService,
        { provide: DRIZZLE, useValue: db },
        { provide: PLATFORM_PAYMENT_PROVIDER, useValue: razorpay },
        { provide: AiCreditsService, useValue: makeAiCredits() },
        { provide: AuditService, useValue: makeAudit() },
        { provide: PlanLimitsService, useValue: makePlanLimits() },
        { provide: RevenueAnalyticsService, useValue: { recordEvent: jest.fn().mockResolvedValue(undefined) } },
        { provide: ExternalEffectLedger, useValue: makeEffectLedger() },
        { provide: PaymentProviderResolver, useValue: makeResolver() },
      ],
    }).compile();
    return module.get(BillingService);
  }

  /** Captures what was actually written, which is the only thing worth asserting. */
  function capturingDb() {
    const written: Record<string, unknown>[] = [];
    const txMock = {
      query: { subscriptions: { findFirst: jest.fn().mockResolvedValue(undefined) } },
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockImplementation((v: Record<string, unknown>) => {
        written.push(v);
        return { returning: jest.fn().mockResolvedValue([{ id: 7 }]) };
      }),
    };
    return {
      written,
      db: {
        transaction: jest.fn().mockImplementation(
          (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
        ),
      },
    };
  }

  it("refuses to activate a plan the order did not pay for", async () => {
    // The order was created and paid at STARTER; the body claims ENTERPRISE.
    const { db } = capturingDb();
    const billing = await buildService(makeRazorpay(), db);

    await expect(
      billing.verifyAndActivate("org1", "u1", { ...VALID_INPUT, plan: "ENTERPRISE" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses an order created for another organisation", async () => {
    const { db } = capturingDb();
    const foreign = { ...paidOrder, notes: { ...paidOrder.notes, orgId: "org-somebody-else" } };
    const billing = await buildService(makeRazorpay(true, true, foreign), db);

    await expect(
      billing.verifyAndActivate("org1", "u1", VALID_INPUT),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("gives an annual order twelve months, and records what was charged", async () => {
    // 2499_00 paise x 12 x 0.8 -- what createOrder actually charged.
    const annual = {
      ...paidOrder,
      amount: 2399040,
      notes: { ...paidOrder.notes, plan: "PROFESSIONAL", billingCycle: "annual" },
    };
    const { db, written } = capturingDb();
    const billing = await buildService(makeRazorpay(true, true, annual), db);

    await billing.verifyAndActivate("org1", "u1", { ...VALID_INPUT, plan: "PROFESSIONAL" });

    const subscription = written.find((row) => "currentPeriodEnd" in row)!;
    const start = subscription.currentPeriodStart as Date;
    const end = subscription.currentPeriodEnd as Date;
    const months =
      (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
    expect(months).toBe(12);

    // The charged amount, in major units -- not the monthly price recomputed.
    const payment = written.find((row) => "providerPaymentRef" in row)!;
    expect(payment.amount).toBe("23990.40");
    expect(payment.currency).toBe("INR");
  });

  it("still gives a monthly order one month", async () => {
    const { db, written } = capturingDb();
    const billing = await buildService(makeRazorpay(), db);

    await billing.verifyAndActivate("org1", "u1", VALID_INPUT);

    const subscription = written.find((row) => "currentPeriodEnd" in row)!;
    const start = subscription.currentPeriodStart as Date;
    const end = subscription.currentPeriodEnd as Date;
    const months =
      (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
    expect(months).toBe(1);
    expect(written.find((row) => "providerPaymentRef" in row)!.amount).toBe("999.00");
  });
});
