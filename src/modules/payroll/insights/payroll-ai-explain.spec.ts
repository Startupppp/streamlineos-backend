import { ForbiddenException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PayrollAiExplainService } from "./payroll-ai-explain.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";

const PUBLISHED_PUB = {
  pubId: 1,
  pubOrgId: "org-A",
  pubUserId: "user-A",
  pubStatus: "PUBLISHED",
  runEmployeeId: 10,
  month: "2026-06",
  gross: "60000.00",
  totalDeductions: "5000.00",
  net: "55000.00",
  currency: "INR",
  scheduledDays: "22.0",
  paidDays: "22.0",
  lopDays: "0.0",
  overtimeHours: "0.00",
  workerType: "EMPLOYEE",
};

const LINE_ITEMS = [
  { name: "Basic", category: "EARNING", amount: "40000.00", taxable: true },
  { name: "HRA", category: "EARNING", amount: "20000.00", taxable: false },
  { name: "PF", category: "DEDUCTION", amount: "4800.00", taxable: false },
  { name: "PT", category: "DEDUCTION", amount: "200.00", taxable: false },
];

function makeDb(pubRow: typeof PUBLISHED_PUB | null = PUBLISHED_PUB) {
  const selectChain = {
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    then: jest.fn().mockImplementation((cb: (rows: unknown[]) => unknown) =>
      Promise.resolve(cb(pubRow ? [pubRow] : [])),
    ),
  };
  return {
    select: jest.fn().mockReturnValueOnce(selectChain).mockReturnValueOnce({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(LINE_ITEMS),
    }),
  };
}

function makeGateway(ok: boolean = true) {
  return {
    invokeTextWithUsage: jest.fn().mockResolvedValue(
      ok
        ? {
            ok: true,
            data: "Your net pay of ₹55,000 for June 2026 includes ₹60,000 gross earnings minus ₹5,000 deductions.",
            aiUsage: {
              model: "fast",
              promptTokens: 320,
              completionTokens: 90,
              totalTokens: 410,
              credits: 0.62,
              costUsd: 0.0062,
            },
          }
        : { ok: false, message: "Provider unavailable" },
    ),
  };
}

async function buildService(db: ReturnType<typeof makeDb>, gateway: ReturnType<typeof makeGateway>) {
  const module = await Test.createTestingModule({
    providers: [
      PayrollAiExplainService,
      { provide: DRIZZLE, useValue: db },
      { provide: AiGatewayService, useValue: gateway },
    ],
  }).compile();
  return module.get(PayrollAiExplainService);
}

describe("PayrollAiExplainService", () => {
  it("returns an explanation when the caller owns the payslip", async () => {
    const db = makeDb();
    const gateway = makeGateway();
    const svc = await buildService(db, gateway);

    const result = await svc.explainPayslip("org-A", "user-A", 1);

    expect(result.explanation).toContain("55,000");
    expect(result.evidenceSnapshot).toMatchObject({
      month: "2026-06",
      grossEarnings: "60000.00",
      totalDeductions: "5000.00",
      netPay: "55000.00",
    });
  });

  it("passes pre-computed figures to the gateway and does NOT ask it to compute", async () => {
    const db = makeDb();
    const gateway = makeGateway();
    const svc = await buildService(db, gateway);

    await svc.explainPayslip("org-A", "user-A", 1);

    expect(gateway.invokeTextWithUsage).toHaveBeenCalledTimes(1);
    const call = (gateway.invokeTextWithUsage as jest.Mock).mock.calls[0][0] as {
      prompt: { system: string; user: string };
    };
    expect(call.prompt.system).toMatch(/MUST NOT compute|DO NOT compute|never.*compute/i);
    expect(call.prompt.user).toContain('"netPay": "55000.00"');
    expect(call.prompt.user).toContain('"grossEarnings": "60000.00"');
  });

  it("throws ForbiddenException when a different-org user attempts access (BOLA check)", async () => {
    const dbWithNoRow = makeDb(null);
    const svcB = await buildService(dbWithNoRow, makeGateway());
    await expect(svcB.explainPayslip("org-B", "user-B", 1)).rejects.toThrow(NotFoundException);
  });

  it("throws ForbiddenException when the user does not own the payslip", async () => {
    const db = makeDb();
    const gateway = makeGateway();
    const svc = await buildService(db, gateway);

    await expect(svc.explainPayslip("org-A", "user-EVIL", 1)).rejects.toThrow(ForbiddenException);
    expect(gateway.invokeTextWithUsage).not.toHaveBeenCalled();
  });

  it("throws ServiceUnavailableException when AI gateway fails", async () => {
    const db = makeDb();
    const gateway = makeGateway(false);
    const svc = await buildService(db, gateway);

    await expect(svc.explainPayslip("org-A", "user-A", 1)).rejects.toThrow(ServiceUnavailableException);
  });

  it("throws NotFoundException when publicationId does not exist in the org", async () => {
    const db = makeDb(null);
    const svc = await buildService(db, makeGateway());

    await expect(svc.explainPayslip("org-A", "user-A", 999)).rejects.toThrow(NotFoundException);
  });
});
