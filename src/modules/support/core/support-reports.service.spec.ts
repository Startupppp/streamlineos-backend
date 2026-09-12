import { Test, type TestingModule } from "@nestjs/testing";
import { SupportReportsService } from "./support-reports.service";
import { CacheService } from "../../../common/cache/cache.service";
import { DRIZZLE } from "../../../db/drizzle.constants";

const mockDb = {
  query: {
    supportQueues: { findMany: jest.fn().mockResolvedValue([]) },
    automationRules: { findMany: jest.fn().mockResolvedValue([]) },
  },
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  leftJoin: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  groupBy: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockResolvedValue([]),
};

/*
  One spy for both cache forms, so the "did we use the cache?" assertions below
  observe every call whichever the service reaches for.

  The two differ only in where the fetcher sits: `cachedForOrg(orgId, key, fn)`
  puts it third, `cached(key, fn, ttl)` puts it second. The alias assumed the
  org-scoped order for both, so a plain `cached` call bound the TTL to `fetcher`
  and the read died on "fetcher is not a function". Picking by argument type
  keeps one spy without pretending the signatures are the same.
*/
const cachedForOrg = jest.fn((...args: unknown[]) => {
  const fetcher = args.find((arg): arg is () => Promise<unknown> => typeof arg === "function");
  if (!fetcher) throw new Error("cache double: no fetcher argument");
  return fetcher();
});

const mockCache = {
  cached: cachedForOrg,
  cachedForOrg,
};

describe("SupportReportsService", () => {
  let service: SupportReportsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.query.supportQueues.findMany.mockResolvedValue([]);
    mockDb.query.automationRules.findMany.mockResolvedValue([]);
    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
    mockDb.leftJoin.mockReturnThis();
    mockDb.where.mockReturnThis();
    mockDb.groupBy.mockReturnThis();
    mockDb.orderBy.mockResolvedValue([]);
    // Same reason as the double above: the fetcher's position differs between
    // `cached` and `cachedForOrg`, so it is found by type rather than index.
    mockCache.cached.mockImplementation((...args: unknown[]) => {
      const fetcher = args.find((arg): arg is () => Promise<unknown> => typeof arg === "function");
      if (!fetcher) throw new Error("cache double: no fetcher argument");
      return fetcher();
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [SupportReportsService, { provide: DRIZZLE, useValue: mockDb }, { provide: CacheService, useValue: mockCache }],
    }).compile();
    service = module.get(SupportReportsService);
  });

  describe("getOverview", () => {
    it("computes SLA compliance from resolved+eligible tickets and reopen rate from resolved tickets", async () => {
      // First query: the aggregate `row` (via .where(...) resolving directly, no groupBy/orderBy chain)
      mockDb.where.mockResolvedValueOnce([
        {
          newTickets: 20,
          openTickets: 5,
          resolvedCount: 10,
          avgFirstResponseMinutes: 42.3,
          avgResolutionMinutes: 300.7,
          slaEligible: 8,
          slaBreachedResolved: 2,
          slaBreachedOpen: 1,
        },
      ]);
      // Second query: reopened count
      mockDb.where.mockResolvedValueOnce([{ reopenedCount: 3 }]);
      // groupBy queries (byChannel, byPriority, byCategory)
      mockDb.groupBy.mockReturnValueOnce([{ channel: "email", count: 12 }]);
      mockDb.groupBy.mockReturnValueOnce([{ priority: "HIGH", count: 4 }]);
      mockDb.groupBy.mockReturnValueOnce([{ category: "billing", count: 6 }]);

      const result = await service.getOverview("org1", {});

      expect(result.newTickets).toBe(20);
      expect(result.openTickets).toBe(5);
      expect(result.avgFirstResponseMinutes).toBe(42);
      expect(result.avgResolutionMinutes).toBe(301);
      expect(result.slaBreachCount).toBe(3); // 2 resolved-breach + 1 open-breach
      expect(result.slaCompliancePct).toBe(75); // (8 - 2) / 8 = 75%
      expect(result.reopenRate).toBe(30); // 3 / 10 = 30%
      expect(result.ticketsByChannel).toEqual([{ channel: "email", count: 12 }]);
    });

    it("returns a null compliance percentage when no tickets are SLA-eligible", async () => {
      mockDb.where.mockResolvedValueOnce([
        {
          newTickets: 0,
          openTickets: 0,
          resolvedCount: 0,
          avgFirstResponseMinutes: null,
          avgResolutionMinutes: null,
          slaEligible: 0,
          slaBreachedResolved: 0,
          slaBreachedOpen: 0,
        },
      ]);
      mockDb.where.mockResolvedValueOnce([{ reopenedCount: 0 }]);
      mockDb.groupBy.mockReturnValueOnce([]);
      mockDb.groupBy.mockReturnValueOnce([]);
      mockDb.groupBy.mockReturnValueOnce([]);

      const result = await service.getOverview("org1", {});
      expect(result.slaCompliancePct).toBeNull();
      expect(result.reopenRate).toBe(0);
    });

    it("bypasses the cache when filters are applied", async () => {
      mockDb.where.mockResolvedValueOnce([
        {
          newTickets: 1,
          openTickets: 1,
          resolvedCount: 0,
          avgFirstResponseMinutes: null,
          avgResolutionMinutes: null,
          slaEligible: 0,
          slaBreachedResolved: 0,
          slaBreachedOpen: 0,
        },
      ]);
      mockDb.where.mockResolvedValueOnce([{ reopenedCount: 0 }]);
      mockDb.groupBy.mockReturnValueOnce([]);
      mockDb.groupBy.mockReturnValueOnce([]);
      mockDb.groupBy.mockReturnValueOnce([]);

      await service.getOverview("org1", { agentId: "agent-1" });
      expect(mockCache.cached).not.toHaveBeenCalled();
    });

    it("uses the cache for the default (unfiltered) view", async () => {
      mockDb.where.mockResolvedValueOnce([
        {
          newTickets: 1,
          openTickets: 1,
          resolvedCount: 0,
          avgFirstResponseMinutes: null,
          avgResolutionMinutes: null,
          slaEligible: 0,
          slaBreachedResolved: 0,
          slaBreachedOpen: 0,
        },
      ]);
      mockDb.where.mockResolvedValueOnce([{ reopenedCount: 0 }]);
      mockDb.groupBy.mockReturnValueOnce([]);
      mockDb.groupBy.mockReturnValueOnce([]);
      mockDb.groupBy.mockReturnValueOnce([]);

      await service.getOverview("org1", {});
      expect(mockCache.cached).toHaveBeenCalled();
    });
  });

  describe("getQueuePerformance", () => {
    it("resolves queue names for each grouped row", async () => {
      mockDb.orderBy.mockResolvedValueOnce([
        { queueId: 5, queueName: "Billing", ticketsHandled: 10, openTickets: 3, avgResolutionMinutes: 120 },
      ]);

      const result = await service.getQueuePerformance("org1", {});
      expect(result).toEqual([
        { queueId: 5, queueName: "Billing", ticketsHandled: 10, openTickets: 3, avgResolutionMinutes: 120 },
      ]);
    });
  });

  describe("getAutomationPerformance", () => {
    it("resolves automation rule names for each grouped row, labeling deleted rules", async () => {
      mockDb.orderBy.mockResolvedValueOnce([{ ruleId: 9, ruleName: null, total: 5, succeeded: 4, failed: 1, skipped: 0 }]);

      const result = await service.getAutomationPerformance("org1", {});
      expect(result).toEqual([
        { ruleId: 9, ruleName: "Deleted automation", total: 5, succeeded: 4, failed: 1, skipped: 0 },
      ]);
    });
  });
});
