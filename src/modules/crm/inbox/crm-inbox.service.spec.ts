import { NotFoundException } from "@nestjs/common";
import { CrmInboxService } from "./crm-inbox.service";
import { CrmInboxQueriesService } from "./crm-inbox-queries.service";
import type { CrmInboxAiActionsService } from "./crm-inbox-ai-actions.service";

function makeQueryChain(resolvedValue: unknown) {
  const chain = {
    select: jest.fn(),
    from: jest.fn(),
    innerJoin: jest.fn(),
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
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockResolvedValue(resolvedValue);
  chain.update.mockReturnValue(chain);
  chain.set.mockReturnValue(chain);
  return chain;
}

describe("CrmInboxQueriesService", () => {
  let queriesService: CrmInboxQueriesService;
  let mockDb: ReturnType<typeof makeQueryChain>;

  beforeEach(() => {
    mockDb = makeQueryChain([]);
    const mockAiActions = {
      resolveMetadata: jest.fn().mockResolvedValue({ terminalLeadKeys: [], openStageKeys: [] }),
      computeAiActions: jest.fn().mockResolvedValue([]),
    } as unknown as CrmInboxAiActionsService;
    queriesService = new CrmInboxQueriesService(mockDb as never, mockAiActions);
  });

  it("should be defined", () => {
    expect(queriesService).toBeDefined();
  });

  it("getInbox returns 8 sections", async () => {
    const result = await queriesService.getInbox("org1", "user1", "all");
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
    const result = await queriesService.getCounts("org1", "user1", "own");
    expect(Object.keys(result)).toHaveLength(8);
    Object.values(result).forEach((v) => expect(typeof v).toBe("number"));
  });
});

describe("CrmInboxService", () => {
  let service: CrmInboxService;
  let mockDb: ReturnType<typeof makeQueryChain>;
  let mockQueriesService: CrmInboxQueriesService;

  beforeEach(() => {
    mockDb = makeQueryChain([]);
    mockQueriesService = {
      getInbox: jest.fn().mockResolvedValue({ sections: [], aiActions: [] }),
      getCounts: jest.fn().mockResolvedValue({ dueTasks: 0, overdueTasks: 0, slaRisk: 0, stuckDeals: 0, followUpsDue: 0, newReplies: 0, meetingsToday: 0, newlyAssigned: 0 }),
    } as unknown as CrmInboxQueriesService;
    service = new CrmInboxService(mockDb as never, mockQueriesService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  it("getInbox delegates to queries service", async () => {
    await service.getInbox("org1", "user1", "all");
    expect(mockQueriesService.getInbox).toHaveBeenCalledWith("org1", "user1", "all");
  });

  it("getCounts delegates to queries service", async () => {
    await service.getCounts("org1", "user1", "own");
    expect(mockQueriesService.getCounts).toHaveBeenCalledWith("org1", "user1", "own");
  });

  it("snoozeTask throws NotFoundException for unknown task", async () => {
    mockDb.limit = jest.fn().mockResolvedValue([]);
    await expect(
      service.snoozeTask("org1", 9999, "user1", { until: new Date().toISOString() }, "all"),
    ).rejects.toThrow(NotFoundException);
  });

  it("completeTask throws NotFoundException for unknown task", async () => {
    mockDb.limit = jest.fn().mockResolvedValue([]);
    await expect(service.completeTask("org1", 9999, "user1", "all")).rejects.toThrow(
      NotFoundException,
    );
  });

  it("snoozeTask under own scope cannot reach a task assigned to someone else", async () => {
    mockDb.limit = jest.fn().mockResolvedValue([]);
    await expect(
      service.snoozeTask("org1", 4242, "user1", { until: new Date().toISOString() }, "own"),
    ).rejects.toThrow(NotFoundException);
  });

  it("completeTask under own scope cannot reach a task assigned to someone else", async () => {
    mockDb.limit = jest.fn().mockResolvedValue([]);
    await expect(service.completeTask("org1", 4242, "user1", "own")).rejects.toThrow(
      NotFoundException,
    );
  });
});
