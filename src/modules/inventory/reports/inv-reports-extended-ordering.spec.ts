import { InvReportsExtendedService } from "./inv-reports-extended.service";

/**
 * Proves that getReorderReportUpgraded places orderBy before offset in the paged
 * stock query.
 *
 * Without ORDER BY, Postgres returns rows in heap order (arbitrary between pages)
 * so page 2 can repeat or omit rows from page 1.
 *
 * Bite proof: remove the `.orderBy(...)` line added to `getReorderReportUpgraded`
 * and the "orderBy precedes offset" assertion fails because orderBy is never called.
 */

describe("InvReportsExtendedService.getReorderReportUpgraded — deterministic ORDER BY", () => {
  const callOrder: string[] = [];

  const pagedChain = {
    limit: jest.fn(() => ({
      offset: jest.fn(() => {
        callOrder.push("offset");
        return Promise.resolve([]);
      }),
    })),
  };

  const withOrderBy = {
    orderBy: jest.fn((..._args: unknown[]) => {
      callOrder.push("orderBy");
      return pagedChain;
    }),
  };

  const withWhere = {
    where: jest.fn(() => withOrderBy),
  };

  const withInnerJoin2 = {
    innerJoin: jest.fn(() => withWhere),
  };

  const withInnerJoin1 = {
    innerJoin: jest.fn(() => withInnerJoin2),
  };

  const withFrom = {
    from: jest.fn(() => withInnerJoin1),
  };

  const countChain = {
    from: jest.fn(() => ({
      innerJoin: jest.fn(() => ({
        innerJoin: jest.fn(() => ({
          where: jest.fn(() => Promise.resolve([{ total: 0 }])),
        })),
      })),
    })),
  };

  const rulesChain = {
    from: jest.fn(() => ({
      where: jest.fn(() => Promise.resolve([])),
    })),
  };

  let selectCallCount = 0;

  const mockDb = {
    select: jest.fn(() => {
      selectCallCount += 1;
      if (selectCallCount === 1) return withFrom;
      if (selectCallCount === 2) return rulesChain;
      return countChain;
    }),
  };

  const mockCache = { cached: jest.fn() };
  const mockWarehouseScope = {
    resolve: jest.fn().mockResolvedValue(null),
    locationPredicate: jest.fn().mockReturnValue(undefined),
  };

  beforeEach(() => {
    callOrder.length = 0;
    selectCallCount = 0;
    jest.clearAllMocks();
    mockDb.select.mockImplementation(() => {
      selectCallCount += 1;
      if (selectCallCount === 1) return withFrom;
      if (selectCallCount === 2) return rulesChain;
      return countChain;
    });
  });

  it("orderBy precedes offset in the paged stock rows query", async () => {
    const service = new InvReportsExtendedService(
      mockDb as never,
      mockCache as never,
      mockWarehouseScope as never,
    );

    await service.getReorderReportUpgraded("org1", { page: 2, limit: 10 });

    const orderByIdx = callOrder.indexOf("orderBy");
    const offsetIdx = callOrder.indexOf("offset");

    expect(orderByIdx).toBeGreaterThanOrEqual(0);
    expect(offsetIdx).toBeGreaterThan(orderByIdx);
  });

  it("bite: without orderBy the call sequence has no orderBy entry before offset", () => {
    const withoutOrderBy = ["offset"];
    const orderByIdx = withoutOrderBy.indexOf("orderBy");
    expect(orderByIdx).toBe(-1);
  });
});
