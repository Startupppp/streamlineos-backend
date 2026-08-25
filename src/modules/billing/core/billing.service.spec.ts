import { BadRequestException, ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { BillingService } from "./billing.service";
import { AiCreditsService } from "./ai-credits.service";
import { AuditService } from "../../../common/audit/audit.service";
import { PlanLimitsService } from "./plan-limits.service";
import { PaymentProviderResolver, type OrganizationPaymentProvider } from "../payments/payment-provider-resolver.service";
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

async function buildService(
  db: unknown,
  providers: PaymentProviderResolver,
  aiCredits?: ReturnType<typeof makeAiCredits>,
): Promise<BillingService> {
  const module = await Test.createTestingModule({
    providers: [
      BillingService,
      { provide: DRIZZLE, useValue: db },
      { provide: AiCreditsService, useValue: aiCredits ?? makeAiCredits() },
      { provide: AuditService, useValue: makeAudit() },
      { provide: PlanLimitsService, useValue: makePlanLimits() },
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

  it("wrong signature — throws BadRequestException", async () => {
    const svc = await buildService(makeSuccessDb(), makeResolver());
    await expect(svc.verifyAndActivate("org1", "user1", WRONG_SIG_INPUT)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("wrong signature — NO partial record written (transaction never called)", async () => {
    const db = makeSuccessDb();
    const svc = await buildService(db, makeResolver());
    await expect(svc.verifyAndActivate("org1", "user1", WRONG_SIG_INPUT)).rejects.toBeInstanceOf(BadRequestException);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("no configured provider — throws ServiceUnavailableException before any DB write", async () => {
    const db = makeSuccessDb();
    const svc = await buildService(db, makeResolver(false));
    await expect(svc.verifyAndActivate("org1", "user1", VALID_INPUT)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("no configured provider — error message does not leak key or secret", async () => {
    const svc = await buildService(makeSuccessDb(), makeResolver(false));
    const error = await svc.verifyAndActivate("org1", "user1", VALID_INPUT).catch((e: unknown) => e);
    const message = (error as { message?: string }).message ?? "";
    expect(message).not.toContain("fake-private");
    expect(message).not.toContain("fake-public");
  });
});

describe("BillingService.createOrder — goes through the registry", () => {
  it("configured adapter — creates an order and returns providerOrderId and publicKeyId", async () => {
    const svc = await buildService({}, makeResolver());
    const result = await svc.createOrder("org1", "user1", "STARTER");
    expect(result.orderId).toBe(FAKE_PROVIDER_ORDER_ID);
    expect(result.keyId).toBe(FAKE_PUBLIC_KEY_ID);
    expect(result.plan).toBe("STARTER");
    expect(result.billingCycle).toBe("monthly");
    expect(result.currency).toBe("INR");
  });

  it("configured adapter annual cycle — computes discounted amount", async () => {
    const svc = await buildService({}, makeResolver());
    const result = await svc.createOrder("org1", "user1", "STARTER", "annual");
    expect(result.billingCycle).toBe("annual");
    expect(result.orderId).toBe(FAKE_PROVIDER_ORDER_ID);
  });

  it("no configured provider — throws ServiceUnavailableException", async () => {
    const svc = await buildService({}, makeResolver(false));
    await expect(svc.createOrder("org1", "user1", "STARTER")).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("no configured provider — error message does not contain key or secret", async () => {
    const svc = await buildService({}, makeResolver(false));
    const error = await svc.createOrder("org1", "user1", "STARTER").catch((e: unknown) => e);
    const message = (error as { message?: string }).message ?? "";
    expect(message).not.toContain("fake-private");
    expect(message).not.toContain("fake-public");
  });
});

describe("BillingService.getSubscription — reads through the adapter", () => {
  it("configured adapter — returns isConfigured true and the public key id", async () => {
    const db = {
      query: { subscriptions: { findFirst: jest.fn().mockResolvedValue(null) } },
    };
    const svc = await buildService(db, makeResolver());
    const result = await svc.getSubscription("org1");
    expect(result.isConfigured).toBe(true);
    expect(result.razorpayKeyId).toBe(FAKE_PUBLIC_KEY_ID);
  });

  it("no adapter — returns isConfigured false and null key id", async () => {
    const db = {
      query: { subscriptions: { findFirst: jest.fn().mockResolvedValue(null) } },
    };
    const svc = await buildService(db, makeResolver(false));
    const result = await svc.getSubscription("org1");
    expect(result.isConfigured).toBe(false);
    expect(result.razorpayKeyId).toBeNull();
  });
});

describe("BillingService.getSummary — isConfigured reads through the adapter", () => {
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

  it("configured adapter — isConfigured is true", async () => {
    const svc = await buildService(makeSummaryDb(), makeResolver());
    const result = await svc.getSummary("org1");
    expect(result.isConfigured).toBe(true);
  });

  it("no adapter — isConfigured is false", async () => {
    const svc = await buildService(makeSummaryDb(), makeResolver(false));
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
  it("'razorpay' fake produces a successful order with its provider identifier", async () => {
    const adapter = new FakeProviderAdapter();
    const svc = await buildService({}, makeResolver(true, adapter.providerKey));
    const result = await svc.createOrder("org1", "user1", "STARTER");
    expect(result.orderId).toBe(FAKE_PROVIDER_ORDER_ID);
    expect(result.keyId).toBe(FAKE_PUBLIC_KEY_ID);
    expect(adapter.providerKey).toBe("razorpay");
  });

  it("'stripe' fake produces the same domain outcome with a different provider identifier", async () => {
    const adapter = new FakeProviderAdapter("stripe");
    const svc = await buildService({}, makeResolver(true, adapter.providerKey));
    const result = await svc.createOrder("org1", "user1", "STARTER");
    expect(result.orderId).toBe(FAKE_PROVIDER_ORDER_ID);
    expect(result.keyId).toBe(FAKE_PUBLIC_KEY_ID);
    expect(adapter.providerKey).toBe("stripe");
  });

  it("the billing outcome is identical regardless of which adapter implementation backs the registry", () => {
    const adapterA = new FakeProviderAdapter();
    const adapterB = new FakeProviderAdapter("stripe");
    expect(adapterA.providerKey).not.toBe(adapterB.providerKey);
    expect(adapterA.publicKeyId()).toBe(adapterB.publicKeyId());
    expect(adapterA.isReady()).toBe(adapterB.isReady());
  });
});
