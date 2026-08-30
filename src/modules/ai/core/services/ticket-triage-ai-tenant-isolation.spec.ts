jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db),
}));

import { NotFoundException } from "@nestjs/common";
import { TicketTriageAiService } from "./ticket-triage-ai.service";
import type { Db } from "../../../../db/drizzle.module";
import type { AiGatewayService } from "../gateway/ai-gateway.service";
import type { AuditService } from "../../../../common/audit/audit.service";

const mockAudit = { log: jest.fn() } as unknown as AuditService;

beforeEach(() => jest.resetAllMocks());

function makeSelectChain(rows: unknown[]) {
  const limit = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ limit });
  const from = jest.fn().mockReturnValue({ where, limit });
  return { from, where, limit };
}

describe("TicketTriageAiService — cross-tenant isolation", () => {
  it("throws NotFoundException when ticket belongs to a different org (BOLA — cross-tenant denied)", async () => {
    const mockGateway = { invokeStructured: jest.fn() } as unknown as AiGatewayService;
    const mockDb = {
      select: jest.fn().mockReturnValue(makeSelectChain([])),
    } as unknown as Db;

    const svc = new TicketTriageAiService(mockDb, mockGateway, mockAudit);

    await expect(svc.suggestSubtasks("org-attacker", "user-1", 10, 999)).rejects.toThrow(NotFoundException);
    expect(mockGateway.invokeStructured).not.toHaveBeenCalled();
  });

  it("calls gateway when ticket belongs to the same org (same-tenant control)", async () => {
    const ticket = {
      id: 1,
      title: "Fix auth bug",
      description: "Login fails with 2FA",
      type: "bug",
      status: "open",
      priority: "high",
      projectId: 10,
    };

    const mockGatewayWithResult = {
      invokeStructured: jest.fn().mockResolvedValue({
        ok: true,
        data: { subtasks: [{ title: "Write unit tests" }, { title: "Update docs" }] },
      }),
    } as unknown as AiGatewayService;

    let callCount = 0;
    const mockDb = {
      select: jest.fn().mockImplementation(() => {
        callCount += 1;
        return makeSelectChain(callCount === 1 ? [ticket] : []);
      }),
    } as unknown as Db;

    const svc = new TicketTriageAiService(mockDb, mockGatewayWithResult, mockAudit);
    const result = await svc.suggestSubtasks("org-owner", "user-1", 10, 1);

    expect(result.subtasks.length).toBeGreaterThan(0);
    expect(mockGatewayWithResult.invokeStructured).toHaveBeenCalledTimes(1);
  });
});
