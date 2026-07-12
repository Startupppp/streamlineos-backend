import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { CrmInboxService } from "./crm-inbox.service";

const mockDb = {
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockResolvedValue([]),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  then: jest.fn(),
};

describe("CrmInboxService", () => {
  let service: CrmInboxService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        CrmInboxService,
        { provide: DRIZZLE, useValue: mockDb },
      ],
    }).compile();

    service = module.get(CrmInboxService);
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
    mockDb.then = jest.fn().mockResolvedValue(0);
    const result = await service.getCounts("org1", "user1", "own");
    const keys = Object.keys(result);
    expect(keys).toHaveLength(8);
    keys.forEach((k) => expect(typeof result[k as keyof typeof result]).toBe("number"));
  });

  it("snoozeTask throws NotFoundException for unknown task", async () => {
    mockDb.limit = jest.fn().mockResolvedValue([]);
    await expect(
      service.snoozeTask("org1", 9999, "user1", { until: new Date().toISOString() }),
    ).rejects.toThrow("Task not found");
  });

  it("completeTask throws NotFoundException for unknown task", async () => {
    mockDb.limit = jest.fn().mockResolvedValue([]);
    await expect(service.completeTask("org1", 9999, "user1")).rejects.toThrow("Task not found");
  });
});
