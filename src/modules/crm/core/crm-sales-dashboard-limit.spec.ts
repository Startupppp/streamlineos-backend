import { CrmSalesDashboardService } from "./crm-sales-dashboard.service";
import type { Db } from "../../../db/drizzle.module";
import type { CacheService } from "../../../common/cache/cache.service";

describe("CrmSalesDashboardService — metrics lookback cap", () => {
  afterEach(() => jest.resetAllMocks());

  function makeThenableChain() {
    const chain: Record<string, unknown> = {};
    const methods = ["from", "innerJoin", "leftJoin", "where", "groupBy", "orderBy", "limit"];
    for (const m of methods) chain[m] = jest.fn().mockReturnValue(chain);
    chain.then = (resolve: (v: never[]) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve([]).then(resolve, reject);
    return chain;
  }

  it("applies CRM_METRICS_LOOKBACK limit to the crmMonthlyMetrics query", async () => {
    const metricsFindMany = jest.fn().mockResolvedValue([]);
    const selectChain = makeThenableChain();

    const db = {
      select: jest.fn().mockReturnValue(selectChain),
      query: {
        crmDeals: { findMany: jest.fn().mockResolvedValue([]) },
        crmMonthlyMetrics: { findMany: metricsFindMany },
        crmActivities: { findMany: jest.fn().mockResolvedValue([]) },
        crmPeople: { findMany: jest.fn().mockResolvedValue([]) },
        crmOptions: { findMany: jest.fn().mockResolvedValue([]) },
      },
    } as unknown as Db;

    const cache = {
      cached: jest.fn().mockImplementation((_key: string, factory: () => unknown) => factory()),
    } as unknown as CacheService;

    const svc = new CrmSalesDashboardService(db, cache);
    await svc.getSalesDashboard("org-1");

    expect(metricsFindMany).toHaveBeenCalled();
    const args = metricsFindMany.mock.calls[0]?.[0] as { limit?: number } | undefined;
    expect(typeof args?.limit).toBe("number");
    expect(args!.limit).toBeGreaterThan(0);
    expect(args!.limit).toBeLessThanOrEqual(120);
  });
});
