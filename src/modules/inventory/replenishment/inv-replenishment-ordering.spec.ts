import { InvReplenishmentService } from "./inv-replenishment.service";

/**
 * Proves that getForecasting orders before it paginates.
 *
 * Without ORDER BY, Postgres may return rows in any order between pages, so
 * page 2 can silently repeat rows from page 1 or omit rows entirely. That is a
 * correctness bug, not a performance one.
 *
 * The paged query is still a Drizzle builder chain here, so the order the
 * builder is driven in is the thing to watch: `.groupBy().orderBy().limit()
 * .offset()`. The bite is proven by deleting the `.orderBy(...)` line from
 * `getForecasting` — "orders before it paginates" then fails because no
 * orderBy is ever recorded.
 */

interface Recorder {
  order: string[];
}

interface PagedChain {
  limit: jest.Mock;
}

interface StockChain {
  groupBy: jest.Mock;
  where: jest.Mock;
}

function buildStockChain(rec: Recorder): StockChain {
  const paged: PagedChain = {
    limit: jest.fn(() => ({
      offset: jest.fn(() => {
        rec.order.push("offset");
        return Promise.resolve([]);
      }),
    })),
  };

  const chain: StockChain = {
    groupBy: jest.fn(() => ({
      orderBy: jest.fn((..._args: unknown[]) => {
        rec.order.push("orderBy");
        return paged;
      }),
      // Present so a chain that skips orderBy still terminates rather than
      // throwing — the assertion, not a TypeError, is what must report it.
      limit: paged.limit,
    })),
    where: jest.fn(() => chain),
  };
  return chain;
}

function buildDb(rec: Recorder) {
  const stockChain = buildStockChain(rec);
  const salesChain = {
    where: jest.fn(() => ({ groupBy: jest.fn(() => Promise.resolve([])) })),
  };
  const countChain = { where: jest.fn(() => Promise.resolve([{ total: 0 }])) };

  let call = 0;
  return {
    select: jest.fn(() => {
      call += 1;
      if (call === 1)
        return {
          from: jest.fn(() => ({
            innerJoin: jest.fn(() => ({ innerJoin: jest.fn(() => stockChain) })),
          })),
        };
      if (call === 2) return { from: jest.fn(() => salesChain) };
      return { from: jest.fn(() => countChain) };
    }),
  };
}

function buildService(rec: Recorder) {
  return new InvReplenishmentService(
    buildDb(rec) as never,
    {
      cachedVersioned: jest.fn((_ns: string, _k: string, fn: () => Promise<unknown>) => fn()),
    } as never,
    { next: jest.fn() } as never,
    { propose: jest.fn() } as never,
    { can: jest.fn().mockResolvedValue(true) } as never,
  );
}

describe("InvReplenishmentService.getForecasting — deterministic ORDER BY before paging", () => {
  it("drives the paged query at all, so an empty sweep cannot pass", async () => {
    const rec: Recorder = { order: [] };
    await buildService(rec).getForecasting("org1", { page: 2, limit: 5 });
    expect(rec.order).toContain("offset");
  });

  it("orders before it paginates", async () => {
    const rec: Recorder = { order: [] };
    await buildService(rec).getForecasting("org1", { page: 2, limit: 5 });

    const orderBy = rec.order.indexOf("orderBy");
    const offset = rec.order.indexOf("offset");

    expect(orderBy).toBeGreaterThanOrEqual(0);
    expect(offset).toBeGreaterThan(orderBy);
  });
});
