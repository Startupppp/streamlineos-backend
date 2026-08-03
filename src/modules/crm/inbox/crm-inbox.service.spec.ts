import { NotFoundException } from "@nestjs/common";
import { CrmInboxService } from "./crm-inbox.service";
import type { CrmInboxAiActionsService } from "./crm-inbox-ai-actions.service";

function makeQueryChain(resolvedValue: unknown) {
  const chain = {
    select: jest.fn(),
    from: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
    update: jest.fn(),
    set: jest.fn(),
    then: jest.fn((resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolve(resolvedValue)),
    ),
  };
  chain.select.mockReturnValue(chain);
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockResolvedValue(resolvedValue);
  chain.update.mockReturnValue(chain);
  chain.set.mockReturnValue(chain);
  return chain;
}

describe("CrmInboxService", () => {
  let service: CrmInboxService;
  let mockDb: ReturnType<typeof makeQueryChain>;

  beforeEach(() => {
    mockDb = makeQueryChain([]);
    const mockAiActions = {
      resolveMetadata: jest.fn().mockResolvedValue({ terminalLeadKeys: [], openStageKeys: [] }),
      computeAiActions: jest.fn().mockResolvedValue([]),
    } as unknown as CrmInboxAiActionsService;
    service = new CrmInboxService(mockDb as never, mockAiActions);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  it("getInbox returns 8 sections", async () => {
    const result = await service.getInbox("org1", "user1", "all");
    expect(result.sections).toHaveLength(8);
    const keys = result.sections.map((s) => s.key);
    expect(keys).toContain("dueTasks");
    expect(keys).toContain("overdueTasks");
    expect(keys).toContain("slaRisk");
    expect(keys).toContain("stuckDeals");
  });

  it("getCounts returns all 8 keys as numbers", async () => {
    const countChain = makeQueryChain([{ n: "5" }]);
    mockDb.select = jest.fn().mockReturnValue(countChain);
    const result = await service.getCounts("org1", "user1", "own");
    expect(Object.keys(result)).toHaveLength(8);
    Object.values(result).forEach((v) => expect(typeof v).toBe("number"));
  });

  it("snoozeTask throws NotFoundException for unknown task", async () => {
    mockDb.limit = jest.fn().mockResolvedValue([]);
    await expect(
      service.snoozeTask("org1", 9999, "user1", { until: new Date().toISOString() }),
    ).rejects.toThrow(NotFoundException);
  });

  it("completeTask throws NotFoundException for unknown task", async () => {
    mockDb.limit = jest.fn().mockResolvedValue([]);
    await expect(service.completeTask("org1", 9999)).rejects.toThrow(NotFoundException);
  });
});
