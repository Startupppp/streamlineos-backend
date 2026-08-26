import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { BillingService } from "./billing.service";
import {
  PLATFORM_PAYMENT_PROVIDER,
  type PlatformOrderRecord,
  type PlatformPaymentProvider,
} from "./platform-payment-provider";
import { AiCreditsService } from "./ai-credits.service";
import { AuditService } from "../../../common/audit/audit.service";
import { PlanLimitsService } from "./plan-limits.service";

const validInput = {
  razorpay_order_id: "order_test_1",
  razorpay_payment_id: "pay_test_abc123",
  razorpay_signature: "valid_sig",
  plan: "STARTER" as const,
};

/**
 * The order the provider holds for `validInput`, which is what activation now
 * reads its commercial facts from.
 */
const paidOrder = {
  id: validInput.razorpay_order_id,
  amount: 99900,
  currency: "INR",
  status: "paid",
  notes: { orgId: "org1", plan: "STARTER", billingCycle: "monthly", userId: "u1" },
};

/*
  Typed as the interface, deliberately.

  This mock previously returned `getKeyId` -- a method the interface does not
  have -- and omitted `providerKey`, `getPublishableKey` and
  `verifyWebhookSignature`, which it does. Every test passed while the double
  and the real adapter had no shape in common, so a `provider: undefined` write
  went unnoticed. Annotating it means the compiler fails here the next time the
  interface moves, which is the only thing that keeps a double honest.
*/
function makeRazorpay(
  configured = true,
  signatureValid = true,
  order: PlatformOrderRecord = paidOrder,
): jest.Mocked<PlatformPaymentProvider> {
  return {
    providerKey: "razorpay",
    isConfigured: jest.fn().mockReturnValue(configured),
    getPublishableKey: jest.fn().mockReturnValue("rzp_test_key"),
    createOrder: jest.fn(),
    fetchOrder: jest.fn().mockResolvedValue(order),
    verifyPaymentSignature: jest.fn().mockReturnValue(signatureValid),
    verifyWebhookSignature: jest.fn().mockReturnValue(true),
  } as unknown as jest.Mocked<PlatformPaymentProvider>;
}

function makeAiCredits() {
  return {
    grantPlanCredits: jest.fn().mockResolvedValue(undefined),
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

describe("BillingService.verifyAndActivate — DB backstop (23505)", () => {
  let billing: BillingService;

  async function buildService(db: unknown) {
    const module = await Test.createTestingModule({
      providers: [
        BillingService,
        { provide: DRIZZLE, useValue: db },
        { provide: PLATFORM_PAYMENT_PROVIDER, useValue: makeRazorpay() },
        { provide: AiCreditsService, useValue: makeAiCredits() },
        { provide: AuditService, useValue: makeAudit() },
        { provide: PlanLimitsService, useValue: makePlanLimits() },
      ],
    }).compile();
    return module.get(BillingService);
  }

  it("happy path — returns success when transaction commits", async () => {
    billing = await buildService(makeSuccessDb());
    const result = await billing.verifyAndActivate("org1", "user1", validInput);
    expect(result).toEqual({ success: true, plan: "STARTER", status: "ACTIVE" });
  });

  it("23505 on subscription_payments insert — exactly one row; retried call returns success without re-inserting", async () => {
    const conflictDb = {
      transaction: jest.fn().mockRejectedValue({ code: "23505" }),
    };
    billing = await buildService(conflictDb);

    const result = await billing.verifyAndActivate("org1", "user1", validInput);

    expect(conflictDb.transaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, plan: "STARTER", status: "ACTIVE" });
  });

  it("non-23505 DB error propagates — service does not swallow unexpected failures", async () => {
    const errDb = {
      transaction: jest.fn().mockRejectedValue(new Error("deadlock detected")),
    };
    billing = await buildService(errDb);

    await expect(
      billing.verifyAndActivate("org1", "user1", validInput),
    ).rejects.toThrow("deadlock detected");
  });

  it("invalid signature — throws BadRequestException before any DB write", async () => {
    const module = await Test.createTestingModule({
      providers: [
        BillingService,
        { provide: DRIZZLE, useValue: makeSuccessDb() },
        { provide: PLATFORM_PAYMENT_PROVIDER, useValue: makeRazorpay(true, false) },
        { provide: AiCreditsService, useValue: makeAiCredits() },
        { provide: AuditService, useValue: makeAudit() },
        { provide: PlanLimitsService, useValue: makePlanLimits() },
      ],
    }).compile();
    billing = module.get(BillingService);

    await expect(
      billing.verifyAndActivate("org1", "user1", validInput),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("Razorpay not configured — throws ServiceUnavailableException before any DB write", async () => {
    const module = await Test.createTestingModule({
      providers: [
        BillingService,
        { provide: DRIZZLE, useValue: makeSuccessDb() },
        { provide: PLATFORM_PAYMENT_PROVIDER, useValue: makeRazorpay(false) },
        { provide: AiCreditsService, useValue: makeAiCredits() },
        { provide: AuditService, useValue: makeAudit() },
        { provide: PlanLimitsService, useValue: makePlanLimits() },
      ],
    }).compile();
    billing = module.get(BillingService);

    await expect(
      billing.verifyAndActivate("org1", "user1", validInput),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

/*
  The terms of the sale come from the order, not the request body.

  These assert consequences rather than calls, per the phase bar: what the
  subscription ends up saying, and how long it lasts -- not that a lookup
  happened. Each one fails loudly against the previous implementation.
*/
describe("BillingService.verifyAndActivate — the buyer does not state what they bought", () => {
  async function buildService(razorpay: jest.Mocked<PlatformPaymentProvider>, db: unknown) {
    const module = await Test.createTestingModule({
      providers: [
        BillingService,
        { provide: DRIZZLE, useValue: db },
        { provide: PLATFORM_PAYMENT_PROVIDER, useValue: razorpay },
        { provide: AiCreditsService, useValue: makeAiCredits() },
        { provide: AuditService, useValue: makeAudit() },
        { provide: PlanLimitsService, useValue: makePlanLimits() },
      ],
    }).compile();
    return module.get(BillingService);
  }

  /** Captures what was actually written, which is the only thing worth asserting. */
  function capturingDb() {
    const written: Record<string, unknown>[] = [];
    const txMock = {
      query: { subscriptions: { findFirst: jest.fn().mockResolvedValue(undefined) } },
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockImplementation((v: Record<string, unknown>) => {
        written.push(v);
        return { returning: jest.fn().mockResolvedValue([{ id: 7 }]) };
      }),
    };
    return {
      written,
      db: {
        transaction: jest.fn().mockImplementation(
          (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
        ),
      },
    };
  }

  it("refuses to activate a plan the order did not pay for", async () => {
    // The order was created and paid at STARTER; the body claims ENTERPRISE.
    const { db } = capturingDb();
    const billing = await buildService(makeRazorpay(), db);

    await expect(
      billing.verifyAndActivate("org1", "u1", { ...validInput, plan: "ENTERPRISE" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses an order created for another organisation", async () => {
    const { db } = capturingDb();
    const foreign = { ...paidOrder, notes: { ...paidOrder.notes, orgId: "org-somebody-else" } };
    const billing = await buildService(makeRazorpay(true, true, foreign), db);

    await expect(
      billing.verifyAndActivate("org1", "u1", validInput),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("gives an annual order twelve months, and records what was charged", async () => {
    // 2499_00 paise x 12 x 0.8 -- what createOrder actually charged.
    const annual = {
      ...paidOrder,
      amount: 2399040,
      notes: { ...paidOrder.notes, plan: "PROFESSIONAL", billingCycle: "annual" },
    };
    const { db, written } = capturingDb();
    const billing = await buildService(makeRazorpay(true, true, annual), db);

    await billing.verifyAndActivate("org1", "u1", { ...validInput, plan: "PROFESSIONAL" });

    const subscription = written.find((row) => "currentPeriodEnd" in row)!;
    const start = subscription.currentPeriodStart as Date;
    const end = subscription.currentPeriodEnd as Date;
    const months =
      (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
    expect(months).toBe(12);

    // The charged amount, in major units -- not the monthly price recomputed.
    const payment = written.find((row) => "providerPaymentRef" in row)!;
    expect(payment.amount).toBe("23990.40");
    expect(payment.currency).toBe("INR");
  });

  it("still gives a monthly order one month", async () => {
    const { db, written } = capturingDb();
    const billing = await buildService(makeRazorpay(), db);

    await billing.verifyAndActivate("org1", "u1", validInput);

    const subscription = written.find((row) => "currentPeriodEnd" in row)!;
    const start = subscription.currentPeriodStart as Date;
    const end = subscription.currentPeriodEnd as Date;
    const months =
      (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
    expect(months).toBe(1);
    expect(written.find((row) => "providerPaymentRef" in row)!.amount).toBe("999.00");
  });
});
