import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { BillingService } from "./billing.service";
import { RazorpayService } from "./razorpay.service";
import { AiCreditsService } from "./ai-credits.service";
import { AuditService } from "../../../common/audit/audit.service";
import { PlanLimitsService } from "./plan-limits.service";

const validInput = {
  razorpay_order_id: "order_test_1",
  razorpay_payment_id: "pay_test_abc123",
  razorpay_signature: "valid_sig",
  plan: "STARTER" as const,
};

function makeRazorpay(configured = true, signatureValid = true) {
  return {
    isConfigured: jest.fn().mockReturnValue(configured),
    verifyPaymentSignature: jest.fn().mockReturnValue(signatureValid),
    getKeyId: jest.fn().mockReturnValue("rzp_test_key"),
  };
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
        { provide: RazorpayService, useValue: makeRazorpay() },
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
        { provide: RazorpayService, useValue: makeRazorpay(true, false) },
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
        { provide: RazorpayService, useValue: makeRazorpay(false) },
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
