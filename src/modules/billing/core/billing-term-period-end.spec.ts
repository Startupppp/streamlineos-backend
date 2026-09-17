/**
 * AB-07: Period-end clamping — both activation paths must produce correct anniversary dates.
 *
 * Covered paths:
 *   runActivationTransaction  — uses `now` (fake-clocked) to compute the term end
 *   buildStoredOutcome        — uses `purchase.activatedAt` to re-derive the term end on replay
 *
 * Five date fixtures per the task:
 *   2026-01-31 + 1 month  → 2026-02-28  (must not overflow to 2026-03-03)
 *   2024-01-31 + 1 month  → 2024-02-29  (leap-year February)
 *   2024-02-29 + 12 months → 2025-02-28 (annual, leap start → non-leap end)
 *   2026-12-31 + 1 month  → 2027-01-31  (no overflow needed)
 *   2026-12-31 + 12 months → 2027-12-31 (no overflow needed)
 */

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: async <T>(_db: unknown, fn: (tx: unknown) => Promise<T>) => fn(_db),
  runInNewTenantTransaction: async <T>(_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<T>) => fn(_db),
}));

import { BillingPaymentActivation } from "./billing-payment-activation";
import type { SubscriptionPurchase } from "../../../db/schema/billing/subscription-purchases";

const MERCHANT_KEY_ID = "rzp_test_key";
const ORG_ID = "org-period-end";
const ORDER_ID = "order_pe_001";
const PAYMENT_ID = "pay_pe_001";
const AMOUNT_MINOR = 49_900;
const CURRENCY = "INR";

function makePurchase(overrides: Partial<SubscriptionPurchase> = {}): SubscriptionPurchase {
  return {
    id: 900,
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
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as SubscriptionPurchase;
}

function buildActivation(options: {
  purchase: SubscriptionPurchase;
  activatedPurchase?: SubscriptionPurchase;
  platformMerchant?: object;
}) {
  const purchase = options.purchase;
  const activatedPurchase = options.activatedPurchase ?? {
    ...purchase,
    status: "ACTIVATED" as const,
    activatedAt: new Date(),
    providerPaymentId: PAYMENT_ID,
  };

  const mockTx = {
    query: {
      subscriptions: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 1 }]),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([]),
      }),
    }),
  };

  const db = {
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx)),
  };

  const purchaseService = {
    findByOrderId: jest.fn().mockResolvedValue(purchase),
    lockForActivation: jest.fn().mockImplementation(async () => ({
      ...purchase,
      status: "PENDING",
    })),
    markActivated: jest.fn().mockImplementation(async (_tx: unknown, _id: unknown, _org: unknown, input: { activatedAt: Date }) => ({
      ...activatedPurchase,
      activatedAt: input.activatedAt,
    })),
    markFailed: jest.fn().mockResolvedValue(undefined),
    create: jest.fn(),
  };

  const platformMerchant = options.platformMerchant ?? {
    resolve: () => ({
      providerKey: "razorpay",
      isReady: () => true,
      publicKeyId: () => MERCHANT_KEY_ID,
      verifyPaymentSignature: () => true,
      verifyWebhookSignature: () => true,
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
      publicKeyId: MERCHANT_KEY_ID,
      webhookConfigured: true,
      unavailableReason: null,
    }),
    environment: () => "test",
  };

  const externalEffectLedger = {
    execute: jest.fn().mockImplementation(async (_effect: unknown, fn: () => Promise<void>) => {
      await fn();
      return "EXECUTED";
    }),
  };

  const activation = new BillingPaymentActivation(
    db as never,
    undefined as never,
    { log: jest.fn() } as never,
    { grantPlanCredits: jest.fn().mockResolvedValue(undefined) } as never,
    { bust: jest.fn().mockResolvedValue(undefined) } as never,
    {} as never,
    { getActivePriceForPlanTier: jest.fn().mockResolvedValue(null) } as never,
    { emit: jest.fn().mockResolvedValue(undefined) } as never,
    {} as never,
    externalEffectLedger as never,
    platformMerchant as never,
    {} as never,
  );
  Reflect.set(activation, 'purchaseService', purchaseService);

  return { activation, purchaseService, externalEffectLedger };
}

describe("AB-07 period-end — buildStoredOutcome (replay/duplicate path)", () => {
  beforeEach(() => jest.useRealTimers());

  const replayCases: Array<{ label: string; activatedAt: Date; billingCycle: "monthly" | "annual"; expectedYear: number; expectedMonth: number; expectedDate: number }> = [
    {
      label: "2026-01-31 monthly → 2026-02-28 (must not overflow to Mar 3)",
      activatedAt: new Date(2026, 0, 31, 0, 0, 0),
      billingCycle: "monthly",
      expectedYear: 2026, expectedMonth: 1, expectedDate: 28,
    },
    {
      label: "2024-01-31 monthly (leap year) → 2024-02-29",
      activatedAt: new Date(2024, 0, 31, 0, 0, 0),
      billingCycle: "monthly",
      expectedYear: 2024, expectedMonth: 1, expectedDate: 29,
    },
    {
      label: "2024-02-29 annual → 2025-02-28 (non-leap next year)",
      activatedAt: new Date(2024, 1, 29, 0, 0, 0),
      billingCycle: "annual",
      expectedYear: 2025, expectedMonth: 1, expectedDate: 28,
    },
    {
      label: "2026-12-31 monthly → 2027-01-31 (no clamping needed)",
      activatedAt: new Date(2026, 11, 31, 0, 0, 0),
      billingCycle: "monthly",
      expectedYear: 2027, expectedMonth: 0, expectedDate: 31,
    },
    {
      label: "2026-12-31 annual → 2027-12-31 (no clamping needed)",
      activatedAt: new Date(2026, 11, 31, 0, 0, 0),
      billingCycle: "annual",
      expectedYear: 2027, expectedMonth: 11, expectedDate: 31,
    },
  ];

  for (const tc of replayCases) {
    it(tc.label, async () => {
      const activatedPurchase = makePurchase({
        status: "ACTIVATED",
        billingCycle: tc.billingCycle,
        activatedAt: tc.activatedAt,
        providerPaymentId: PAYMENT_ID,
      });
      const { activation } = buildActivation({ purchase: activatedPurchase });

      const result = await activation.verifyAndActivate(ORG_ID, "user-1", {
        orderId: ORDER_ID,
        paymentId: PAYMENT_ID,
        signature: "sig",
      });

      const periodEnd = new Date(result.currentPeriodEnd);
      expect(periodEnd.getFullYear()).toBe(tc.expectedYear);
      expect(periodEnd.getMonth()).toBe(tc.expectedMonth);
      expect(periodEnd.getDate()).toBe(tc.expectedDate);
    });
  }
});

describe("AB-07 period-end — runActivationTransaction (first-time activation path)", () => {
  afterEach(() => jest.useRealTimers());

  const activationCases: Array<{ label: string; now: Date; billingCycle: "monthly" | "annual"; expectedYear: number; expectedMonth: number; expectedDate: number }> = [
    {
      label: "now=2026-01-31 monthly → 2026-02-28",
      now: new Date(2026, 0, 31, 0, 0, 0),
      billingCycle: "monthly",
      expectedYear: 2026, expectedMonth: 1, expectedDate: 28,
    },
    {
      label: "now=2024-01-31 monthly → 2024-02-29 (leap year)",
      now: new Date(2024, 0, 31, 0, 0, 0),
      billingCycle: "monthly",
      expectedYear: 2024, expectedMonth: 1, expectedDate: 29,
    },
    {
      label: "now=2024-02-29 annual → 2025-02-28",
      now: new Date(2024, 1, 29, 0, 0, 0),
      billingCycle: "annual",
      expectedYear: 2025, expectedMonth: 1, expectedDate: 28,
    },
    {
      label: "now=2026-12-31 monthly → 2027-01-31",
      now: new Date(2026, 11, 31, 0, 0, 0),
      billingCycle: "monthly",
      expectedYear: 2027, expectedMonth: 0, expectedDate: 31,
    },
    {
      label: "now=2026-12-31 annual → 2027-12-31",
      now: new Date(2026, 11, 31, 0, 0, 0),
      billingCycle: "annual",
      expectedYear: 2027, expectedMonth: 11, expectedDate: 31,
    },
  ];

  for (const tc of activationCases) {
    it(tc.label, async () => {
      jest.useFakeTimers();
      jest.setSystemTime(tc.now);

      const purchase = makePurchase({ status: "PENDING", billingCycle: tc.billingCycle });
      const { activation } = buildActivation({ purchase });

      const result = await activation.performActivationFromWebhook(
        ORG_ID,
        PAYMENT_ID,
        AMOUNT_MINOR,
        CURRENCY,
        purchase,
      );

      const periodEnd = new Date(result.currentPeriodEnd);
      expect(periodEnd.getFullYear()).toBe(tc.expectedYear);
      expect(periodEnd.getMonth()).toBe(tc.expectedMonth);
      expect(periodEnd.getDate()).toBe(tc.expectedDate);

      jest.useRealTimers();
    });
  }
});
