import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { BillingService } from "../billing.service";
import { AiCreditsService } from "../ai-credits.service";
import { AiCreditsReservationService } from "../ai-credits-reservation.service";
import { AiCreditsPacksService } from "../ai-credits-packs.service";
import { RazorpayService } from "../razorpay.service";
import { AuditService } from "../../../../common/audit/audit.service";
import { PlanLimitsService } from "../plan-limits.service";
import { creditsToMilli, milliToCredits } from "../../../ai/core/billing/ai-model-pricing.constants";
import { planGrantMilli } from "../ai-credit-units";

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
  razorpay_signature: "sig_valid",
  plan: "STARTER" as const,
};

function makeRazorpay(configured = true, signatureValid = true) {
  return {
    isConfigured: jest.fn().mockReturnValue(configured),
    verifyPaymentSignature: jest.fn().mockReturnValue(signatureValid),
    getKeyId: jest.fn().mockReturnValue("rzp_test"),
  };
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

describe("BillingService.verifyAndActivate — idempotency", () => {
  async function buildBilling(db: unknown): Promise<BillingService> {
    const module = await Test.createTestingModule({
      providers: [
        BillingService,
        { provide: DRIZZLE, useValue: db },
        { provide: RazorpayService, useValue: makeRazorpay() },
        { provide: AiCreditsService, useValue: makeMockAiCreditsForBilling() },
        { provide: AuditService, useValue: makeAuditService() },
        { provide: PlanLimitsService, useValue: makePlanLimits() },
      ],
    }).compile();
    return module.get(BillingService);
  }

  it("23505 on subscription_payments insert → returns success, not 500 (idempotent retry)", async () => {
    const db = { transaction: jest.fn().mockRejectedValue({ code: "23505" }) };
    const svc = await buildBilling(db);

    const result = await svc.verifyAndActivate("org-idp", "user-1", VERIFY_INPUT);

    expect(result).toEqual({ success: true, plan: "STARTER", status: "ACTIVE" });
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("transaction body executes — subscription and payment rows are created on first call", async () => {
    let subscriptionsInsertCalled = false;
    let paymentsInsertCalled = false;

    const txMock = {
      query: {
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
    const module = await Test.createTestingModule({
      providers: [
        BillingService,
        { provide: DRIZZLE, useValue: { transaction: jest.fn() } },
        { provide: RazorpayService, useValue: makeRazorpay(true, false) },
        { provide: AiCreditsService, useValue: makeMockAiCreditsForBilling() },
        { provide: AuditService, useValue: makeAuditService() },
        { provide: PlanLimitsService, useValue: makePlanLimits() },
      ],
    }).compile();
    const svc = module.get(BillingService);

    await expect(svc.verifyAndActivate("org-1", "user-1", VERIFY_INPUT)).rejects.toThrow(
      "Payment verification failed",
    );
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
