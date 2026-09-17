import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import type { CacheService } from "../../../common/cache/cache.service";
import { organizationMembers } from "../../../db/schema";
import type { SubscriptionPurchase } from "../../../db/schema/billing/subscription-purchases";
import {
  FakeProviderAdapter,
  FAKE_VALID_PAYMENT_SIG,
  FAKE_PUBLIC_KEY_ID,
} from "../payments/testing/fake-provider-adapter";
import type { OrganizationPaymentProvider } from "../payments/payment-provider-resolver.service";
import type { PlatformMerchantService } from "../payments/platform-merchant.service";
import { BillingPaymentActivation } from "./billing-payment-activation";
import type { AuditService } from "../../../common/audit/audit.service";
import type { AiCreditsService } from "./ai-credits.service";
import type { PlanLimitsService } from "./plan-limits.service";
import type { ProrationLedgerService } from "./proration-ledger.service";
import type { RevenueAnalyticsService } from "./revenue-analytics.service";
import type { VersionedCatalogService } from "./versioned-catalog.service";
import type { ExternalEffectLedger } from "../../../common/outbox/external-effect-ledger";
import { PLAN_PRICES_PAISE } from "./plan-entitlements.constants";
import type { SubscriptionPurchaseService } from "./subscription-purchase.service";

const registerAfterCommitMock = jest.fn<boolean, [() => Promise<unknown>]>();

jest.mock("../../../common/tenant/tenant-context", () => ({
  registerAfterCommit: (...args: [() => Promise<unknown>]) => registerAfterCommitMock(...args),
}));

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (
    _db: unknown,
    fn: (_tx: unknown) => Promise<unknown>,
    _opts?: unknown,
  ) => fn(_db),
  runInNewTenantTransaction: (
    _db: unknown,
    _orgId: string,
    fn: (_tx: unknown) => Promise<unknown>,
  ) => fn(_db),
}));

jest.mock("./billing-activation-recorders", () => ({
  grantPlanCredits: jest.fn().mockResolvedValue(undefined),
  recordProrationForPlanChange: jest.fn().mockResolvedValue(undefined),
}));

const ORG = "org-session-test";
const USER = "user-actor";
const MEMBER_USER = "user-member-1";
const ORDER_ID = "order_sess_1";
const PAYMENT_ID = "pay_sess_abc";
const MONTHLY_PAISE = PLAN_PRICES_PAISE.STARTER;

function makePurchase(overrides: Partial<SubscriptionPurchase> = {}): SubscriptionPurchase {
  const now = new Date("2026-09-13T00:00:00Z");
  return {
    id: 55,
    orgId: ORG,
    createdByUserId: USER,
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

function makeMerchant(): PlatformMerchantService {
  const base = makePurchase();
  const fakeAdapter = new FakeProviderAdapter("razorpay");
  const provider: OrganizationPaymentProvider = {
    providerKey: "razorpay",
    environment: "test",
    isReady: () => fakeAdapter.isReady(),
    publicKeyId: () => fakeAdapter.publicKeyId(),
    createOrder: (p) => fakeAdapter.createOrder({ ...p, keyId: "k", keySecret: "s" }),
    verifyPaymentSignature: (p) =>
      fakeAdapter.verifyPaymentSignature({ ...p, keySecret: "s" }),
    verifyWebhookSignature: (p) =>
      fakeAdapter.verifyWebhookSignature({
        ...p,
        webhookSecret: "fake-webhook-secret-at-least-32chars",
      }),
    fetchPayment: () =>
      Promise.resolve({
        paymentId: PAYMENT_ID,
        orderId: ORDER_ID,
        status: "captured",
        amountMinor: base.amountMinor,
        currency: base.currency,
      }),
    normalizeWebhook: (body) => fakeAdapter.normalizeWebhook(body),
  };

  return {
    resolve: jest.fn().mockReturnValue(provider),
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
}

interface DbOptions {
  transactionRejects?: unknown;
  memberRows?: Array<{ membershipId: number; userId: string }>;
}

function makeDb(opts: DbOptions = {}) {
  const members = opts.memberRows ?? [{ membershipId: 1, userId: MEMBER_USER }];
  let memberCallCount = 0;

  function selectChain(scope: "db" | "tx") {
    let fromTable: unknown = null;
    const chain: Record<string, unknown> = {};
    chain["from"] = (t: unknown) => {
      fromTable = t;
      return chain;
    };
    chain["innerJoin"] = () => chain;
    chain["leftJoin"] = () => chain;
    chain["where"] = () => chain;
    chain["for"] = () => chain;
    chain["orderBy"] = () => chain;
    chain["groupBy"] = () => chain;
    chain["offset"] = () => chain;
    chain["limit"] = () => {
      if (fromTable === organizationMembers && scope === "db") {
        const rows = memberCallCount === 0 ? members : [];
        memberCallCount += 1;
        return Promise.resolve(rows);
      }
      return Promise.resolve([{ id: 1 }]);
    };
    chain["then"] = (resolve: (v: unknown[]) => unknown) =>
      Promise.resolve([{ id: 1 }]).then(resolve);
    return chain;
  }

  function insertChain() {
    return {
      values: () => ({
        returning: () => Promise.resolve([{ id: 1 }]),
        onConflictDoNothing: () => ({ returning: () => Promise.resolve([{ id: 1 }]) }),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve([{ id: 1 }]).then(resolve),
      }),
    };
  }

  function updateChain() {
    const chain: Record<string, unknown> = {};
    chain["set"] = () => chain;
    chain["where"] = () => chain;
    chain["returning"] = () => Promise.resolve([{ id: 1 }]);
    chain["then"] = (resolve: (v: unknown) => unknown) =>
      Promise.resolve([{ id: 1 }]).then(resolve);
    return chain;
  }

  const tx = {
    query: {
      subscriptions: {
        findFirst: jest.fn().mockResolvedValue({
          id: 1,
          orgId: ORG,
          plan: "FREE",
          status: "ACTIVE",
        }),
      },
    },
    update: jest.fn().mockImplementation(() => updateChain()),
    insert: jest.fn().mockImplementation(() => insertChain()),
    select: jest.fn().mockImplementation(() => selectChain("tx")),
    execute: jest.fn().mockResolvedValue([]),
  };

  const transaction = opts.transactionRejects
    ? jest.fn().mockRejectedValue(opts.transactionRejects)
    : jest.fn().mockImplementation((fn: (t: typeof tx) => Promise<unknown>) => fn(tx));

  return {
    transaction,
    query: {
      subscriptions: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    },
    select: jest.fn().mockImplementation(() => selectChain("db")),
    update: jest.fn().mockImplementation(() => updateChain()),
    insert: jest.fn().mockImplementation(() => insertChain()),
    execute: jest.fn().mockResolvedValue([]),
    _tx: tx,
  };
}

function makePurchaseService(
  purchase = makePurchase(),
): jest.Mocked<
  Pick<
    SubscriptionPurchaseService,
    "findByOrderId" | "lockForActivation" | "markActivated" | "markFailed" | "attachProviderOrder" | "create" | "findById"
  >
> {
  const activated = makePurchase({ ...purchase, status: "ACTIVATED" });
  return {
    findByOrderId: jest.fn().mockResolvedValue(purchase),
    lockForActivation: jest.fn().mockResolvedValue(purchase),
    markActivated: jest.fn().mockResolvedValue(activated),
    markFailed: jest.fn().mockResolvedValue(undefined),
    attachProviderOrder: jest.fn().mockResolvedValue(purchase),
    create: jest.fn().mockResolvedValue(purchase),
    findById: jest.fn().mockResolvedValue(purchase),
  };
}

function makeCache(): jest.Mocked<Pick<CacheService, "invalidate" | "invalidateMany">> {
  return {
    invalidate: jest.fn().mockResolvedValue(undefined),
    invalidateMany: jest.fn().mockResolvedValue(undefined),
  };
}

function buildActivation(
  db: ReturnType<typeof makeDb>,
  cache: ReturnType<typeof makeCache>,
  purchaseService = makePurchaseService(),
): BillingPaymentActivation {
  const activation = new BillingPaymentActivation(
    db as unknown as import("../../../db/drizzle.module").Db,
    cache as unknown as CacheService,
    { log: jest.fn(), logCritical: jest.fn() } as unknown as AuditService,
    {
      grantPlanCredits: jest.fn().mockResolvedValue(undefined),
    } as unknown as AiCreditsService,
    {
      bust: jest.fn().mockResolvedValue(undefined),
      resolveTier: jest.fn().mockResolvedValue({ plan: "STARTER" }),
    } as unknown as PlanLimitsService,
    {
      recordPlanChange: jest.fn().mockResolvedValue(undefined),
    } as unknown as ProrationLedgerService,
    {
      getActivePriceForPlanTier: jest.fn().mockResolvedValue(null),
    } as unknown as VersionedCatalogService,
    {
      emit: jest.fn().mockResolvedValue(undefined),
    } as unknown as RevenueAnalyticsService,
    {} as unknown as import("../payments/payment-provider-resolver.service").PaymentProviderResolver,
    {} as unknown as ExternalEffectLedger,
    makeMerchant(),
    {} as never,
  );
  Reflect.set(activation, 'purchaseService', purchaseService);
  return activation;
}

const VALID_INPUT = {
  orderId: ORDER_ID,
  paymentId: PAYMENT_ID,
  signature: FAKE_VALID_PAYMENT_SIG,
};

beforeEach(() => {
  registerAfterCommitMock.mockReturnValue(false);
});

afterEach(() => {
  jest.clearAllMocks();
});

describe("billing — AB-08 session plan projection after activation", () => {
  it(
    "PROOF-1 (success → fresh plan): invalidates member session keys after a committed activation",
    async () => {
      const db = makeDb();
      const cache = makeCache();
      const svc = buildActivation(db, cache);

      await svc.verifyAndActivate(ORG, USER, VALID_INPUT);

      expect(cache.invalidateMany).toHaveBeenCalledWith(
        expect.arrayContaining([CACHE_KEYS.userSession(MEMBER_USER)]),
      );
    },
  );

  it(
    "PROOF-2 (rollback → unchanged): does NOT bust sessions when the activation transaction rolls back",
    async () => {
      const db = makeDb({ transactionRejects: new Error("db rollback") });
      const cache = makeCache();
      const svc = buildActivation(db, cache);

      await expect(svc.verifyAndActivate(ORG, USER, VALID_INPUT)).rejects.toThrow("db rollback");

      expect(cache.invalidateMany).not.toHaveBeenCalled();
    },
  );

  it(
    "PROOF-3 (cache outage): does not propagate a cache outage error to the caller",
    async () => {
      const db = makeDb();
      const cache = makeCache();
      cache.invalidateMany.mockRejectedValue(new Error("Redis connection refused"));
      const svc = buildActivation(db, cache);

      await expect(svc.verifyAndActivate(ORG, USER, VALID_INPUT)).resolves.toMatchObject({
        success: true,
        plan: "STARTER",
      });
    },
  );

  it(
    "PROOF-4 (racing refresh): registers an after-commit hook when an ambient request context exists",
    async () => {
      registerAfterCommitMock.mockReturnValue(true);
      const db = makeDb();
      const cache = makeCache();
      const svc = buildActivation(db, cache);

      await svc.verifyAndActivate(ORG, USER, VALID_INPUT);

      expect(registerAfterCommitMock).toHaveBeenCalledWith(expect.any(Function));
      expect(cache.invalidateMany).not.toHaveBeenCalled();
    },
  );
});
