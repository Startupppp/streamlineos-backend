jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db),
}));

import { HrHelpdeskAiService } from "./hr-helpdesk-ai.service";
import type { Db } from "../../../../db/drizzle.module";
import type { AiGatewayService } from "../gateway/ai-gateway.service";

beforeEach(() => jest.resetAllMocks());

function makeChain(rows: unknown[]) {
  const where = jest.fn().mockReturnValue({
    then: (onFulfilled: (v: unknown) => void, onRejected?: (e: unknown) => void) =>
      Promise.resolve(rows).then(onFulfilled, onRejected),
  });
  const leftJoin = jest.fn().mockReturnValue({ where });
  const from = jest.fn().mockReturnValue({ leftJoin, where });
  return { from };
}

describe("HrHelpdeskAiService — cross-tenant isolation", () => {
  it("returns null when helpdesk ticket belongs to a different org (BOLA — cross-tenant denied)", async () => {
    const mockGateway = { invokeStructured: jest.fn() } as unknown as AiGatewayService;
    const mockDb = {
      select: jest.fn().mockReturnValue(makeChain([])),
    } as unknown as Db;

    const svc = new HrHelpdeskAiService(mockDb, mockGateway);
    const result = await svc.suggestHelpdeskReply("org-attacker", 99);

    expect(result).toBeNull();
    expect(mockGateway.invokeStructured).not.toHaveBeenCalled();
  });

  it("calls gateway when ticket belongs to the same org (same-tenant control)", async () => {
    const ticket = {
      title: "My ticket",
      description: "Issue description",
      category: "IT",
      priority: "HIGH",
      userId: "user-1",
      employeeName: "Alice",
    };

    const mockGatewayWithResult = {
      invokeStructured: jest.fn().mockResolvedValue({
        ok: true,
        data: { subject: "Re: My ticket", body: "Thanks for reaching out.", tone: "professional" },
      }),
    } as unknown as AiGatewayService;

    const mockDb = {
      select: jest.fn().mockReturnValue(makeChain([ticket])),
    } as unknown as Db;

    const svc = new HrHelpdeskAiService(mockDb, mockGatewayWithResult);
    const result = await svc.suggestHelpdeskReply("org-owner", 1);

    expect(result).not.toBeNull();
    expect(mockGatewayWithResult.invokeStructured).toHaveBeenCalledTimes(1);
  });
});
