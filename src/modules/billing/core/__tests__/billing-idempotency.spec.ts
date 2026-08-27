import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { BillingService } from "../billing.service";
import { AiCreditsService } from "../ai-credits.service";
import { AiCreditsReservationService } from "../ai-credits-reservation.service";
import { AiCreditsPacksService } from "../ai-credits-packs.service";
import {
  PLATFORM_PAYMENT_PROVIDER,
  type PlatformPaymentProvider,
} from "../platform-payment-provider";
import { AuditService } from "../../../../common/audit/audit.service";
import { ExternalEffectLedger } from "../../../../common/outbox/external-effect-ledger";
import { RevenueAnalyticsService } from "../revenue-analytics.service";
import { PlanLimitsService } from "../plan-limits.service";
import { APP_CONFIG } from "../../../../config/config.module";
import { PaymentProviderAdapterRegistry } from "../../payments/payment-provider-adapter.interface";
import { PaymentProviderResolver } from "../../payments/payment-provider-resolver.service";
import { FakeProviderAdapter, FAKE_VALID_PAYMENT_SIG } from "../../payments/testing/fake-provider-adapter";
import { creditsToMilli, milliToCredits } from "../../../ai/core/billing/ai-model-pricing.constants";
import { planGrantMilli } from "../ai-credit-units";
import { PlatformPaymentRegistry } from "../platform-payment-registry";

/*
  `createOrder` picks its provider by currency now, so the service needs the
  registry too. The fake hands back whichever platform-provider double the case
  already built, so these tests keep asserting what they asserted before —
  provider SELECTION has its own coverage in `provider-selection.spec.ts`.
*/
function makePlatformRegistry(provider: unknown) {
  return {
    forCurrency: jest.fn().mockReturnValue({ provider, isPreferred: true }),
    byProviderKey: jest.fn().mockReturnValue(provider),
    available: jest.fn().mockReturnValue({ razorpay: true, stripe: false }),
  } as unknown as PlatformPaymentRegistry;
}



describe("planGrantMilli — exact milli-credit values (1 credit = 1,000 milli)", () => {
  it("STARTER grants 500,000 milli (500 credits)", () => {
    expect(planGrantMilli("STARTER")).toBe(500_000);
  });

  it("PROFESSIONAL grants 2,000,000 milli (2000 credits)", () => {
    expect(planGrantMilli("PROFESSIONAL")).toBe(2_000_000);
  });

  it("ENTERPRISE grants 10,000,000 milli (10000 credits)", () => {
    expect(planGrantMilli("ENTERPRISE")).toBe(10_000_000);
  });

  it("unknown plan returns 0 milli (no grant)", () => {
    expect(planGrantMilli("UNKNOWN_PLAN")).toBe(0);
  });
});

describe("creditsToMilli / milliToCredits — round-trip invariants", () => {
  it("creditsToMilli(1) === 1000", () => {
    expect(creditsToMilli(1)).toBe(1_000);
  });

  it("creditsToMilli(550) === 550,000", () => {
    expect(creditsToMilli(550)).toBe(550_000);
  });

  it("milliToCredits is the exact inverse of creditsToMilli for whole-credit values", () => {
    expect(milliToCredits(creditsToMilli(550))).toBe(550);
  });

  it("milliToCredits(550_000) === 550", () => {
    expect(milliToCredits(550_000)).toBe(550);
  });
});

const VERIFY_INPUT = {
  razorpay_order_id: "order_idp_001",
  razorpay_payment_id: "pay_idp_abc",
  razorpay_signature: FAKE_VALID_PAYMENT_SIG,
  plan: "STARTER" as const,
};

/* Typed as the interface, for the reason set out in `billing.service.spec.ts`. */
function makeRazorpay(configured = true, signatureValid = true, orgId = "org-1") {
  return {
    providerKey: "razorpay",
    isConfigured: jest.fn().mockReturnValue(configured),
    getPublishableKey: jest.fn().mockReturnValue("rzp_test"),
    createOrder: jest.fn(),
    fetchOrder: jest.fn().mockResolvedValue({
      id: VERIFY_INPUT.razorpay_order_id,
      amount: 99900,
      currency: "INR",
      status: "paid",
      notes: { orgId, plan: "STARTER", billingCycle: "monthly", userId: "user-1" },
    }),
    verifyPaymentSignature: jest.fn().mockReturnValue(signatureValid),
    verifyWebhookSignature: jest.fn().mockReturnValue(true),
  } as unknown as jest.Mocked<PlatformPaymentProvider>;
}

/** BillingService still resolves a tenant provider for the provider-neutral webhook path. */
function makeResolver() {
  return {
    resolve: jest.fn().mockResolvedValue(undefined),
    resolveConfigured: jest.fn().mockResolvedValue(undefined),
  } as unknown as PaymentProviderResolver;
}

function makeRegistry(withAdapter = true) {
  const registry = new PaymentProviderAdapterRegistry();
  if (withAdapter) registry.register(new FakeProviderAdapter());
  return registry;
}

function makePlanLimits() {
  return { bust: jest.fn(), resolveTier: jest.fn().mockResolvedValue({ plan: "STARTER" }) };
}

function makeAuditService() {
  return { log: jest.fn() };
}

function makeMockAiCreditsForBilling() {
  return { grantPlanCredits: jest.fn().mockResolvedValue(undefined) };
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

describe("BillingService.verifyAndActivate — idempotency", () => {
  async function buildBilling(
    db: unknown,
    orgId = "org-1",
    registry = makeRegistry(),
    razorpay: jest.Mocked<PlatformPaymentProvider> = makeRazorpay(true, true, orgId),
  ): Promise<BillingService> {
    const module = await Test.createTestingModule({
      providers: [
        BillingService,
        { provide: DRIZZLE, useValue: db },
        { provide: PLATFORM_PAYMENT_PROVIDER, useValue: razorpay },
      { provide: PlatformPaymentRegistry, useValue: makePlatformRegistry(razorpay) },
        { provide: AiCreditsService, useValue: makeMockAiCreditsForBilling() },
        { provide: AuditService, useValue: makeAuditService() },
        { provide: PlanLimitsService, useValue: makePlanLimits() },
        { provide: RevenueAnalyticsService, useValue: { recordEvent: jest.fn().mockResolvedValue(undefined) } },
        { provide: ExternalEffectLedger, useValue: makeEffectLedger() },
        { provide: PaymentProviderAdapterRegistry, useValue: registry },
        { provide: PaymentProviderResolver, useValue: makeResolver() },
        { provide: APP_CONFIG, useValue: { RAZORPAY_WEBHOOK_SECRET: "test-secret" } },
      ],
    }).compile();
    return module.get(BillingService);
  }

  it("23505 on subscription_payments insert → returns success, not 500 (idempotent retry)", async () => {
    const db = { transaction: jest.fn().mockRejectedValue({ code: "23505" }) };
    const svc = await buildBilling(db, "org-idp");

    const result = await svc.verifyAndActivate("org-idp", "user-1", VERIFY_INPUT);

    expect(result).toEqual({ success: true, plan: "STARTER", status: "ACTIVE" });
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("transaction body executes — subscription and payment rows are created on first call", async () => {
    let subscriptionsInsertCalled = false;
    let paymentsInsertCalled = false;

    const txMock = {
      query: {
      // `createOrder` reads the billing profile for the country that decides
      // currency and tax jurisdiction. Absent here, so these cases price in the
      // stated fallback rather than depending on a fixture country.
      billingProfiles: { findFirst: jest.fn().mockResolvedValue(undefined) },
        subscriptions: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      insert: jest.fn().mockImplementation(() => {
        const returnMock = {
          values: jest.fn().mockImplementation(() => {
            if (!subscriptionsInsertCalled) {
              subscriptionsInsertCalled = true;
              return { returning: jest.fn().mockResolvedValue([{ id: 42 }]) };
            }
            paymentsInsertCalled = true;
            return Promise.resolve([]);
          }),
        };
        return returnMock;
      }),
    };

    const db = {
      transaction: jest.fn().mockImplementation(
        (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
      ),
    };

    const svc = await buildBilling(db);
    const result = await svc.verifyAndActivate("org-1", "user-1", VERIFY_INPUT);

    expect(result).toEqual({ success: true, plan: "STARTER", status: "ACTIVE" });
    expect(subscriptionsInsertCalled).toBe(true);
    expect(paymentsInsertCalled).toBe(true);
  });

  it("non-23505 DB error propagates — unexpected failures are not swallowed", async () => {
    const db = { transaction: jest.fn().mockRejectedValue(new Error("connection timeout")) };
    const svc = await buildBilling(db);

    await expect(svc.verifyAndActivate("org-1", "user-1", VERIFY_INPUT)).rejects.toThrow(
      "connection timeout",
    );
  });

  it("invalid signature → throws BadRequestException before any DB write", async () => {
    const wrongSigInput = { ...VERIFY_INPUT, razorpay_signature: "wrong-signature" };
    const db = { transaction: jest.fn() };
    const svc = await buildBilling(db, "org-1", makeRegistry(), makeRazorpay(true, false));
    await expect(svc.verifyAndActivate("org-1", "user-1", wrongSigInput)).rejects.toThrow(
      "Payment verification failed",
    );
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

const MOCK_PACK = {
  id: 1,
  name: "Starter Pack",
  credits: 500,
  bonusCredits: 50,
  priceInPaise: 49_900,
  isActive: true,
  sortOrder: 1,
  createdAt: new Date(),
};

const EXPECTED_CREDITS_ADDED = MOCK_PACK.credits + MOCK_PACK.bonusCredits;
const EXPECTED_CREDITS_ADDED_MILLI = creditsToMilli(EXPECTED_CREDITS_ADDED);

describe("AiCreditsService.purchaseCreditsDirectly — exact milli-credit arithmetic", () => {
  async function buildCreditsService(db: unknown): Promise<AiCreditsService> {
    const module = await Test.createTestingModule({
      providers: [
        AiCreditsService,
        { provide: DRIZZLE, useValue: db },
        { provide: AiCreditsReservationService, useValue: {} },
        { provide: AiCreditsPacksService, useValue: {} },
      ],
    }).compile();
    return module.get(AiCreditsService);
  }

  it("creditsAdded = pack.credits + pack.bonusCredits = 550", async () => {
    const updatedWallet = { balance: EXPECTED_CREDITS_ADDED_MILLI };
    const txMock = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            for: jest.fn().mockResolvedValue([{ balance: 0 }]),
          }),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([updatedWallet]),
          }),
        }),
      }),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
    };

    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([MOCK_PACK]),
        }),
      }),
      transaction: jest.fn().mockImplementation(
        (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
      ),
    };

    const svc = await buildCreditsService(db);
    const result = await svc.purchaseCreditsDirectly("org-1", "user-1", 1);

    expect(result.creditsAdded).toBe(550);
  });

  it("balance in milli = 550,000; milliToCredits(550,000) = 550 returned as balance", async () => {
    const updatedWallet = { balance: EXPECTED_CREDITS_ADDED_MILLI };
    const txMock = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            for: jest.fn().mockResolvedValue([{ balance: 0 }]),
          }),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([updatedWallet]),
          }),
        }),
      }),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
    };

    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([MOCK_PACK]),
        }),
      }),
      transaction: jest.fn().mockImplementation(
        (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
      ),
    };

    const svc = await buildCreditsService(db);
    const result = await svc.purchaseCreditsDirectly("org-1", "user-1", 1);

    expect(result.balance).toBe(550);
  });

  it("starting from zero balance: newBalance === creditsAddedMilli (550,000)", async () => {
    let capturedNewBalance: number | undefined;
    const updatedWallet = { balance: EXPECTED_CREDITS_ADDED_MILLI };

    const txMock = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            for: jest.fn().mockResolvedValue([{ balance: 0 }]),
          }),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockImplementation((setArg: { balance?: number }) => {
          capturedNewBalance = setArg.balance;
          return {
            where: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([updatedWallet]),
            }),
          };
        }),
      }),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
    };

    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([MOCK_PACK]),
        }),
      }),
      transaction: jest.fn().mockImplementation(
        (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
      ),
    };

    const svc = await buildCreditsService(db);
    await svc.purchaseCreditsDirectly("org-1", "user-1", 1);

    expect(capturedNewBalance).toBe(EXPECTED_CREDITS_ADDED_MILLI);
  });

  it("additive: starting from 200,000 milli balance → newBalance = 200,000 + 550,000 = 750,000", async () => {
    const initialBalance = 200_000;
    const expectedNewBalance = initialBalance + EXPECTED_CREDITS_ADDED_MILLI;
    let capturedNewBalance: number | undefined;
    const updatedWallet = { balance: expectedNewBalance };

    const txMock = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            for: jest.fn().mockResolvedValue([{ balance: initialBalance }]),
          }),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockImplementation((setArg: { balance?: number }) => {
          capturedNewBalance = setArg.balance;
          return {
            where: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([updatedWallet]),
            }),
          };
        }),
      }),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
    };

    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([MOCK_PACK]),
        }),
      }),
      transaction: jest.fn().mockImplementation(
        (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
      ),
    };

    const svc = await buildCreditsService(db);
    await svc.purchaseCreditsDirectly("org-1", "user-1", 1);

    expect(capturedNewBalance).toBe(750_000);
    expect(milliToCredits(expectedNewBalance)).toBe(750);
  });
});

describe("AiCreditsService.purchaseCreditsDirectly — reserve-before-spend ordering", () => {
  async function buildCreditsService(db: unknown): Promise<AiCreditsService> {
    const module = await Test.createTestingModule({
      providers: [
        AiCreditsService,
        { provide: DRIZZLE, useValue: db },
        { provide: AiCreditsReservationService, useValue: {} },
        { provide: AiCreditsPacksService, useValue: {} },
      ],
    }).compile();
    return module.get(AiCreditsService);
  }

  it("SELECT FOR UPDATE (reserve wallet lock) happens strictly before UPDATE balance (spend)", async () => {
    const callOrder: string[] = [];
    const updatedWallet = { balance: EXPECTED_CREDITS_ADDED_MILLI };

    const txMock = {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            for: jest.fn().mockImplementation(() => {
              callOrder.push("SELECT_FOR_UPDATE");
              return Promise.resolve([{ balance: 0 }]);
            }),
          }),
        }),
      })),
      update: jest.fn().mockImplementation(() => {
        callOrder.push("UPDATE_BALANCE");
        return {
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([updatedWallet]),
            }),
          }),
        };
      }),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
    };

    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([MOCK_PACK]),
        }),
      }),
      transaction: jest.fn().mockImplementation(
        (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
      ),
    };

    const svc = await buildCreditsService(db);
    await svc.purchaseCreditsDirectly("org-1", "user-1", 1);

    const reserveIndex = callOrder.indexOf("SELECT_FOR_UPDATE");
    const spendIndex = callOrder.indexOf("UPDATE_BALANCE");
    expect(reserveIndex).toBeGreaterThanOrEqual(0);
    expect(spendIndex).toBeGreaterThan(reserveIndex);
  });

  it("23505 backstop: transaction failure returns existing balance without re-granting credits", async () => {
    const existingBalance = 300_000;
    const existingWallet = { balance: existingBalance };

    let dbSelectCallCount = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        dbSelectCallCount++;
        if (dbSelectCallCount === 1) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockResolvedValue([MOCK_PACK]),
            }),
          };
        }
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([existingWallet]),
          }),
        };
      }),
      transaction: jest.fn().mockRejectedValue({ code: "23505" }),
    };

    const svc = await buildCreditsService(db);
    const result = await svc.purchaseCreditsDirectly("org-1", "user-1", 1);

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(result.creditsAdded).toBe(EXPECTED_CREDITS_ADDED);
    expect(result.balance).toBe(milliToCredits(existingBalance));
  });
});
