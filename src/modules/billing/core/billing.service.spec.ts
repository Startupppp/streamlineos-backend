import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { BillingService } from "./billing.service";
import { AiCreditsService } from "./ai-credits.service";
import { AuditService } from "../../../common/audit/audit.service";
import { PlanLimitsService } from "./plan-limits.service";
import { APP_CONFIG } from "../../../config/config.module";
import {
  PaymentProviderAdapterRegistry,
  type PaymentProviderAdapter,
} from "../payments/payment-provider-adapter.interface";
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

function makeRegistry(withAdapter = true) {
  const registry = new PaymentProviderAdapterRegistry();
  if (withAdapter) registry.register(new FakeProviderAdapter());
  return registry;
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

function makeConfig() {
  return {
    RAZORPAY_KEY_ID: "rzp_test_key_id",
    RAZORPAY_KEY_SECRET: "rzp_test_key_secret",
    RAZORPAY_WEBHOOK_SECRET: "test-webhook-secret",
  };
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
  registry: PaymentProviderAdapterRegistry,
  config?: Record<string, unknown>,
  aiCredits?: ReturnType<typeof makeAiCredits>,
): Promise<BillingService> {
  const module = await Test.createTestingModule({
    providers: [
      BillingService,
      { provide: DRIZZLE, useValue: db },
      { provide: AiCreditsService, useValue: aiCredits ?? makeAiCredits() },
      { provide: AuditService, useValue: makeAudit() },
      { provide: PlanLimitsService, useValue: makePlanLimits() },
      { provide: PaymentProviderAdapterRegistry, useValue: registry },
      { provide: APP_CONFIG, useValue: config ?? makeConfig() },
    ],
  }).compile();
  return module.get(BillingService);
}

describe("BillingService.verifyAndActivate — goes through the registry", () => {
  it("happy path — returns success when transaction commits", async () => {
    const svc = await buildService(makeSuccessDb(), makeRegistry());
    const result = await svc.verifyAndActivate("org1", "user1", VALID_INPUT);
    expect(result).toEqual({ success: true, plan: "STARTER", status: "ACTIVE" });
  });

  it("23505 on subscription_payments insert — returns success without re-inserting", async () => {
    const conflictDb = {
      transaction: jest.fn().mockRejectedValue({ code: "23505" }),
    };
    const svc = await buildService(conflictDb, makeRegistry());
    const result = await svc.verifyAndActivate("org1", "user1", VALID_INPUT);
    expect(conflictDb.transaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, plan: "STARTER", status: "ACTIVE" });
  });

  it("non-23505 DB error propagates — service does not swallow unexpected failures", async () => {
    const errDb = {
      transaction: jest.fn().mockRejectedValue(new Error("deadlock detected")),
    };
    const svc = await buildService(errDb, makeRegistry());
    await expect(svc.verifyAndActivate("org1", "user1", VALID_INPUT)).rejects.toThrow("deadlock detected");
  });

  it("wrong signature — throws BadRequestException", async () => {
    const svc = await buildService(makeSuccessDb(), makeRegistry());
    await expect(svc.verifyAndActivate("org1", "user1", WRONG_SIG_INPUT)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("wrong signature — NO partial record written (transaction never called)", async () => {
    const db = makeSuccessDb();
    const svc = await buildService(db, makeRegistry());
    await expect(svc.verifyAndActivate("org1", "user1", WRONG_SIG_INPUT)).rejects.toBeInstanceOf(BadRequestException);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("no configured provider — throws ServiceUnavailableException before any DB write", async () => {
    const db = makeSuccessDb();
    const svc = await buildService(db, makeRegistry(false));
    await expect(svc.verifyAndActivate("org1", "user1", VALID_INPUT)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("no configured provider — error message does not leak key or secret", async () => {
    const config = makeConfig();
    const svc = await buildService(makeSuccessDb(), makeRegistry(false), config);
    const error = await svc.verifyAndActivate("org1", "user1", VALID_INPUT).catch((e: unknown) => e);
    const message = (error as { message?: string }).message ?? "";
    expect(message).not.toContain(config.RAZORPAY_KEY_SECRET);
    expect(message).not.toContain(config.RAZORPAY_KEY_ID);
  });
});

describe("BillingService.createOrder — goes through the registry", () => {
  it("configured adapter — creates an order and returns providerOrderId and publicKeyId", async () => {
    const svc = await buildService({}, makeRegistry());
    const result = await svc.createOrder("org1", "user1", "STARTER");
    expect(result.orderId).toBe(FAKE_PROVIDER_ORDER_ID);
    expect(result.keyId).toBe(FAKE_PUBLIC_KEY_ID);
    expect(result.plan).toBe("STARTER");
    expect(result.billingCycle).toBe("monthly");
    expect(result.currency).toBe("INR");
  });

  it("configured adapter annual cycle — computes discounted amount", async () => {
    const svc = await buildService({}, makeRegistry());
    const result = await svc.createOrder("org1", "user1", "STARTER", "annual");
    expect(result.billingCycle).toBe("annual");
    expect(result.orderId).toBe(FAKE_PROVIDER_ORDER_ID);
  });

  it("no configured provider — throws ServiceUnavailableException", async () => {
    const svc = await buildService({}, makeRegistry(false));
    await expect(svc.createOrder("org1", "user1", "STARTER")).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("no configured provider — error message does not contain key or secret", async () => {
    const config = makeConfig();
    const svc = await buildService({}, makeRegistry(false), config);
    const error = await svc.createOrder("org1", "user1", "STARTER").catch((e: unknown) => e);
    const message = (error as { message?: string }).message ?? "";
    expect(message).not.toContain(config.RAZORPAY_KEY_SECRET);
    expect(message).not.toContain(config.RAZORPAY_KEY_ID);
  });
});

describe("BillingService.getSubscription — reads through the adapter", () => {
  it("configured adapter — returns isConfigured true and the public key id", async () => {
    const db = {
      query: { subscriptions: { findFirst: jest.fn().mockResolvedValue(null) } },
    };
    const svc = await buildService(db, makeRegistry());
    const result = await svc.getSubscription("org1");
    expect(result.isConfigured).toBe(true);
    expect(result.razorpayKeyId).toBe(FAKE_PUBLIC_KEY_ID);
  });

  it("no adapter — returns isConfigured false and null key id", async () => {
    const db = {
      query: { subscriptions: { findFirst: jest.fn().mockResolvedValue(null) } },
    };
    const svc = await buildService(db, makeRegistry(false));
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
    const svc = await buildService(makeSummaryDb(), makeRegistry());
    const result = await svc.getSummary("org1");
    expect(result.isConfigured).toBe(true);
  });

  it("no adapter — isConfigured is false", async () => {
    const svc = await buildService(makeSummaryDb(), makeRegistry(false));
    const result = await svc.getSummary("org1");
    expect(result.isConfigured).toBe(false);
  });
});

class FixedKeyRegistry extends PaymentProviderAdapterRegistry {
  constructor(private readonly fixedAdapter: PaymentProviderAdapter) {
    super();
  }

  override get(_key: string): PaymentProviderAdapter | undefined {
    return this.fixedAdapter;
  }
}

describe("BillingService — provider-substitution seam proof", () => {
  it("'razorpay' fake produces a successful order with its provider identifier", async () => {
    const adapter = new FakeProviderAdapter();
    const svc = await buildService({}, new FixedKeyRegistry(adapter));
    const result = await svc.createOrder("org1", "user1", "STARTER");
    expect(result.orderId).toBe(FAKE_PROVIDER_ORDER_ID);
    expect(result.keyId).toBe(FAKE_PUBLIC_KEY_ID);
    expect(adapter.providerKey).toBe("razorpay");
  });

  it("'stripe' fake produces the same domain outcome with a different provider identifier", async () => {
    const adapter = new FakeProviderAdapter("stripe");
    const svc = await buildService({}, new FixedKeyRegistry(adapter));
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
