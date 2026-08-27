import { DealsAnalyticsService } from "./deals-analytics.service";
import type { Db } from "../../db/drizzle.module";
import { CrmMetadataService } from "../crm/metadata/crm-metadata.service";
import { CacheService } from "../../common/cache/cache.service";
import { FORECAST_HISTORY_REQUIREMENT } from "./forecast/forecast-cold-start";

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

/**
 * The cold-start label is the whole of ticket 06. A tenant with no closed
 * history has to be told that the number on screen is the weighted pipeline
 * they typed in themselves, and how far off a learned forecast is — not handed
 * a confident-looking total with nothing behind it.
 *
 * These fail if `basis` is dropped from the response or from the cached read
 * path, if the readiness counts are taken against the wrong stages, or if the
 * naive arm ever starts describing itself as learned.
 */
interface ForecastQueryResults {
  open: unknown[];
  closed: unknown[];
}

function makeForecastDb(results: ForecastQueryResults): Db {
  return {
    select: jest.fn(() => {
      const state = { grouped: false };
      const chain: Record<string, unknown> = {};
      for (const method of ["from", "where", "leftJoin", "orderBy", "limit", "offset"]) {
        chain[method] = jest.fn(() => chain);
      }
      // The grouped read is the closed-history count; the ungrouped one is the
      // open pipeline. Discriminating on groupBy rather than on call order means
      // these tests still test the label if the two reads are reordered or taken
      // out of the Promise.all — the previous harness handed the same canned
      // array to every select, so a readiness assertion on it passed for reasons
      // that had nothing to do with the counts.
      chain.groupBy = jest.fn(() => {
        state.grouped = true;
        return chain;
      });
      chain.then = (resolve: (value: unknown[]) => unknown) =>
        resolve(state.grouped ? results.closed : results.open);
      return chain;
    }),
  } as unknown as Db;
}

function makeTerminalMetadata(wonKey: string, lostKey: string) {
  return {
    getAggregate: jest.fn().mockResolvedValue({
      pipelines: [{ id: "pipe1", type: "deal", isDefault: true }],
      stages: [
        { key: "LEAD", pipelineId: "pipe1", stageType: "open", isTerminal: false, probability: 10, isActive: true },
        { key: wonKey, pipelineId: "pipe1", stageType: "won", isTerminal: true, probability: 100, isActive: true },
        { key: lostKey, pipelineId: "pipe1", stageType: "lost", isTerminal: true, probability: 0, isActive: true },
      ],
    }),
  };
}

function makeForecastService(results: ForecastQueryResults, wonKey = "WON", lostKey = "LOST") {
  return new DealsAnalyticsService(
    makeForecastDb(results),
    mockCache as unknown as CacheService,
    makeTerminalMetadata(wonKey, lostKey) as unknown as CrmMetadataService,
  );
}

const openDeal = {
  value: "100000",
  stage: "LEAD",
  probability: 50,
  expectedCloseDate: "2026-09-30",
  createdAt: new Date("2026-07-01").toISOString(),
};

describe("DealsAnalyticsService – forecast cold start", () => {
  it("tells a tenant with no closed history that the number is their own weighted pipeline", async () => {
    const service = makeForecastService({ open: [openDeal], closed: [] });

    const forecast = await service.getForecast("org1");

    expect(forecast.basis).toEqual({
      kind: "naive-weighted",
      reason: "insufficient-history",
      readiness: {
        ready: false,
        closedDeals: 0,
        wonDeals: 0,
        lostDeals: 0,
        minimumClosedDeals: FORECAST_HISTORY_REQUIREMENT.minClosedDeals,
        minimumPerOutcome: FORECAST_HISTORY_REQUIREMENT.minPerOutcome,
        closedDealsNeeded: FORECAST_HISTORY_REQUIREMENT.minClosedDeals,
        wonDealsNeeded: FORECAST_HISTORY_REQUIREMENT.minPerOutcome,
        lostDealsNeeded: FORECAST_HISTORY_REQUIREMENT.minPerOutcome,
      },
    });
  });

  it("counts closed deals against the tenant's own terminal stages, not the literal WON and LOST", async () => {
    const service = makeForecastService(
      {
        open: [openDeal],
        closed: [
          { stage: "CLOSED_WON", closed: 20 },
          { stage: "CLOSED_LOST", closed: 3 },
        ],
      },
      "CLOSED_WON",
      "CLOSED_LOST",
    );

    const forecast = await service.getForecast("org1");

    // 23 closed, so still short of the floor, and the missing outcome is what
    // the tenant is told about: twelve more losses, not "no more wins needed".
    expect(forecast.basis).toMatchObject({
      kind: "naive-weighted",
      reason: "insufficient-history",
      readiness: {
        ready: false,
        wonDeals: 20,
        lostDeals: 3,
        closedDeals: 23,
        wonDealsNeeded: 0,
        lostDealsNeeded: FORECAST_HISTORY_REQUIREMENT.minPerOutcome - 3,
        closedDealsNeeded: FORECAST_HISTORY_REQUIREMENT.minClosedDeals - 23,
      },
    });
  });

  it("does not call the forecast learned once the tenant crosses the floor, because nothing has been trained", async () => {
    const service = makeForecastService({
      open: [openDeal],
      closed: [
        { stage: "WON", closed: 40 },
        { stage: "LOST", closed: 40 },
      ],
    });

    const forecast = await service.getForecast("org1");

    // Crossing the floor is our cue to train, not permission to claim we did.
    // "not-trained-yet" is the gap on our side; a surface that renders it as
    // "not enough data" blames the tenant for it.
    expect(forecast.basis).toMatchObject({
      kind: "naive-weighted",
      reason: "not-trained-yet",
      readiness: { ready: true, closedDeals: 80, closedDealsNeeded: 0 },
    });
  });

  it("carries the label through the cached read path the controller returns, alongside the untouched totals", async () => {
    const service = makeForecastService({ open: [openDeal], closed: [] });

    const forecast = await service.getForecast("org1");

    // The controller is a passthrough, so this object is the response body:
    // every pre-existing field still means what it meant, plus the label.
    expect(forecast.totalWeighted).toBe(50000);
    expect(forecast.totalBestCase).toBe(100000);
    expect(forecast.totalDeals).toBe(1);
    expect(forecast.byMonth).toHaveLength(1);
    expect(forecast.byStage).toEqual([
      { stage: "LEAD", count: 1, totalValue: 100000, weightedValue: 50000, avgProbability: 50 },
    ]);
    expect(forecast.basis.kind).toBe("naive-weighted");
  });
});
