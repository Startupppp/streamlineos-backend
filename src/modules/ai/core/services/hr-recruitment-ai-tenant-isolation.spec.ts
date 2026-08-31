jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db),
}));

import { HrRecruitmentAiService } from "./hr-recruitment-ai.service";
import type { Db } from "../../../../db/drizzle.module";
import type { AiGatewayService } from "../gateway/ai-gateway.service";

beforeEach(() => jest.resetAllMocks());

function makeWhereChain(rows: unknown[]) {
  const where = jest.fn().mockResolvedValue(rows);
  const from = jest.fn().mockReturnValue({ where });
  return { from, where };
}

describe("HrRecruitmentAiService — cross-tenant isolation", () => {
  it("returns null when candidate belongs to a different org (BOLA — cross-tenant denied)", async () => {
    const mockGateway = { invokeStructured: jest.fn() } as unknown as AiGatewayService;
    const mockDb = {
      select: jest.fn().mockReturnValue(makeWhereChain([])),
    } as unknown as Db;

    const svc = new HrRecruitmentAiService(mockDb, mockGateway);
    const result = await svc.scoreCandidate("org-attacker", 99);

    expect(result).toBeNull();
    expect(mockGateway.invokeStructured).not.toHaveBeenCalled();
  });

  it("calls gateway when candidate belongs to the same org (same-tenant control)", async () => {
    const candidate = {
      id: 1,
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      currentCompany: "Acme",
      currentRole: "Engineer",
      experienceYears: 5,
      skills: ["TypeScript"],
      source: "LinkedIn",
      notes: null,
      orgId: "org-owner",
    };

    const mockGatewayWithResult = {
      invokeStructured: jest.fn().mockResolvedValue({
        ok: true,
        data: { score: 75, fitLevel: "good", reasoning: "Good match", strengths: [], concerns: [], suggestedQuestions: [] },
      }),
    } as unknown as AiGatewayService;

    const mockDb = {
      select: jest.fn().mockReturnValue(makeWhereChain([candidate])),
    } as unknown as Db;

    const svc = new HrRecruitmentAiService(mockDb, mockGatewayWithResult);
    const result = await svc.scoreCandidate("org-owner", 1);

    expect(result).not.toBeNull();
    expect(mockGatewayWithResult.invokeStructured).toHaveBeenCalledTimes(1);
  });
});
