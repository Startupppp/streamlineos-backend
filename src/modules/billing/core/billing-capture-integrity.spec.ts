/**
 * AB-03: Capture integrity — the webhook activation path must perform the same
 * amount/currency/merchant/environment checks as the browser-callback path.
 *
 * Also covers AB-03 item 3: idempotent grant recovery when a retry arrives for an
 * already-ACTIVATED purchase (credits must be granted exactly once).
 */

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: async <T>(_db: unknown, fn: (tx: unknown) => Promise<T>) => fn(_db),
  runInNewTenantTransaction: async <T>(_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<T>) => fn(_db),
}));

import { BadRequestException } from "@nestjs/common";
import { BillingPaymentActivation } from "./billing-payment-activation";
import type { SubscriptionPurchase } from "../../../db/schema/billing/subscription-purchases";

const MERCHANT_KEY_ID = "rzp_test_key";
const ORG_ID = "org-integrity";
const ORDER_ID = "order_int_001";
const PAYMENT_ID = "pay_int_001";
const AMOUNT_MINOR = 99_900;
const CURRENCY = "INR";

function makePurchase(overrides: Partial<SubscriptionPurchase> = {}): SubscriptionPurchase {
  return {
    id: 800,
    orgId: ORG_ID,
    merchantScope: "platform",
    providerKey: "razorpay",
    environment: "test",
    merchantKeyId: MERCHANT_KEY_ID,
    providerOrderId: ORDER_ID,
    plan: "STARTER",
    billingCycle: "monthly",
    catalogVersion: null,
    baseAmountMinor: AMOUNT_MINOR,
    discountAmountMinor: 0,
    amountMinor: AMOUNT_MINOR,
    currency: CURRENCY,
    couponId: null,
    status: "PENDING",
    providerPaymentId: null,
    capturedAmountMinor: null,
    capturedCurrency: null,
    createdByMembershipId: null,
    createdByUserId: "user-1",
    expiresAt: new Date("2030-01-01T00:00:00Z"),
    activatedAt: null,
    subscriptionId: null,
    periodStart: null,
    periodEnd: null,
    metadata: null,
    createdAt: new Date("2026-09-12T10:00:00Z"),
    updatedAt: new Date("2026-09-12T10:00:00Z"),
    ...overrides,
  } as SubscriptionPurchase;
}

interface BuildOptions {
  purchase: SubscriptionPurchase;
  merchantKeyId?: string;
  environment?: string;
}

function build(opts: BuildOptions) {
  const markFailed = jest.fn().mockResolvedValue(undefined);
  const lockForActivation = jest.fn().mockImplementation(async () => ({
    ...opts.purchase,
    status: "PENDING",
  }));
  const markActivated = jest.fn().mockImplementation(
    async (_tx: unknown, _id: unknown, _org: unknown, input: { activatedAt: Date }) => ({
      ...opts.purchase,
      status: "ACTIVATED",
      activatedAt: input.activatedAt,
      providerPaymentId: PAYMENT_ID,
    }),
  );

  const mockTx = {
    query: { subscriptions: { findFirst: jest.fn().mockResolvedValue(null) } },
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 1 }]) }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    }),
  };

  const db = {
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx)),
  };

  const purchaseService = {
    findByOrderId: jest.fn().mockResolvedValue(opts.purchase),
    lockForActivation,
    markActivated,
    markFailed,
    create: jest.fn(),
  };

  const externalEffectLedger = {
    execute: jest.fn().mockImplementation(async (_effect: unknown, fn: () => Promise<void>) => {
      await fn();
      return "EXECUTED";
    }),
  };

  const platformMerchant = {
    resolve: () => ({
      providerKey: "razorpay",
      isReady: () => true,
      publicKeyId: () => MERCHANT_KEY_ID,
      verifyPaymentSignature: () => true,
      fetchPayment: jest.fn().mockResolvedValue({
        paymentId: PAYMENT_ID,
        orderId: ORDER_ID,
        status: "captured",
        amountMinor: AMOUNT_MINOR,
        currency: CURRENCY,
      }),
    }),
    readiness: () => ({
      configured: true,
      providerKey: "razorpay",
      environment: "test",
      publicKeyId: opts.merchantKeyId !== undefined ? opts.merchantKeyId : MERCHANT_KEY_ID,
      webhookConfigured: true,
      unavailableReason: null,
    }),
    environment: () => (opts.environment !== undefined ? opts.environment : "test"),
  };

  const activation = new BillingPaymentActivation({
    db: db as never,
    audit: { log: jest.fn() } as never,
    aiCredits: { grantPlanCredits: jest.fn().mockResolvedValue(undefined) } as never,
    planLimits: { bust: jest.fn().mockResolvedValue(undefined) } as never,
    prorationLedger: {} as never,
    catalog: { getActivePriceForPlanTier: jest.fn().mockResolvedValue(null) } as never,
    revenueAnalytics: { emit: jest.fn().mockResolvedValue(undefined) } as never,
    providers: {} as never,
    externalEffectLedger: externalEffectLedger as never,
    platformMerchant: platformMerchant as never,
    purchaseService: purchaseService as never,
  });

  return { activation, markFailed, lockForActivation, markActivated, externalEffectLedger };
}

describe("AB-03 — webhook activation refuses wrong captured amount", () => {
  it("throws BadRequestException and marks purchase failed when webhook amount < order amount", async () => {
    const purchase = makePurchase();
    const { activation, markFailed, lockForActivation } = build({ purchase });

    await expect(
      activation.performActivationFromWebhook(ORG_ID, PAYMENT_ID, 100, CURRENCY, purchase),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(lockForActivation).not.toHaveBeenCalled();
  });

  it("throws BadRequestException and marks purchase failed when webhook currency differs", async () => {
    const purchase = makePurchase();
    const { activation, markFailed, lockForActivation } = build({ purchase });

    await expect(
      activation.performActivationFromWebhook(ORG_ID, PAYMENT_ID, AMOUNT_MINOR, "USD", purchase),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(lockForActivation).not.toHaveBeenCalled();
  });
});

describe("AB-03 — webhook activation refuses wrong merchant or environment", () => {
  it("throws BadRequestException when the platform merchant key has changed since the order", async () => {
    const purchase = makePurchase();
    const { activation, lockForActivation } = build({
      purchase,
      merchantKeyId: "rzp_test_rotated",
    });

    await expect(
      activation.performActivationFromWebhook(ORG_ID, PAYMENT_ID, AMOUNT_MINOR, CURRENCY, purchase),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(lockForActivation).not.toHaveBeenCalled();
  });

  it("throws BadRequestException when the payment environment differs from the order environment", async () => {
    const purchase = makePurchase({ environment: "live" });
    const { activation, lockForActivation } = build({
      purchase,
      environment: "live",
      merchantKeyId: MERCHANT_KEY_ID,
    });
    Reflect.set(
      Reflect.get(activation, "deps") as object,
      "platformMerchant",
      {
        readiness: () => ({
          configured: true,
          providerKey: "razorpay",
          environment: "test",
          publicKeyId: MERCHANT_KEY_ID,
          webhookConfigured: true,
          unavailableReason: null,
        }),
        environment: () => "test",
      },
    );

    await expect(
      activation.performActivationFromWebhook(ORG_ID, PAYMENT_ID, AMOUNT_MINOR, CURRENCY, purchase),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(lockForActivation).not.toHaveBeenCalled();
  });
});

describe("AB-03 — activation with webhook alone (no browser callback) fully activates", () => {
  it("activates successfully when only the webhook arrives (no prior verifyAndActivate call)", async () => {
    const purchase = makePurchase();
    const { activation } = build({ purchase });

    const result = await activation.performActivationFromWebhook(
      ORG_ID,
      PAYMENT_ID,
      AMOUNT_MINOR,
      CURRENCY,
      purchase,
    );

    expect(result.success).toBe(true);
    expect(result.plan).toBe("STARTER");
  });
});

describe("AB-03 item 3 — idempotent grant recovery on retry for ACTIVATED purchase", () => {
  it("calls grantPlanCredits when retrying against an already-ACTIVATED purchase (webhook path)", async () => {
    const activatedPurchase = makePurchase({
      status: "ACTIVATED",
      activatedAt: new Date("2026-09-12T10:30:00Z"),
      providerPaymentId: PAYMENT_ID,
    });
    const { activation, externalEffectLedger } = build({ purchase: activatedPurchase });

    const result = await activation.performActivationFromWebhook(
      ORG_ID,
      PAYMENT_ID,
      AMOUNT_MINOR,
      CURRENCY,
      activatedPurchase,
    );

    expect(result.alreadyActivated).toBe(true);
    expect(externalEffectLedger.execute).toHaveBeenCalledWith(
      expect.objectContaining({ effectType: "billing.plan-credit-grant" }),
      expect.any(Function),
    );
  });

  it("does not double-grant when the ExternalEffectLedger reports ALREADY_SUCCEEDED", async () => {
    const activatedPurchase = makePurchase({
      status: "ACTIVATED",
      activatedAt: new Date("2026-09-12T10:30:00Z"),
      providerPaymentId: PAYMENT_ID,
    });
    const aiCredits = { grantPlanCredits: jest.fn().mockResolvedValue(undefined) };
    const externalEffectLedger = {
      execute: jest.fn().mockResolvedValue("ALREADY_SUCCEEDED"),
    };

    const purchase = activatedPurchase;
    const db = { transaction: jest.fn() };
    const purchaseService = {
      findByOrderId: jest.fn().mockResolvedValue(purchase),
      lockForActivation: jest.fn(),
      markActivated: jest.fn(),
      markFailed: jest.fn(),
      create: jest.fn(),
    };

    const activation = new BillingPaymentActivation({
      db: db as never,
      audit: { log: jest.fn() } as never,
      aiCredits: aiCredits as never,
      planLimits: { bust: jest.fn() } as never,
      prorationLedger: {} as never,
      catalog: { getActivePriceForPlanTier: jest.fn().mockResolvedValue(null) } as never,
      revenueAnalytics: { emit: jest.fn() } as never,
      providers: {} as never,
      externalEffectLedger: externalEffectLedger as never,
      platformMerchant: {
        readiness: () => ({ publicKeyId: MERCHANT_KEY_ID, configured: true }),
        environment: () => "test",
      } as never,
      purchaseService: purchaseService as never,
    });

    await activation.performActivationFromWebhook(ORG_ID, PAYMENT_ID, AMOUNT_MINOR, CURRENCY, purchase);

    expect(externalEffectLedger.execute).toHaveBeenCalledTimes(1);
    expect(aiCredits.grantPlanCredits).not.toHaveBeenCalled();
  });
});
