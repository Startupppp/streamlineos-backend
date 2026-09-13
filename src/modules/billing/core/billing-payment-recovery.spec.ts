import { ExternalEffectLeaseBusyError } from "../../../common/outbox/external-effect-ledger";
import { BillingWebhookHandler, type BillingWebhookDeps } from "./billing-webhook.handler";
import { BillingWebhookEffects } from "./billing-webhook-effects";
import { SubscriptionPurchaseService } from "./subscription-purchase.service";
import type { SubscriptionPurchase } from "../../../db/schema/billing/subscription-purchases";
import type { NormalizedPaymentWebhookEvent, PaymentWebhookPayment } from "../payments/dto/webhook.schemas";
import { FakeProviderAdapter, FAKE_WEBHOOK_SECRET, FAKE_VALID_WEBHOOK_SIG } from "../payments/testing/fake-provider-adapter";
import { PlatformMerchantService } from "../payments/platform-merchant.service";
import { type OrganizationPaymentProvider } from "../payments/payment-provider-resolver.service";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: async <T>(db: unknown, fn: (tx: unknown) => Promise<T>) => fn(db),
  runInNewTenantTransaction: async <T>(db: unknown, _orgId: string, fn: (tx: unknown) => Promise<T>) => fn(db),
}));

const ORG = "org-recovery-001";
const MERCHANT_KEY = "rzp_test_recovery";
const ENV = "test";
const AMOUNT = 99900;
const CURRENCY = "INR";
const PURCHASE_ID = 42;
const ORDER_ID = "order_recovery_abc";
const PAYMENT_ID = "pay_recovery_xyz";

function makePurchase(overrides: Partial<SubscriptionPurchase> = {}): SubscriptionPurchase {
  return {
    id: PURCHASE_ID,
    orgId: ORG,
    createdByUserId: "user-001",
    providerKey: "razorpay",
    environment: ENV,
    merchantKeyId: MERCHANT_KEY,
    providerOrderId: null,
    plan: "PROFESSIONAL",
    billingCycle: "monthly",
    catalogVersion: null,
    baseAmountMinor: AMOUNT,
    discountAmountMinor: 0,
    amountMinor: AMOUNT,
    currency: CURRENCY,
    couponId: null,
    status: "PENDING",
    providerPaymentId: null,
    capturedAmountMinor: null,
    capturedCurrency: null,
    subscriptionId: null,
    activatedAt: null,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function rawCaptureBody(overrides: Partial<{
  order_id: string;
  notes: Record<string, string>;
  amount: number;
}> = {}): string {
  return JSON.stringify({
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: PAYMENT_ID,
          order_id: overrides.order_id ?? ORDER_ID,
          amount: overrides.amount ?? AMOUNT,
          currency: CURRENCY,
          status: "captured",
          method: "card",
          notes: overrides.notes ?? {
            orgId: ORG,
            purchaseId: String(PURCHASE_ID),
            plan: "PROFESSIONAL",
          },
        },
      },
    },
  });
}

function makePlatformMerchant(): PlatformMerchantService {
  const adapter = new FakeProviderAdapter();
  return {
    providerKey: "razorpay",
    resolve: jest.fn().mockReturnValue({
      providerKey: "razorpay",
      environment: "test" as const,
      isReady: () => adapter.isReady(),
      publicKeyId: () => MERCHANT_KEY,
      createOrder: (params: { amount: string; currency: string; receipt: string; notes?: Record<string, string> }) =>
        adapter.createOrder({ ...params, keyId: "fake-public", keySecret: "fake-private" }),
      verifyPaymentSignature: (params: { orderId: string; paymentId: string; signature: string }) =>
        adapter.verifyPaymentSignature({ ...params, keySecret: "fake-private" }),
      verifyWebhookSignature: (params: { rawBody: string; signature: string }) =>
        adapter.verifyWebhookSignature({ ...params, webhookSecret: FAKE_WEBHOOK_SECRET }),
      normalizeWebhook: (rawBody: string) => adapter.normalizeWebhook(rawBody),
      fetchPayment: (paymentId: string) => adapter.configure({}).fetchPayment(paymentId),
    } satisfies OrganizationPaymentProvider),
    readiness: jest.fn().mockReturnValue({
      configured: true,
      providerKey: "razorpay",
      environment: "test" as const,
      publicKeyId: MERCHANT_KEY,
      webhookConfigured: true,
      unavailableReason: null,
    }),
    environment: jest.fn().mockReturnValue(ENV),
  } as unknown as PlatformMerchantService;
}

function makeMinimalDb() {
  return {
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    execute: jest.fn().mockResolvedValue([]),
    query: {
      organizations: { findFirst: jest.fn().mockResolvedValue(null) },
    },
  };
}

function buildHandlerWithMocks(options: {
  findByOrderId?: SubscriptionPurchase | null;
  findById?: SubscriptionPurchase | null;
  attachResult?: SubscriptionPurchase | null;
  activationSucceeds?: boolean;
  effectLedgerMode?: "execute" | "busy" | "already-succeeded";
  platformMerchant?: PlatformMerchantService;
}) {
  const db = makeMinimalDb();

  const purchaseService: SubscriptionPurchaseService = {
    findByOrderId: jest.fn().mockResolvedValue(options.findByOrderId ?? null),
    findById: jest.fn().mockResolvedValue(options.findById ?? null),
    attachProviderOrder: jest.fn().mockResolvedValue(options.attachResult ?? null),
    lockForActivation: jest.fn().mockResolvedValue(null),
    markActivated: jest.fn().mockResolvedValue(null),
    markFailed: jest.fn().mockResolvedValue(undefined),
    markCancelled: jest.fn().mockResolvedValue(undefined),
    expirePending: jest.fn().mockResolvedValue(0),
  } as unknown as SubscriptionPurchaseService;

  const activation = {
    performActivationFromWebhook: jest.fn().mockResolvedValue(
      options.activationSucceeds !== false ? { success: true, plan: "PROFESSIONAL" } : new Error("activation failed"),
    ),
  };

  const notices = { notifyOwner: jest.fn().mockResolvedValue(undefined) };

  const effectLedger = {
    execute: jest.fn().mockImplementation(async (_effect: unknown, send: () => Promise<void>) => {
      if (options.effectLedgerMode === "busy") throw new ExternalEffectLeaseBusyError("test");
      if (options.effectLedgerMode === "already-succeeded") return "ALREADY_SUCCEEDED";
      await send();
      return "EXECUTED";
    }),
  };

  const providerEventLedger = {
    claimed: false,
    acknowledged: false,
    claim: jest.fn().mockImplementation(async () => {
      if (providerEventLedger.claimed) return "PROCESSED";
      providerEventLedger.claimed = true;
      return "CLAIMED";
    }),
    acknowledge: jest.fn().mockImplementation(async () => { providerEventLedger.acknowledged = true; }),
    listUnprocessed: jest.fn().mockResolvedValue({ events: [], total: 0 }),
    listRedrivable: jest.fn().mockResolvedValue([]),
  };

  const state = {
    persistPayment: jest.fn().mockResolvedValue(undefined),
    findOrgFromNotes: jest.fn().mockResolvedValue(null),
    transitionToPastDue: jest.fn().mockResolvedValue(undefined),
  };

  const revenueAnalytics = { emit: jest.fn().mockResolvedValue(undefined) };
  const planLimits = { bust: jest.fn().mockResolvedValue(undefined) };
  const aiCredits = { grantAiPackCreditsFromWebhook: jest.fn().mockResolvedValue(undefined) };
  const paymentWebhooks = { recordSignatureFailure: jest.fn().mockResolvedValue(undefined) };
  const platformMerchant = options.platformMerchant ?? makePlatformMerchant();

  const deps: BillingWebhookDeps = {
    db: db as never,
    aiCredits: aiCredits as never,
    planLimits: planLimits as never,
    revenueAnalytics: revenueAnalytics as never,
    providers: { resolve: jest.fn() } as never,
    externalEffectLedger: effectLedger as never,
    paymentWebhooks: paymentWebhooks as never,
    paymentNotices: notices as never,
    platformMerchant,
    activation: activation as never,
  };

  const handler = new BillingWebhookHandler(deps);

  const effectsInstance = new BillingWebhookEffects(
    {
      db: db as never,
      aiCredits: aiCredits as never,
      externalEffectLedger: effectLedger as never,
      paymentNotices: notices as never,
      activation: activation as never,
    },
    state as never,
  );

  Object.assign(handler, {
    ledger: providerEventLedger,
    state,
    purchaseService,
    effects: effectsInstance,
  });

  return { handler, purchaseService, activation, notices, effectLedger, providerEventLedger };
}

describe("AB-13 — provider-success / attachment-failure recovery", () => {
  describe("scenario 1: webhook arrives before attachProviderOrder completes", () => {
    it("reconciles via notes.purchaseId and activates the subscription", async () => {
      const pendingPurchase = makePurchase({ providerOrderId: null });
      const attachedPurchase = makePurchase({ providerOrderId: ORDER_ID });
      const { handler, purchaseService, activation, providerEventLedger } = buildHandlerWithMocks({
        findByOrderId: null,
        findById: pendingPurchase,
        attachResult: attachedPurchase,
      });

      const result = await handler.handle(ORG, "razorpay", rawCaptureBody(), FAKE_VALID_WEBHOOK_SIG);

      expect(purchaseService.findByOrderId).toHaveBeenCalledWith(expect.anything(), ORDER_ID);
      expect(purchaseService.findById).toHaveBeenCalledWith(expect.anything(), PURCHASE_ID, ORG);
      expect(purchaseService.attachProviderOrder).toHaveBeenCalledWith(
        expect.anything(),
        PURCHASE_ID,
        ORG,
        ORDER_ID,
      );
      expect(activation.performActivationFromWebhook).toHaveBeenCalledWith(
        ORG,
        PAYMENT_ID,
        AMOUNT,
        CURRENCY,
        attachedPurchase,
      );
      expect(providerEventLedger.acknowledged).toBe(true);
      expect(result.status).toBe(200);
    });

    it("uses the already-found purchase when findByOrderId succeeds (normal path unaffected)", async () => {
      const alreadyAttached = makePurchase({ providerOrderId: ORDER_ID });
      const { handler, purchaseService, activation, providerEventLedger } = buildHandlerWithMocks({
        findByOrderId: alreadyAttached,
        findById: alreadyAttached,
      });

      const result = await handler.handle(ORG, "razorpay", rawCaptureBody(), FAKE_VALID_WEBHOOK_SIG);

      expect(purchaseService.findById).not.toHaveBeenCalled();
      expect(activation.performActivationFromWebhook).toHaveBeenCalledTimes(1);
      expect(providerEventLedger.acknowledged).toBe(true);
      expect(result.status).toBe(200);
    });
  });

  describe("scenario 2: no acknowledgement-as-fulfilled of an unprovisioned subscription", () => {
    it("returns 500 and does not acknowledge when notes.purchaseId yields nothing", async () => {
      const { handler, notices, providerEventLedger } = buildHandlerWithMocks({
        findByOrderId: null,
        findById: null,
      });

      const result = await handler.handle(ORG, "razorpay", rawCaptureBody(), FAKE_VALID_WEBHOOK_SIG);

      expect(result.status).toBe(500);
      expect(providerEventLedger.acknowledged).toBe(false);
      expect(notices.notifyOwner).toHaveBeenCalledTimes(1);
    });

    it("returns 500 and does not acknowledge when there are no notes at all", async () => {
      const { handler, providerEventLedger } = buildHandlerWithMocks({
        findByOrderId: null,
        findById: null,
      });

      const body = rawCaptureBody({ notes: {} });
      const result = await handler.handle(ORG, "razorpay", body, FAKE_VALID_WEBHOOK_SIG);

      expect(result.status).toBe(500);
      expect(providerEventLedger.acknowledged).toBe(false);
    });
  });

  describe("scenario 3: duplicate and reordered events — exactly one grant", () => {
    it("does not activate again when ExternalEffectLedger reports ALREADY_SUCCEEDED", async () => {
      const purchase = makePurchase({ providerOrderId: ORDER_ID });
      const { handler, activation } = buildHandlerWithMocks({
        findByOrderId: null,
        findById: makePurchase({ providerOrderId: null }),
        attachResult: purchase,
        effectLedgerMode: "already-succeeded",
      });

      const result = await handler.handle(ORG, "razorpay", rawCaptureBody(), FAKE_VALID_WEBHOOK_SIG);

      expect(activation.performActivationFromWebhook).not.toHaveBeenCalled();
      expect(result.status).toBe(200);
    });

    it("returns 503 and does not acknowledge when the activation lease is busy", async () => {
      const { handler, providerEventLedger } = buildHandlerWithMocks({
        findByOrderId: null,
        findById: makePurchase({ providerOrderId: null }),
        attachResult: makePurchase({ providerOrderId: ORDER_ID }),
        effectLedgerMode: "busy",
      });

      const result = await handler.handle(ORG, "razorpay", rawCaptureBody(), FAKE_VALID_WEBHOOK_SIG);

      expect(result.status).toBe(503);
      expect(providerEventLedger.acknowledged).toBe(false);
    });
  });

  describe("scenario 4: ambiguous timeout — purchase with null providerOrderId", () => {
    it("attaches the order id to the pending purchase and activates", async () => {
      const pending = makePurchase({ providerOrderId: null });
      const attached = makePurchase({ providerOrderId: ORDER_ID });
      const { handler, purchaseService, activation } = buildHandlerWithMocks({
        findByOrderId: null,
        findById: pending,
        attachResult: attached,
      });

      const result = await handler.handle(ORG, "razorpay", rawCaptureBody(), FAKE_VALID_WEBHOOK_SIG);

      expect(purchaseService.attachProviderOrder).toHaveBeenCalled();
      expect(activation.performActivationFromWebhook).toHaveBeenCalledWith(
        ORG,
        PAYMENT_ID,
        AMOUNT,
        CURRENCY,
        attached,
      );
      expect(result.status).toBe(200);
    });
  });

  describe("scenario 5: coupon released but order still payable", () => {
    it("activates when purchase retains couponId after coupon reservation was released", async () => {
      const discountedAmount = AMOUNT - 5000;
      const pending = makePurchase({ providerOrderId: null, couponId: 99, amountMinor: discountedAmount });
      const attached = makePurchase({ providerOrderId: ORDER_ID, couponId: 99, amountMinor: discountedAmount });
      const { handler, activation } = buildHandlerWithMocks({
        findByOrderId: null,
        findById: pending,
        attachResult: attached,
      });

      const body = rawCaptureBody({ amount: discountedAmount });
      const result = await handler.handle(ORG, "razorpay", body, FAKE_VALID_WEBHOOK_SIG);

      expect(activation.performActivationFromWebhook).toHaveBeenCalledWith(
        ORG,
        PAYMENT_ID,
        discountedAmount,
        CURRENCY,
        attached,
      );
      expect(result.status).toBe(200);
    });
  });

  describe("scenario 6: expired/failed intent", () => {
    it("reconciles and activates an EXPIRED purchase (late capture)", async () => {
      const expired = makePurchase({ providerOrderId: null, status: "EXPIRED" });
      const attached = makePurchase({ providerOrderId: ORDER_ID, status: "EXPIRED" });
      const { handler, activation } = buildHandlerWithMocks({
        findByOrderId: null,
        findById: expired,
        attachResult: attached,
      });

      const result = await handler.handle(ORG, "razorpay", rawCaptureBody(), FAKE_VALID_WEBHOOK_SIG);

      expect(activation.performActivationFromWebhook).toHaveBeenCalledWith(
        ORG,
        PAYMENT_ID,
        AMOUNT,
        CURRENCY,
        attached,
      );
      expect(result.status).toBe(200);
    });

    it("does not reconcile a FAILED purchase (provider call never completed)", async () => {
      const failed = makePurchase({ providerOrderId: null, status: "FAILED" });
      const { handler, activation, providerEventLedger } = buildHandlerWithMocks({
        findByOrderId: null,
        findById: failed,
      });

      const result = await handler.handle(ORG, "razorpay", rawCaptureBody(), FAKE_VALID_WEBHOOK_SIG);

      expect(activation.performActivationFromWebhook).not.toHaveBeenCalled();
      expect(providerEventLedger.acknowledged).toBe(false);
      expect(result.status).toBe(500);
    });
  });

  describe("scenario 7: cross-tenant substitution via notes.purchaseId is rejected", () => {
    it("rejects when the reconciled purchase has a different merchantKeyId", async () => {
      const foreignMerchant = makePurchase({ merchantKeyId: "rzp_live_other_key" });
      const { handler, activation, providerEventLedger } = buildHandlerWithMocks({
        findByOrderId: null,
        findById: foreignMerchant,
      });

      const result = await handler.handle(ORG, "razorpay", rawCaptureBody(), FAKE_VALID_WEBHOOK_SIG);

      expect(activation.performActivationFromWebhook).not.toHaveBeenCalled();
      expect(providerEventLedger.acknowledged).toBe(false);
    });

    it("rejects when the reconciled purchase has a different environment", async () => {
      const livePurchase = makePurchase({ environment: "live" });
      const { handler, activation, providerEventLedger } = buildHandlerWithMocks({
        findByOrderId: null,
        findById: livePurchase,
      });

      const result = await handler.handle(ORG, "razorpay", rawCaptureBody(), FAKE_VALID_WEBHOOK_SIG);

      expect(activation.performActivationFromWebhook).not.toHaveBeenCalled();
      expect(providerEventLedger.acknowledged).toBe(false);
    });

    it("rejects when the captured amount does not match the purchase amount", async () => {
      const wrongAmount = makePurchase({ amountMinor: AMOUNT + 10000 });
      const { handler, activation, providerEventLedger } = buildHandlerWithMocks({
        findByOrderId: null,
        findById: wrongAmount,
      });

      const result = await handler.handle(ORG, "razorpay", rawCaptureBody(), FAKE_VALID_WEBHOOK_SIG);

      expect(activation.performActivationFromWebhook).not.toHaveBeenCalled();
      expect(providerEventLedger.acknowledged).toBe(false);
    });

    it("rejects when the reconciled purchase has a non-integer purchaseId in notes", async () => {
      const { handler, purchaseService, providerEventLedger } = buildHandlerWithMocks({
        findByOrderId: null,
        findById: makePurchase(),
      });

      const body = rawCaptureBody({ notes: { orgId: ORG, purchaseId: "not-a-number" } });
      const result = await handler.handle(ORG, "razorpay", body, FAKE_VALID_WEBHOOK_SIG);

      expect(purchaseService.findById).not.toHaveBeenCalled();
      expect(providerEventLedger.acknowledged).toBe(false);
    });
  });

  describe("scenario 8: concurrent reconciliation races", () => {
    it("refuses when the purchase was already claimed by a different order (refetch shows different order)", async () => {
      const pending = makePurchase({ providerOrderId: null });
      const differentOrder = makePurchase({ providerOrderId: "order_different_zzz" });
      const { handler, purchaseService, activation, providerEventLedger } = buildHandlerWithMocks({
        findByOrderId: null,
        findById: pending,
        attachResult: null,
      });

      purchaseService.findById = jest.fn()
        .mockResolvedValueOnce(pending)
        .mockResolvedValueOnce(differentOrder) as typeof purchaseService.findById;

      const result = await handler.handle(ORG, "razorpay", rawCaptureBody(), FAKE_VALID_WEBHOOK_SIG);

      expect(activation.performActivationFromWebhook).not.toHaveBeenCalled();
      expect(providerEventLedger.acknowledged).toBe(false);
      expect(result.status).toBe(500);
    });

    it("proceeds when another process attached the same order concurrently (refetch shows our order)", async () => {
      const pending = makePurchase({ providerOrderId: null });
      const sameOrder = makePurchase({ providerOrderId: ORDER_ID });
      const { handler, purchaseService, activation, providerEventLedger } = buildHandlerWithMocks({
        findByOrderId: null,
        findById: pending,
        attachResult: null,
      });

      purchaseService.findById = jest.fn()
        .mockResolvedValueOnce(pending)
        .mockResolvedValueOnce(sameOrder) as typeof purchaseService.findById;

      const result = await handler.handle(ORG, "razorpay", rawCaptureBody(), FAKE_VALID_WEBHOOK_SIG);

      expect(activation.performActivationFromWebhook).toHaveBeenCalledWith(
        ORG,
        PAYMENT_ID,
        AMOUNT,
        CURRENCY,
        sameOrder,
      );
      expect(providerEventLedger.acknowledged).toBe(true);
      expect(result.status).toBe(200);
    });
  });
});

describe("AB-13 — BillingWebhookEffects: subscription capture without purchase", () => {
  function buildEffects() {
    const activation = {
      performActivationFromWebhook: jest.fn().mockResolvedValue({ success: true }),
    };
    const notices = { notifyOwner: jest.fn().mockResolvedValue(undefined) };
    const db = {
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    };
    const effectLedger = {
      execute: jest.fn().mockImplementation(async (_e: unknown, send: () => Promise<void>) => { await send(); return "EXECUTED"; }),
    };
    const state = { transitionToPastDue: jest.fn().mockResolvedValue(undefined) };
    const aiCredits = { grantAiPackCreditsFromWebhook: jest.fn().mockResolvedValue(undefined) };

    const effects = new BillingWebhookEffects(
      {
        db: db as never,
        aiCredits: aiCredits as never,
        externalEffectLedger: effectLedger as never,
        paymentNotices: notices as never,
        activation: activation as never,
      },
      state as never,
    );

    return { effects, activation, notices };
  }

  const subscriptionCapture: NormalizedPaymentWebhookEvent = {
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: PAYMENT_ID,
          orderId: ORDER_ID,
          amount: AMOUNT,
          currency: CURRENCY,
          status: "captured",
          method: "card",
          notes: { orgId: ORG, purchaseId: String(PURCHASE_ID) },
        },
      },
    },
  };

  const subscriptionPayment: PaymentWebhookPayment = subscriptionCapture.payload.payment!.entity;

  it("returns ok:false without activating when purchase is null for a subscription capture", async () => {
    const { effects, activation, notices } = buildEffects();

    const outcome = await effects.apply(subscriptionCapture, subscriptionPayment, ORG, "razorpay", null);

    expect(outcome.ok).toBe(false);
    expect(activation.performActivationFromWebhook).not.toHaveBeenCalled();
    expect(notices.notifyOwner).toHaveBeenCalledTimes(1);
  });

  it("returns ok:true and calls activation when purchase is provided", async () => {
    const { effects, activation } = buildEffects();
    const purchase = makePurchase({ providerOrderId: ORDER_ID });

    const outcome = await effects.apply(subscriptionCapture, subscriptionPayment, ORG, "razorpay", purchase);

    expect(outcome.ok).toBe(true);
    expect(activation.performActivationFromWebhook).toHaveBeenCalledWith(
      ORG,
      PAYMENT_ID,
      AMOUNT,
      CURRENCY,
      purchase,
    );
  });

  it("AI pack capture with null purchase still succeeds — packId path, not subscription", async () => {
    const { effects, activation } = buildEffects();

    const aiPackEvent: NormalizedPaymentWebhookEvent = {
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: PAYMENT_ID,
            orderId: ORDER_ID,
            amount: 49900,
            currency: CURRENCY,
            status: "captured",
            method: "card",
            notes: { packId: "3" },
          },
        },
      },
    };
    const aiPayment: PaymentWebhookPayment = aiPackEvent.payload.payment!.entity;

    const outcome = await effects.apply(aiPackEvent, aiPayment, ORG, "razorpay", null);

    expect(outcome.ok).toBe(true);
    expect(activation.performActivationFromWebhook).not.toHaveBeenCalled();
  });
});
