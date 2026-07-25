process.env.APP_URL ??= "http://localhost:1000";

import { TerminationService } from "./termination.service";

describe("TerminationService.list — paginated envelope", () => {
  function buildService(rows: unknown[], total: number) {
    const rowsChain = {
      from: () => rowsChain,
      leftJoin: () => rowsChain,
      where: () => rowsChain,
      orderBy: () => rowsChain,
      limit: () => rowsChain,
      offset: () => Promise.resolve(rows),
    };
    const countChain = { from: () => countChain, where: () => Promise.resolve([{ total }]) };
    let call = 0;
    const db = { select: jest.fn(() => (call++ === 0 ? rowsChain : countChain)) };
    return new TerminationService(
      db as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
  }

  it("returns { data, pagination } and hard-caps limit at 100", async () => {
    const service = buildService([{ id: 1 }], 137);
    const result = await service.list("org-1", { page: 2, limit: 500 });
    expect(result.data).toEqual([{ id: 1 }]);
    expect(result.pagination).toEqual({ page: 2, limit: 100, total: 137, totalPages: 2 });
  });

  it("computes totalPages from the capped limit", async () => {
    const service = buildService([], 45);
    const result = await service.list("org-1", { page: 1, limit: 20 });
    expect(result.pagination).toEqual({ page: 1, limit: 20, total: 45, totalPages: 3 });
  });
});
