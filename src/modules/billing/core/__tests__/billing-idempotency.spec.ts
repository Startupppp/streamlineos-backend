import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { BillingService } from "../billing.service";
import { AiCreditsService } from "../ai-credits.service";
import { AiCreditsReservationService } from "../ai-credits-reservation.service";
import { AiCreditsPacksService } from "../ai-credits-packs.service";
import { AuditService } from "../../../../common/audit/audit.service";
import { PlanLimitsService } from "../plan-limits.service";
import { ProrationLedgerService } from "../proration-ledger.service";
import { VersionedCatalogService } from "../versioned-catalog.service";
import { APP_CONFIG } from "../../../../config/config.module";
import { PaymentProviderAdapterRegistry } from "../../payments/payment-provider-adapter.interface";
import { PaymentProviderResolver, type OrganizationPaymentProvider } from "../../payments/payment-provider-resolver.service";
import { PlatformMerchantService } from "../../payments/platform-merchant.service";
import { PaymentWebhookReceiverService } from "../../payments/payment-webhook-receiver.service";
import { PaymentAnalyticsService } from "../../payments/payment-analytics.service";
import { BillingProfileService } from "../billing-profile.service";
import { RevenueAnalyticsService } from "../revenue-analytics.service";
import { ExternalEffectLedger } from "../../../../common/outbox/external-effect-ledger";
import { FakeProviderAdapter, FAKE_VALID_PAYMENT_SIG } from "../../payments/testing/fake-provider-adapter";
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
  orderId: "order_idp_001",
  paymentId: "pay_idp_abc",
  signature: FAKE_VALID_PAYMENT_SIG,
};

const IDP_MERCHANT_KEY_ID = new FakeProviderAdapter().publicKeyId();
const IDP_AMOUNT_MINOR = 99_900;
const IDP_CURRENCY = "INR";

const IDP_PURCHASE = {
  id: 11,
  orgId: "org-1",
  providerKey: "razorpay",
  environment: "test",
  merchantKeyId: IDP_MERCHANT_KEY_ID,
  providerOrderId: VERIFY_INPUT.orderId,
  plan: "STARTER",
  billingCycle: "monthly",
  catalogVersion: null,
  baseAmountMinor: IDP_AMOUNT_MINOR,
  discountAmountMinor: 0,
  amountMinor: IDP_AMOUNT_MINOR,
  currency: IDP_CURRENCY,
  couponId: null,
  status: "PENDING",
  subscriptionId: null,
  activatedAt: null,
};

function purchaseSelect(orgId: string) {
  return jest.fn(() => {
    const chain: Record<string, unknown> = {};
    chain["from"] = () => chain;
    chain["where"] = () => chain;
    chain["for"] = () => chain;
    chain["limit"] = () => Promise.resolve([{ ...IDP_PURCHASE, orgId }]);
    chain["then"] = (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve);
    return chain;
  });
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

function makeResolver() {
  const adapter = new FakeProviderAdapter();
  const provider: OrganizationPaymentProvider = {
    providerKey: adapter.providerKey,
    environment: "test",
    isReady: () => adapter.isReady(),
    publicKeyId: () => adapter.publicKeyId(),
    createOrder: (params) => adapter.createOrder({ ...params, keyId: "fake-public", keySecret: "fake-private" }),
    verifyPaymentSignature: (params) => adapter.verifyPaymentSignature({ ...params, keySecret: "fake-private" }),
    verifyWebhookSignature: (params) => adapter.verifyWebhookSignature({ ...params, webhookSecret: "fake-webhook-secret-at-least-32chars" }),
    normalizeWebhook: (rawBody) => adapter.normalizeWebhook(rawBody),
  };
  return { resolve: jest.fn().mockResolvedValue(provider), resolveConfigured: jest.fn().mockResolvedValue(provider) };
}

function makeEffectLedger() {
  return {
    execute: jest.fn().mockImplementation(async (_effect: unknown, send: () => Promise<void>) => {
      await send();
      return "EXECUTED";
    }),
  };
}

function makePlatformMerchant() {
  const adapter = new FakeProviderAdapter();
  return {
    providerKey: "razorpay",
    resolve: jest.fn().mockReturnValue({
      providerKey: "razorpay",
      environment: "test",
      isReady: () => adapter.isReady(),
      publicKeyId: () => adapter.publicKeyId(),
      createOrder: (params) => adapter.createOrder({ ...params, keyId: "fake-public", keySecret: "fake-private" }),
      verifyPaymentSignature: (params) => adapter.verifyPaymentSignature({ ...params, keySecret: "fake-private" }),
      verifyWebhookSignature: (params) => adapter.verifyWebhookSignature({ ...params, webhookSecret: "fake-webhook-secret-at-least-32chars" }),
      normalizeWebhook: (rawBody) => adapter.normalizeWebhook(rawBody),
      fetchPayment: (paymentId: string) =>
        Promise.resolve({
          paymentId,
          orderId: VERIFY_INPUT.orderId,
          status: "captured" as const,
          amountMinor: IDP_AMOUNT_MINOR,
          currency: IDP_CURRENCY,
        }),
    }),
    readiness: jest.fn().mockReturnValue({
      configured: true,
      providerKey: "razorpay",
      environment: "test",
      publicKeyId: adapter.publicKeyId(),
      webhookConfigured: true,
      unavailableReason: null,
    }),
    environment: jest.fn().mockReturnValue("test"),
  } as unknown as PlatformMerchantService;
}

describe("BillingService.verifyAndActivate — idempotency", () => {
  async function buildBilling(db: unknown, registry = makeRegistry()): Promise<BillingService> {
    const module = await Test.createTestingModule({
      providers: [
        BillingService,
        { provide: DRIZZLE, useValue: db },
        { provide: AiCreditsService, useValue: makeMockAiCreditsForBilling() },
        { provide: AuditService, useValue: makeAuditService() },
        { provide: PlanLimitsService, useValue: makePlanLimits() },

        { provide: ProrationLedgerService, useValue: { recordPlanChange: jest.fn().mockResolvedValue(undefined) } },

        { provide: VersionedCatalogService, useValue: { getActivePriceForPlanTier: jest.fn().mockResolvedValue(null) } },
        { provide: RevenueAnalyticsService, useValue: { emit: jest.fn().mockResolvedValue(undefined) } },
        { provide: PaymentProviderResolver, useValue: makeResolver() },
        { provide: PaymentProviderAdapterRegistry, useValue: registry },
        { provide: ExternalEffectLedger, useValue: makeEffectLedger() },
        { provide: PaymentWebhookReceiverService, useValue: { recordSignatureFailure: jest.fn() } },
        { provide: PaymentAnalyticsService, useValue: { notifyOwner: jest.fn(), track: jest.fn() } },
        { provide: BillingProfileService, useValue: { get: jest.fn(), update: jest.fn() } },
        { provide: PlatformMerchantService, useValue: makePlatformMerchant() },
        { provide: APP_CONFIG, useValue: { RAZORPAY_WEBHOOK_SECRET: "test-secret" } },
      ],
    }).compile();
    return module.get(BillingService);
  }

  it("an unrelated 23505 propagates instead of being reported as a successful activation", async () => {
    const db = {
      select: purchaseSelect("org-idp"),
      transaction: jest.fn().mockRejectedValue({ code: "23505" }),
    };
    const svc = await buildBilling(db);

    await expect(svc.verifyAndActivate("org-idp", "user-1", VERIFY_INPUT)).rejects.toBeDefined();
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("transaction body executes — subscription and payment rows are created on first call", async () => {
    let subscriptionsInsertCalled = false;
    let paymentsInsertCalled = false;

    const txMock = {
      query: {
        subscriptions: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      execute: jest.fn().mockResolvedValue([]),
      select: purchaseSelect("org-1"),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn(() => {
        const rows = [{ ...IDP_PURCHASE, status: "ACTIVATED", activatedAt: null }];
        return {
          returning: () => Promise.resolve(rows),
          then: (resolve: (value: typeof rows) => unknown) => Promise.resolve(rows).then(resolve),
        };
      }),
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
      select: purchaseSelect("org-1"),
      transaction: jest.fn().mockImplementation(
        (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
      ),
    };

    const svc = await buildBilling(db);
    const result = await svc.verifyAndActivate("org-1", "user-1", VERIFY_INPUT);

    expect(result).toMatchObject({ success: true, plan: "STARTER", status: "ACTIVE" });
    expect(subscriptionsInsertCalled).toBe(true);
    expect(paymentsInsertCalled).toBe(true);
  });

  it("non-23505 DB error propagates — unexpected failures are not swallowed", async () => {
    const db = {
      select: purchaseSelect("org-1"),
      transaction: jest.fn().mockRejectedValue(new Error("connection timeout")),
    };
    const svc = await buildBilling(db);

    await expect(svc.verifyAndActivate("org-1", "user-1", VERIFY_INPUT)).rejects.toThrow(
      "connection timeout",
    );
  });

  it("invalid signature → throws BadRequestException before any DB write", async () => {
    const wrongSigInput = { ...VERIFY_INPUT, signature: "wrong-signature" };
    const svc = await buildBilling({ transaction: jest.fn() });
    await expect(svc.verifyAndActivate("org-1", "user-1", wrongSigInput)).rejects.toThrow(
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


type WalletUpsertCapture = {
  insertedBalance: number | null;
  conflictSetBalance: unknown;
  ledgerBalanceAfter: number | null;
  selectedForUpdate: number;
};

function makeWalletCapture(): WalletUpsertCapture {
  return {
    insertedBalance: null,
    conflictSetBalance: null,
    ledgerBalanceAfter: null,
    selectedForUpdate: 0,
  };
}

/**
 * The wallet credit is one `INSERT … ON CONFLICT DO UPDATE … RETURNING`, so
 * `values(...)` must be awaitable (the ledger insert) and also carry the upsert
 * link. `settledBalance` is what the database would return, which is where the
 * service now reads the new balance from.
 */
function makeUpsertAwareInsert(captured: WalletUpsertCapture, settledBalance: number) {
  return jest.fn().mockImplementation(() => ({
    values: jest.fn().mockImplementation(
      (args: { balance?: number; balanceAfter?: number }) => {
        if (args.balanceAfter !== undefined) captured.ledgerBalanceAfter = args.balanceAfter;
        else if (args.balance !== undefined) captured.insertedBalance = args.balance;
        return Object.assign(Promise.resolve([]), {
          onConflictDoUpdate: jest.fn().mockImplementation(
            (config: { set: { balance?: unknown } }) => {
              captured.conflictSetBalance = config.set.balance;
              return {
                returning: jest.fn().mockResolvedValue([{ balance: settledBalance }]),
              };
            },
          ),
        });
      },
    ),
  }));
}

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
      insert: makeUpsertAwareInsert(makeWalletCapture(), updatedWallet.balance),
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
      insert: makeUpsertAwareInsert(makeWalletCapture(), updatedWallet.balance),
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

  it("first purchase on an organisation with no wallet row grants the whole pack", async () => {
    const captured = makeWalletCapture();

    const txMock = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            for: jest.fn().mockImplementation(() => {
              captured.selectedForUpdate += 1;
              return Promise.resolve([]);
            }),
          }),
        }),
      }),
      insert: makeUpsertAwareInsert(captured, EXPECTED_CREDITS_ADDED_MILLI),
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

    expect(captured.insertedBalance).toBe(EXPECTED_CREDITS_ADDED_MILLI);
    expect(captured.ledgerBalanceAfter).toBe(EXPECTED_CREDITS_ADDED_MILLI);
    expect(result.balance).toBe(milliToCredits(EXPECTED_CREDITS_ADDED_MILLI));
  });

  it("additive: an existing 200,000 milli balance ends at 200,000 + 550,000 = 750,000", async () => {
    const initialBalance = 200_000;
    const expectedNewBalance = initialBalance + EXPECTED_CREDITS_ADDED_MILLI;
    const captured = makeWalletCapture();

    const txMock = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            for: jest.fn().mockImplementation(() => {
              captured.selectedForUpdate += 1;
              return Promise.resolve([{ balance: initialBalance }]);
            }),
          }),
        }),
      }),
      insert: makeUpsertAwareInsert(captured, expectedNewBalance),
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

    expect(captured.ledgerBalanceAfter).toBe(750_000);
    expect(result.balance).toBe(750);
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

  it("the wallet credit takes no SELECT FOR UPDATE — the row it would lock may not exist", async () => {
    const callOrder: string[] = [];
    const captured = makeWalletCapture();

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
              returning: jest.fn().mockResolvedValue([]),
            }),
          }),
        };
      }),
      insert: makeUpsertAwareInsert(captured, EXPECTED_CREDITS_ADDED_MILLI),
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

    /*
     * The wallet used to be credited read-modify-write behind `SELECT … FOR
     * UPDATE`, and this test pinned that ordering. The lock was the defect: it
     * locks nothing when the row does not exist, so on an organisation's first
     * ever purchase two payments both saw no wallet, both inserted, and the
     * loser died 23505 with the customer charged and no credits granted.
     *
     * There is now no lock and no separate UPDATE — one upsert does both, and
     * the balance moves in SQL so a concurrent grant cannot be erased.
     */
    expect(callOrder).not.toContain("SELECT_FOR_UPDATE");
    expect(callOrder).not.toContain("UPDATE_BALANCE");
    expect(captured.conflictSetBalance).not.toBeNull();
    expect(typeof captured.conflictSetBalance).not.toBe("number");
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
