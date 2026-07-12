import { DealsAnalyticsService } from "./deals-analytics.service";
import type { Db } from "../../db/drizzle.module";
import { CrmMetadataService } from "../crm-metadata/crm-metadata.service";
import { CacheService } from "../../common/cache/cache.service";

function makeMockDb(): Db {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
          limit: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([
          {
            id: "snap1",
            orgId: "org1",
            period: "2026-07",
            capturedAt: new Date().toISOString(),
            createdById: "user1",
            data: {
              byCategory: [],
              byRep: [],
              totalWeighted: 0,
              totalBestCase: 0,
              totalDeals: 0,
              period: "2026-07",
            },
            createdAt: new Date().toISOString(),
          },
        ]),
      }),
    }),
  } as unknown as Db;
}

const mockCache: jest.Mocked<Pick<CacheService, "cached" | "invalidate">> = {
  cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()),
  invalidate: jest.fn(),
};

const mockCrmMetadata: jest.Mocked<Pick<CrmMetadataService, "getAggregate">> = {
  getAggregate: jest.fn().mockResolvedValue({
    pipelines: [{ id: "pipe1", type: "deal", isDefault: true }],
    stages: [
      { key: "LEAD", pipelineId: "pipe1", stageType: "open", isTerminal: false, probability: 10, isActive: true },
      { key: "WON", pipelineId: "pipe1", stageType: "won", isTerminal: true, probability: 100, isActive: true },
      { key: "LOST", pipelineId: "pipe1", stageType: "lost", isTerminal: true, probability: 0, isActive: true },
    ],
  }),
};

describe("DealsAnalyticsService – forecast snapshots", () => {
  let service: DealsAnalyticsService;
  let mockDb: Db;

  beforeEach(() => {
    mockDb = makeMockDb();
    service = new DealsAnalyticsService(
      mockDb,
      mockCache as unknown as CacheService,
      mockCrmMetadata as unknown as CrmMetadataService,
    );
  });

  it("createForecastSnapshot inserts a snapshot row and returns it", async () => {
    const result = await service.createForecastSnapshot("org1", "user1", { period: "2026-07" });

    expect(result).toMatchObject({ id: "snap1", period: "2026-07", orgId: "org1" });
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it("getForecastSnapshots queries by orgId", async () => {
    await service.getForecastSnapshots("org1", {});

    expect(mockDb.select).toHaveBeenCalled();
  });
});

describe("DealsAnalyticsService – deal health", () => {
  let service: DealsAnalyticsService;
  let mockDb: Db;

  beforeEach(() => {
    mockDb = makeMockDb();
    (mockDb.select as jest.Mock).mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([
            {
              id: 42,
              orgId: "org1",
              stage: "PROPOSAL",
              probability: 50,
              value: "100000",
              expectedCloseDate: new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0],
              updatedAt: new Date(Date.now() - 5 * 86400000).toISOString(),
              createdAt: new Date().toISOString(),
            },
          ]),
          orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    });
    service = new DealsAnalyticsService(
      mockDb,
      mockCache as unknown as CacheService,
      mockCrmMetadata as unknown as CrmMetadataService,
    );
  });

  it("returns a health object with score and level", async () => {
    const health = await service.getDealHealth("org1", 42);

    expect(health).toMatchObject({
      dealId: 42,
      score: expect.any(Number),
      level: expect.stringMatching(/healthy|at_risk|critical|unknown/),
    });
  });
});
