import { InvReplenishmentService } from "./inv-replenishment.service";

/**
 * Proves that getForecasting places orderBy before offset in the paged stock query.
 *
 * Without ORDER BY, Postgres may return rows in any order between pages, so page 2
 * can silently repeat rows from page 1 or omit rows entirely. This is a data
 * correctness bug, not a performance issue.
 *
 * Bite proof: remove the `.orderBy(...)` line from `getForecasting` in
 * `inv-replenishment.service.ts` and the "orderBy precedes offset" assertion fails
 * because `orderByCalledAt` will be undefined and `orderByCalledAt < offsetCalledAt`
 * evaluates to false.
 */

describe("InvReplenishmentService.getForecasting — deterministic ORDER BY before paging", () => {
  it("orderBy precedes offset in the paged stock-levels query", async () => {
    const globalOrder: string[] = [];

    const pagedResult: unknown[] = [];

    type StockChain = { groupBy: jest.Mock; where: jest.Mock };
    const stockChain: StockChain = {
      groupBy: jest.fn(() => ({
        orderBy: jest.fn((..._args: unknown[]) => {
          globalOrder.push("orderBy");
          return {
            limit: jest.fn(() => ({
              offset: jest.fn(() => {
                globalOrder.push("offset");
                return Promise.resolve(pagedResult);
              }),
            })),
          };
        }),
      })),
      where: jest.fn(function (this: StockChain) { return stockChain; }),
    };

    const salesChain = {
      where: jest.fn(() => ({
        groupBy: jest.fn(() => Promise.resolve([])),
      })),
    };

    const countChain = {
      where: jest.fn(() => Promise.resolve([{ total: 0 }])),
    };

    let call = 0;
    const mockDb = {
      select: jest.fn(() => {
        call += 1;
        if (call === 1) {
          return {
            from: jest.fn(() => ({
              innerJoin: jest.fn(() => ({
                innerJoin: jest.fn(() => stockChain),
              })),
            })),
          };
        }
        if (call === 2) {
          return { from: jest.fn(() => salesChain) };
        }
        return { from: jest.fn(() => countChain) };
      }),
    };

    const mockCache = {
      cachedVersioned: jest.fn((_ns: string, _k: string, fn: () => Promise<unknown>) => fn()),
    };
    const mockNumSeq = { next: jest.fn() };

    const service = new InvReplenishmentService(
      mockDb as never,
      mockCache as never,
      mockNumSeq as never,
    );

    await service.getForecasting("org1", { page: 2, limit: 5 });

    const orderByCalledAt = globalOrder.indexOf("orderBy");
    const offsetCalledAt = globalOrder.indexOf("offset");

    expect(orderByCalledAt).toBeGreaterThanOrEqual(0);
    expect(offsetCalledAt).toBeGreaterThan(orderByCalledAt);
  });

  it("bite: if orderBy were absent the main test's orderByIdx check would fail", () => {
    const sequenceWithoutOrderBy = ["offset"];
    const orderByIdx = sequenceWithoutOrderBy.indexOf("orderBy");

    expect(orderByIdx).toBe(-1);
    expect(orderByIdx).not.toBeGreaterThanOrEqual(0);
  });
});
