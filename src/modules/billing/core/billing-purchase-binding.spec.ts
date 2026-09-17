import { BadRequestException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { BillingPaymentActivation } from "./billing-payment-activation";
import type { SubscriptionPurchase } from "../../../db/schema/billing/subscription-purchases";

const MERCHANT_KEY_ID = "rzp_test_platformkey";
const ORDER_ID = "order_bind_001";
const PAYMENT_ID = "pay_bind_001";
const AMOUNT_MINOR = 99_900;
const CURRENCY = "INR";

function makePurchase(overrides: Partial<SubscriptionPurchase> = {}): SubscriptionPurchase {
  const base = {
    id: 501,
    orgId: "org-buyer",
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
    expiresAt: new Date("2026-09-12T12:00:00Z"),
    activatedAt: null,
    subscriptionId: null,
    periodStart: null,
    periodEnd: null,
    metadata: null,
    createdAt: new Date("2026-09-12T11:30:00Z"),
    updatedAt: new Date("2026-09-12T11:30:00Z"),
  };
  return { ...base, ...overrides } as SubscriptionPurchase;
}

interface Snapshot {
  paymentId: string;
  orderId: string | null;
  status: "created" | "authorized" | "captured" | "refunded" | "failed";
  amountMinor: number;
  currency: string;
}

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    paymentId: PAYMENT_ID,
    orderId: ORDER_ID,
    status: "captured",
    amountMinor: AMOUNT_MINOR,
    currency: CURRENCY,
    ...overrides,
  };
}

function build(options: {
  purchase: SubscriptionPurchase | null;
  snapshot?: Snapshot | null;
  signatureValid?: boolean;
  merchantKeyId?: string | null;
  environment?: string | null;
}) {
  const markFailed = jest.fn().mockResolvedValue(undefined);
  const lockForActivation = jest.fn().mockResolvedValue(null);
  const markActivated = jest.fn().mockResolvedValue(null);
  const fetchPayment = jest
    .fn()
    .mockResolvedValue(options.snapshot === undefined ? makeSnapshot() : options.snapshot);

  const purchaseService = {
    findByOrderId: jest.fn().mockResolvedValue(options.purchase),
    markFailed,
    lockForActivation,
    markActivated,
    create: jest.fn(),
  };

  const provider = {
    providerKey: "razorpay",
    environment: "test",
    isReady: () => true,
    publicKeyId: () => MERCHANT_KEY_ID,
    createOrder: jest.fn(),
    verifyPaymentSignature: () => options.signatureValid ?? true,
    verifyWebhookSignature: () => true,
    normalizeWebhook: jest.fn(),
    fetchPayment,
  };

  const platformMerchant = {
    resolve: () => provider,
    readiness: () => ({
      configured: true,
      providerKey: "razorpay",
      environment: "test",
      publicKeyId: options.merchantKeyId === undefined ? MERCHANT_KEY_ID : options.merchantKeyId,
      webhookConfigured: true,
      unavailableReason: null,
    }),
    environment: () => (options.environment === undefined ? "test" : options.environment),
  };

  const transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({}));

  const activation = new BillingPaymentActivation(
    { transaction } as never,
    undefined as never,
    { log: jest.fn() } as never,
    { grantPlanCredits: jest.fn() } as never,
    { bust: jest.fn() } as never,
    {} as never,
    { getActivePriceForPlanTier: jest.fn().mockResolvedValue(null) } as never,
    { emit: jest.fn() } as never,
    {} as never,
    { execute: jest.fn() } as never,
    platformMerchant as never,
    {} as never,
  );
  Reflect.set(activation, 'purchaseService', purchaseService);

  return { activation, purchaseService, fetchPayment, markFailed, lockForActivation };
}

const CONFIRM = { orderId: ORDER_ID, paymentId: PAYMENT_ID, signature: "sig" };

describe("verifyAndActivate — the purchase is the authority, not the request body", () => {
  it("activates the plan and cycle stored on the purchase, so an annual order cannot be confirmed as monthly", async () => {
    const purchase = makePurchase({
      plan: "ENTERPRISE",
      billingCycle: "annual",
      status: "ACTIVATED",
      activatedAt: new Date("2026-09-12T11:45:00Z"),
    });
    const { activation } = build({ purchase });

    const result = await activation.verifyAndActivate("org-buyer", "user-1", CONFIRM);

    expect(result.plan).toBe("ENTERPRISE");
    expect(result.billingCycle).toBe("annual");
    const periodEnd = new Date(result.currentPeriodEnd);
    expect(periodEnd.getUTCFullYear()).toBe(2027);
    expect(periodEnd.getUTCMonth()).toBe(8);
  });

  it("refuses an order belonging to another organization with 404, never 403", async () => {
    const purchase = makePurchase({ orgId: "org-victim" });
    const { activation, fetchPayment } = build({ purchase });

    await expect(
      activation.verifyAndActivate("org-attacker", "user-1", CONFIRM),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(fetchPayment).not.toHaveBeenCalled();
  });

  it("refuses when no purchase backs the order id", async () => {
    const { activation } = build({ purchase: null });

    await expect(
      activation.verifyAndActivate("org-buyer", "user-1", CONFIRM),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("verifyAndActivate — a valid signature is not a captured-amount check", () => {
  it("refuses and records the mismatch when the captured amount is lower than the order", async () => {
    const { activation, markFailed, lockForActivation } = build({
      purchase: makePurchase(),
      snapshot: makeSnapshot({ amountMinor: 100 }),
    });

    await expect(
      activation.verifyAndActivate("org-buyer", "user-1", CONFIRM),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(lockForActivation).not.toHaveBeenCalled();
  });

  it("refuses when the captured currency differs from the order currency", async () => {
    const { activation, lockForActivation } = build({
      purchase: makePurchase(),
      snapshot: makeSnapshot({ currency: "USD" }),
    });

    await expect(
      activation.verifyAndActivate("org-buyer", "user-1", CONFIRM),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(lockForActivation).not.toHaveBeenCalled();
  });

  it("refuses a payment that is authorized but not captured", async () => {
    const { activation, lockForActivation } = build({
      purchase: makePurchase(),
      snapshot: makeSnapshot({ status: "authorized" }),
    });

    await expect(
      activation.verifyAndActivate("org-buyer", "user-1", CONFIRM),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(lockForActivation).not.toHaveBeenCalled();
  });

  it("refuses a captured payment minted against a different order", async () => {
    const { activation, lockForActivation } = build({
      purchase: makePurchase(),
      snapshot: makeSnapshot({ orderId: "order_someone_else" }),
    });

    await expect(
      activation.verifyAndActivate("org-buyer", "user-1", CONFIRM),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(lockForActivation).not.toHaveBeenCalled();
  });

  it("refuses when the provider knows nothing about the payment", async () => {
    const { activation } = build({ purchase: makePurchase(), snapshot: null });

    await expect(
      activation.verifyAndActivate("org-buyer", "user-1", CONFIRM),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses an invalid signature before it ever looks up the purchase", async () => {
    const { activation, purchaseService } = build({
      purchase: makePurchase(),
      signatureValid: false,
    });

    await expect(
      activation.verifyAndActivate("org-buyer", "user-1", CONFIRM),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(purchaseService.findByOrderId).not.toHaveBeenCalled();
  });
});

describe("verifyAndActivate — merchant identity must still match the one that took the order", () => {
  it("refuses when the platform merchant key has rotated since the order was created", async () => {
    const { activation, fetchPayment } = build({
      purchase: makePurchase(),
      merchantKeyId: "rzp_test_rotatedkey",
    });

    await expect(
      activation.verifyAndActivate("org-buyer", "user-1", CONFIRM),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fetchPayment).not.toHaveBeenCalled();
  });

  it("refuses when the order was created against a different provider environment", async () => {
    const { activation, fetchPayment } = build({
      purchase: makePurchase(),
      environment: "live",
    });

    await expect(
      activation.verifyAndActivate("org-buyer", "user-1", CONFIRM),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fetchPayment).not.toHaveBeenCalled();
  });
});

describe("verifyAndActivate — duplicate confirmation reports the stored outcome", () => {
  it("returns the recorded activation without re-running it", async () => {
    const purchase = makePurchase({
      status: "ACTIVATED",
      activatedAt: new Date("2026-09-12T11:45:00Z"),
    });
    const { activation, lockForActivation } = build({ purchase });

    const result = await activation.verifyAndActivate("org-buyer", "user-1", CONFIRM);

    expect(result.alreadyActivated).toBe(true);
    expect(result.plan).toBe("STARTER");
    expect(lockForActivation).not.toHaveBeenCalled();
  });
});

describe("createOrder — checkout is refused when the platform merchant is unavailable", () => {
  it("reports the gateway as unconfigured rather than creating an unbacked order", async () => {
    const { activation } = build({ purchase: null });
    const unreadyMerchant = {
      resolve: () => undefined,
      readiness: () => ({
        configured: false,
        providerKey: "razorpay",
        environment: null,
        publicKeyId: null,
        webhookConfigured: false,
        unavailableReason: "no_credentials",
      }),
      environment: () => null,
    };
    Reflect.set(Reflect.get(activation, "deps") as object, "platformMerchant", unreadyMerchant);

    await expect(
      activation.createOrder("org-buyer", "user-1", "STARTER", "monthly"),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
