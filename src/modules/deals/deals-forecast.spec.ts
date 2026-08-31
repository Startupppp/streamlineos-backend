import { DealsForecastService } from "./deals-forecast.service";
import { DealsAnalyticsService } from "./deals-analytics.service";
import type { Db } from "../../db/drizzle.module";
import { CrmMetadataService } from "../crm/metadata/crm-metadata.service";
import { CacheService } from "../../common/cache/cache.service";

function makeChain(result: unknown[] = []): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const methods = ["from", "where", "leftJoin", "innerJoin", "rightJoin", "orderBy", "groupBy", "having", "limit", "offset"];
  for (const method of methods) {
    chain[method] = jest.fn(() => chain);
  }
  chain.then = (resolve: (value: unknown[]) => unknown) => resolve(result);
  return chain;
}

function makeMockDb(selectResult: unknown[] = []): Db {
  const first = selectResult[0];
  return {
    select: jest.fn(() => makeChain(selectResult)),
    query: {
      deals: {
        findFirst: jest.fn().mockResolvedValue(
          first ? { ...(first as Record<string, unknown>), activities: [] } : undefined,
        ),
      },
      crmForecastSnapshots: {
        findFirst: jest.fn().mockResolvedValue(undefined),
      },
    },
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

describe("DealsForecastService – forecast snapshots", () => {
  let service: DealsForecastService;
  let mockDb: Db;

  beforeEach(() => {
    mockDb = makeMockDb();
    service = new DealsForecastService(
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
    mockDb = makeMockDb([
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
    ]);
    const mockForecast = {
      getForecast: jest.fn(),
      createForecastSnapshot: jest.fn(),
      getForecastSnapshots: jest.fn(),
      overrideForecastSnapshot: jest.fn(),
      compareForecastSnapshots: jest.fn(),
    } as unknown as DealsForecastService;
    service = new DealsAnalyticsService(
      mockDb,
      mockCache as unknown as CacheService,
      mockCrmMetadata as unknown as CrmMetadataService,
      mockForecast,
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
