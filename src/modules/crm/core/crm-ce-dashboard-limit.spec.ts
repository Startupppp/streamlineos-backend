import { CrmCeDashboardService } from "./crm-ce-dashboard.service";
import type { Db } from "../../../db/drizzle.module";
import type { CacheService } from "../../../common/cache/cache.service";

describe("CrmCeDashboardService — metrics lookback cap", () => {
  afterEach(() => jest.resetAllMocks());

  function makeThenableChain() {
    const chain: Record<string, unknown> = {};
    const methods = ["from", "innerJoin", "leftJoin", "where", "groupBy", "orderBy", "limit"];
    for (const m of methods) chain[m] = jest.fn().mockReturnValue(chain);
    chain.then = (resolve: (v: never[]) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve([]).then(resolve, reject);
    return chain;
  }

  it("applies CRM_CE_METRICS_LOOKBACK limit to the crmMonthlyMetrics query", async () => {
    const metricsFindMany = jest.fn().mockResolvedValue([]);
    const selectChain = makeThenableChain();

    const db = {
      select: jest.fn().mockReturnValue(selectChain),
      query: {
        crmCompanies: { findMany: jest.fn().mockResolvedValue([]) },
        crmMonthlyMetrics: { findMany: metricsFindMany },
        crmActivities: { findMany: jest.fn().mockResolvedValue([]) },
        crmSupportTickets: { findMany: jest.fn().mockResolvedValue([]) },
      },
    } as unknown as Db;

    const cache = {
      cached: jest.fn().mockImplementation((_key: string, factory: () => unknown) => factory()),
    } as unknown as CacheService;

    const svc = new CrmCeDashboardService(db, cache);
    await svc.getCustomerExecutiveDashboard("org-1");

    expect(metricsFindMany).toHaveBeenCalled();
    const args = metricsFindMany.mock.calls[0]?.[0] as { limit?: number } | undefined;
    expect(typeof args?.limit).toBe("number");
    expect(args!.limit).toBeGreaterThan(0);
    expect(args!.limit).toBeLessThanOrEqual(120);
  });
});
