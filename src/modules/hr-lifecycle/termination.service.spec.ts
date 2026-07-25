process.env.APP_URL ??= "http://localhost:1000";

import { TerminationService } from "./termination.service";

describe("TerminationService.list — paginated envelope + status counts", () => {
  function buildService(rows: unknown[], statusRows: { status: string; count: string }[]) {
    const rowsChain = {
      from: () => rowsChain,
      leftJoin: () => rowsChain,
      where: () => rowsChain,
      orderBy: () => rowsChain,
      limit: () => rowsChain,
      offset: () => Promise.resolve(rows),
    };
    const statusChain = {
      from: () => statusChain,
      where: () => statusChain,
      groupBy: () => Promise.resolve(statusRows),
    };
    let call = 0;
    const db = { select: jest.fn(() => (call++ === 0 ? rowsChain : statusChain)) };
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

  it("returns data + pagination + statusCounts; caps limit at 100; unfiltered total is org-wide", async () => {
    const service = buildService(
      [{ id: 1 }],
      [
        { status: "DRAFT", count: "100" },
        { status: "COMPLETED", count: "37" },
      ],
    );
    const result = await service.list("org-1", { page: 2, limit: 500 });
    expect(result.data).toEqual([{ id: 1 }]);
    expect(result.pagination).toEqual({ page: 2, limit: 100, total: 137, totalPages: 2 });
    expect(result.statusCounts).toEqual({ DRAFT: 100, COMPLETED: 37, ALL: 137 });
  });

  it("total reflects the filtered status count when a status is given", async () => {
    const service = buildService(
      [],
      [
        { status: "DRAFT", count: "45" },
        { status: "APPROVED", count: "5" },
      ],
    );
    const result = await service.list("org-1", { page: 1, limit: 20, status: "DRAFT" });
    expect(result.pagination).toEqual({ page: 1, limit: 20, total: 45, totalPages: 3 });
    expect(result.statusCounts).toEqual({ DRAFT: 45, APPROVED: 5, ALL: 50 });
  });
});
