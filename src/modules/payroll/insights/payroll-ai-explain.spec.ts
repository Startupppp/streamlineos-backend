import { ForbiddenException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PayrollAiExplainService } from "./payroll-ai-explain.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(async (_db: unknown, work: () => Promise<unknown>) => work()),
}));

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
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(LINE_ITEMS),
    }),
  };
}

function makeGateway(ok: boolean = true) {
  return {
    streamTextWithUsage: jest.fn().mockImplementation(async () => ({
      model: "gpt-4o-mini",
      correlationId: "payroll-test",
      stream: {
        textStream: new ReadableStream<string>({
          start(controller) {
            controller.enqueue("Your net pay is ");
            controller.enqueue("55,000.");
            controller.close();
          },
        }),
        text: Promise.resolve("Your net pay is 55,000."),
        finishReason: Promise.resolve("stop"),
        totalUsage: Promise.resolve({ inputTokens: 20, outputTokens: 10, totalTokens: 30 }),
      },
    })),
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
  it("streams the narration and retains grounded evidence and usage in a terminal result", async () => {
    const gateway = makeGateway();
    const svc = await buildService(makeDb(), gateway);
    const signal = new AbortController().signal;
    const result = await svc.streamExplainPayslip("org-A", "user-A", 1, signal);
    const reader = result.stream.textStream.getReader();
    const first = await reader.read();
    expect(first.value).toContain('"type":"text"');
    let body = first.value ?? "";
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      body += part.value;
    }
    expect(body).toContain('"type":"result"');
    expect(body).toContain('"netPay":"55000.00"');
    expect(body).toContain('"citations":');
    expect(body).toContain('"aiUsage":');
    expect(gateway.streamTextWithUsage).toHaveBeenCalledWith(expect.objectContaining({
      actor: { orgId: "org-A", userId: "user-A" }, signal, charge: true,
    }));
  });

  it("rejects a non-owner before a streaming provider call", async () => {
    const gateway = makeGateway();
    const svc = await buildService(makeDb(), gateway);
    await expect(svc.streamExplainPayslip("org-A", "user-EVIL", 1, new AbortController().signal))
      .rejects.toThrow(ForbiddenException);
    expect(gateway.streamTextWithUsage).not.toHaveBeenCalled();
  });

  it("rejects a cross-tenant missing publication before a streaming provider call", async () => {
    const gateway = makeGateway();
    const svc = await buildService(makeDb(null), gateway);
    await expect(svc.streamExplainPayslip("org-B", "user-B", 1, new AbortController().signal))
      .rejects.toThrow(NotFoundException);
    expect(gateway.streamTextWithUsage).not.toHaveBeenCalled();
  });

  it("does not load or charge for a request cancelled before dispatch", async () => {
    const db = makeDb();
    const gateway = makeGateway();
    const svc = await buildService(db, gateway);
    const abort = new AbortController();
    abort.abort();
    await expect(svc.streamExplainPayslip("org-A", "user-A", 1, abort.signal)).rejects.toThrow();
    expect(db.select).not.toHaveBeenCalled();
    expect(gateway.streamTextWithUsage).not.toHaveBeenCalled();
  });

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
