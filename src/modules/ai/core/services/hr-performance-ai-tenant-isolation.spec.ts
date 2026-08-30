jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db),
}));

import { HrPerformanceAiService } from "./hr-performance-ai.service";
import type { Db } from "../../../../db/drizzle.module";
import type { AiGatewayService } from "../gateway/ai-gateway.service";

beforeEach(() => jest.resetAllMocks());

function makeThenable(rows: unknown[]) {
  const limit = jest.fn().mockResolvedValue(rows);
  const orderBy = jest.fn().mockReturnValue({ limit });
  const thenable = {
    then: (onFulfilled: (v: unknown) => void, onRejected?: (e: unknown) => void) =>
      Promise.resolve(rows).then(onFulfilled, onRejected),
    limit,
    orderBy,
  };
  return thenable;
}

function makeChainForEmployee(rows: unknown[]) {
  const where = jest.fn().mockReturnValue(makeThenable(rows));
  const innerJoin = jest.fn().mockReturnValue({ where });
  const from = jest.fn().mockReturnValue({ where, innerJoin });
  return { from };
}

function makeChainForCounter(rows: unknown[]) {
  const where = jest.fn().mockReturnValue(makeThenable(rows));
  const from = jest.fn().mockReturnValue({ where });
  return { from };
}

describe("HrPerformanceAiService — cross-tenant isolation", () => {
  it("returns null when employee belongs to a different org (BOLA — cross-tenant denied)", async () => {
    const mockGateway = { invokeStructured: jest.fn() } as unknown as AiGatewayService;

    const mockDb = {
      select: jest.fn().mockReturnValue(makeChainForEmployee([])),
    } as unknown as Db;

    const svc = new HrPerformanceAiService(mockDb, mockGateway);
    const result = await svc.analyzeAttritionRisk("org-attacker", "user-from-owner-org");

    expect(result).toBeNull();
    expect(mockGateway.invokeStructured).not.toHaveBeenCalled();
  });

  it("proceeds to gateway when employee is in the same org (same-tenant control)", async () => {
    const employee = { name: "Alice", role: "MEMBER", createdAt: new Date("2024-01-01") };
    const counter = [{ total: 10, present: 9 }];
    const empty: unknown[] = [];

    let callCount = 0;
    const mockDb = {
      select: jest.fn().mockImplementation(() => {
        callCount += 1;
        if (callCount === 1) return makeChainForEmployee([employee]);
        return makeChainForCounter(counter.length > 0 ? counter : empty);
      }),
    } as unknown as Db;

    const mockGatewayWithResult = {
      invokeStructured: jest.fn().mockResolvedValue({
        ok: true,
        data: {
          attritionRiskScore: 25,
          riskLevel: "low",
          keyFactors: [],
          recommendations: [],
        },
      }),
    } as unknown as AiGatewayService;

    const svc = new HrPerformanceAiService(mockDb, mockGatewayWithResult);
    const result = await svc.analyzeAttritionRisk("org-owner", "user-alice");

    expect(result).not.toBeNull();
    expect(mockGatewayWithResult.invokeStructured).toHaveBeenCalledTimes(1);
  });
});
