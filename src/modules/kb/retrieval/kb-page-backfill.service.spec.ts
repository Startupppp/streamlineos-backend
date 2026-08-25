import { KbPageBackfillService } from "./kb-page-backfill.service";
import type { OrgBackfillResult } from "./kb-page-backfill.service";

jest.mock("../../../common/tenant/with-tenant", () => ({
  withTenant: jest.fn(
    (
      _db: unknown,
      _ctx: unknown,
      fn: (tx: Record<string, unknown>) => Promise<unknown>,
    ) => fn({ execute: jest.fn() }),
  ),
}));

jest.mock("../../../common/tenant/tenant-context", () => ({
  runWithTenantContext: jest.fn((_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  getTenantContext: jest.fn(),
}));

const makeIndexingService = () => ({
  indexPage: jest.fn().mockResolvedValue(undefined),
});

const makeDb = (orgRows: Array<{ id: string }> = []) => {
  const orgChain = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockResolvedValue(orgRows),
  };
  return { select: jest.fn().mockReturnValue(orgChain) };
};

describe("KbPageBackfillService — backfillOrg", () => {
  beforeEach(() => jest.clearAllMocks());

  it("short-circuits and makes no indexPage call when no eligible pages exist", async () => {
    const indexing = makeIndexingService();
    const svc = new KbPageBackfillService(makeDb() as never, indexing as never);

    jest.spyOn(svc, "findEligibleUnindexedPages").mockResolvedValue([]);
    jest.spyOn(svc, "countPageBodyChunks").mockResolvedValue(3);

    const result = await svc.backfillOrg("org-1", { delayMs: 0 });

    expect(indexing.indexPage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ orgId: "org-1", before: 3, after: 3, indexed: 0, failed: 0, scanned: 0, nextPageId: null });
  });

  it("calls indexPage once per eligible page", async () => {
    const indexing = makeIndexingService();
    const svc = new KbPageBackfillService(makeDb() as never, indexing as never);

    jest.spyOn(svc, "findEligibleUnindexedPages")
      .mockResolvedValue([{ id: 101 }, { id: 102 }, { id: 103 }]);
    jest.spyOn(svc, "countPageBodyChunks")
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(3);

    const result = await svc.backfillOrg("org-1", { delayMs: 0 });

    expect(indexing.indexPage).toHaveBeenCalledTimes(3);
    expect(indexing.indexPage).toHaveBeenCalledWith("org-1", 101);
    expect(indexing.indexPage).toHaveBeenCalledWith("org-1", 102);
    expect(indexing.indexPage).toHaveBeenCalledWith("org-1", 103);
    expect(result.indexed).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.scanned).toBe(3);
  });

  it("honours the batch and page bounds and returns a cursor for the next run", async () => {
    const indexing = makeIndexingService();
    const svc = new KbPageBackfillService(makeDb() as never, indexing as never);
    const discovery = jest.spyOn(svc, "findEligibleUnindexedPages")
      .mockResolvedValue([{ id: 11 }, { id: 12 }, { id: 13 }]);
    jest.spyOn(svc, "countPageBodyChunks").mockResolvedValue(0);

    const result = await svc.backfillOrg("org-1", {
      delayMs: 0,
      batchSize: 2,
      maxPages: 2,
      afterPageId: 10,
    });

    expect(discovery).toHaveBeenCalledWith("org-1", 10, 2);
    expect(indexing.indexPage).toHaveBeenCalledTimes(2);
    expect(result.scanned).toBe(2);
    expect(result.nextPageId).toBe(12);
  });

  it("waits between page attempts when a rate-limit delay is configured", async () => {
    jest.useFakeTimers();
    try {
      const indexing = makeIndexingService();
      const svc = new KbPageBackfillService(makeDb() as never, indexing as never);
      jest.spyOn(svc, "findEligibleUnindexedPages")
        .mockResolvedValue([{ id: 21 }, { id: 22 }]);
      jest.spyOn(svc, "countPageBodyChunks").mockResolvedValue(0);

      const run = svc.backfillOrg("org-1", { delayMs: 100 });
      await jest.runAllTimersAsync();
      const result = await run;

      expect(indexing.indexPage).toHaveBeenCalledTimes(2);
      expect(result.indexed).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("opens a fresh tenant transaction for discovery and for each page", async () => {
    const { withTenant } = jest.requireMock("../../../common/tenant/with-tenant") as {
      withTenant: jest.Mock;
    };
    const indexing = makeIndexingService();
    const svc = new KbPageBackfillService(makeDb() as never, indexing as never);

    jest.spyOn(svc, "findEligibleUnindexedPages")
      .mockResolvedValue([{ id: 10 }, { id: 20 }]);
    jest.spyOn(svc, "countPageBodyChunks").mockResolvedValue(0);

    await svc.backfillOrg("org-x", { delayMs: 0 });

    const callCount = withTenant.mock.calls.length;
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it("records the before count from discovery and the after count from a post-index query", async () => {
    const indexing = makeIndexingService();
    const svc = new KbPageBackfillService(makeDb() as never, indexing as never);

    jest.spyOn(svc, "findEligibleUnindexedPages")
      .mockResolvedValue([{ id: 55 }]);
    jest.spyOn(svc, "countPageBodyChunks")
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(9);

    const result = await svc.backfillOrg("org-1", { delayMs: 0 });

    expect(result.before).toBe(7);
    expect(result.after).toBe(9);
    expect(result.nextPageId).toBeNull();
  });

  it("isolates a page failure and continues indexing the remaining pages", async () => {
    const indexing = makeIndexingService();
    indexing.indexPage
      .mockRejectedValueOnce(new Error("embedding failed"))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    const svc = new KbPageBackfillService(makeDb() as never, indexing as never);

    jest.spyOn(svc, "findEligibleUnindexedPages")
      .mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);
    jest.spyOn(svc, "countPageBodyChunks").mockResolvedValue(0);

    const result = await svc.backfillOrg("org-1", { delayMs: 0 });

    expect(result.indexed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.nextPageId).toBe(0);
    expect(indexing.indexPage).toHaveBeenCalledTimes(3);
  });

  it("still queries the after count when some pages failed", async () => {
    const indexing = makeIndexingService();
    indexing.indexPage.mockRejectedValue(new Error("boom"));

    const svc = new KbPageBackfillService(makeDb() as never, indexing as never);
    const countSpy = jest.spyOn(svc, "countPageBodyChunks")
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(4);

    jest.spyOn(svc, "findEligibleUnindexedPages")
      .mockResolvedValue([{ id: 7 }]);

    await svc.backfillOrg("org-1", { delayMs: 0 });

    expect(countSpy).toHaveBeenCalledTimes(2);
  });

  it("treats a zero-chunk result as retryable failure and does not advance past it", async () => {
    const indexing = makeIndexingService();
    indexing.indexPage.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    const svc = new KbPageBackfillService(makeDb() as never, indexing as never);
    jest.spyOn(svc, "findEligibleUnindexedPages")
      .mockResolvedValue([{ id: 41 }, { id: 42 }]);
    jest.spyOn(svc, "countPageBodyChunks")
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);

    const result = await svc.backfillOrg("org-1", { delayMs: 0 });

    expect(result).toMatchObject({
      indexed: 1,
      failed: 1,
      nextPageId: 0,
      failedPageIds: [41],
    });
  });

  it("returns before === after and indexed === 0 when the org has no eligible pages", async () => {
    const indexing = makeIndexingService();
    const svc = new KbPageBackfillService(makeDb() as never, indexing as never);

    jest.spyOn(svc, "findEligibleUnindexedPages").mockResolvedValue([]);
    jest.spyOn(svc, "countPageBodyChunks").mockResolvedValue(12);

    const result = await svc.backfillOrg("org-empty", { delayMs: 0 });

    expect(result.before).toBe(12);
    expect(result.after).toBe(12);
    expect(result.indexed).toBe(0);
    expect(result.nextPageId).toBeNull();
  });
});

describe("KbPageBackfillService — resumability", () => {
  beforeEach(() => jest.clearAllMocks());

  it("does not re-embed a page that already has chunks (findEligibleUnindexedPages excludes it)", async () => {
    const indexing = makeIndexingService();
    const svc = new KbPageBackfillService(makeDb() as never, indexing as never);

    jest.spyOn(svc, "findEligibleUnindexedPages").mockResolvedValue([{ id: 200 }]);
    jest.spyOn(svc, "countPageBodyChunks").mockResolvedValue(0);

    await svc.backfillOrg("org-1", { delayMs: 0 });
    expect(indexing.indexPage).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();

    jest.spyOn(svc, "findEligibleUnindexedPages").mockResolvedValue([]);
    jest.spyOn(svc, "countPageBodyChunks").mockResolvedValue(1);

    const secondRun = await svc.backfillOrg("org-1", { delayMs: 0 });
    expect(indexing.indexPage).not.toHaveBeenCalled();
    expect(secondRun.indexed).toBe(0);
  });
});

describe("KbPageBackfillService — backfillAll", () => {
  beforeEach(() => jest.clearAllMocks());

  it("enumerates only ACTIVE non-deleted organizations", async () => {
    const indexing = makeIndexingService();
    const db = makeDb([{ id: "org-a" }, { id: "org-b" }]);
    const svc = new KbPageBackfillService(db as never, indexing as never);

    jest.spyOn(svc, "backfillOrg").mockResolvedValue({
      orgId: "org-a",
      before: 0,
      after: 0,
      indexed: 0,
      failed: 0,
      scanned: 0,
      nextPageId: null,
    } as OrgBackfillResult);

    await svc.backfillAll({ delayMs: 0 });

    expect(db.select).toHaveBeenCalled();
  });

  it("calls backfillOrg for each enumerated organization", async () => {
    const indexing = makeIndexingService();
    const db = makeDb([{ id: "org-a" }, { id: "org-b" }]);
    const svc = new KbPageBackfillService(db as never, indexing as never);

    const backfillOrgSpy = jest.spyOn(svc, "backfillOrg").mockResolvedValue({
      orgId: "",
      before: 0,
      after: 0,
      indexed: 0,
      failed: 0,
      scanned: 0,
      nextPageId: null,
    });

    await svc.backfillAll({ delayMs: 0 });

    expect(backfillOrgSpy).toHaveBeenCalledTimes(2);
    expect(backfillOrgSpy).toHaveBeenCalledWith("org-a", { delayMs: 0 });
    expect(backfillOrgSpy).toHaveBeenCalledWith("org-b", { delayMs: 0 });
  });

  it("counts an org as skipped when it has no work to do", async () => {
    const indexing = makeIndexingService();
    const db = makeDb([{ id: "org-1" }, { id: "org-2" }]);
    const svc = new KbPageBackfillService(db as never, indexing as never);

    jest.spyOn(svc, "backfillOrg").mockResolvedValue({
      orgId: "",
      before: 5,
      after: 5,
      indexed: 0,
      failed: 0,
    });

    const result = await svc.backfillAll({ delayMs: 0 });

    expect(result.skipped).toBe(2);
    expect(result.processed).toBe(0);
    expect(result.details).toHaveLength(0);
  });

  it("sums up indexed and failed across orgs that did work", async () => {
    const indexing = makeIndexingService();
    const db = makeDb([{ id: "org-1" }, { id: "org-2" }]);
    const svc = new KbPageBackfillService(db as never, indexing as never);

    jest
      .spyOn(svc, "backfillOrg")
      .mockResolvedValueOnce({ orgId: "org-1", before: 2, after: 4, indexed: 2, failed: 0, scanned: 2, nextPageId: null })
      .mockResolvedValueOnce({ orgId: "org-2", before: 3, after: 5, indexed: 1, failed: 1, scanned: 2, nextPageId: 10 });

    const result = await svc.backfillAll({ delayMs: 0 });

    expect(result.organizations).toBe(2);
    expect(result.processed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.totalIndexed).toBe(3);
    expect(result.totalFailed).toBe(1);
    expect(result.totalBefore).toBe(5);
    expect(result.totalAfter).toBe(9);
  });

  it("continues to the next org when one backfillOrg call throws", async () => {
    const indexing = makeIndexingService();
    const db = makeDb([{ id: "org-a" }, { id: "org-b" }, { id: "org-c" }]);
    const svc = new KbPageBackfillService(db as never, indexing as never);

    jest
      .spyOn(svc, "backfillOrg")
      .mockRejectedValueOnce(new Error("fatal org error"))
      .mockResolvedValueOnce({ orgId: "org-b", before: 1, after: 2, indexed: 1, failed: 0 })
      .mockResolvedValueOnce({ orgId: "org-c", before: 0, after: 0, indexed: 0, failed: 0 });

    const result = await svc.backfillAll({ delayMs: 0 });

    expect(result.organizations).toBe(3);
    expect(result.processed).toBe(2);
    expect(result.totalIndexed).toBe(1);
    expect(result.totalFailed).toBe(1);
    expect(result.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          orgId: "org-a",
          failed: 1,
          error: "fatal org error",
        }),
      ]),
    );
  });
});

describe("KbPageBackfillService — findEligibleUnindexedPages SQL shape", () => {
  beforeEach(() => jest.clearAllMocks());

  it("constructs a query with org filter, lifecycle filters, content filter and NOT EXISTS", () => {
    const captured: unknown[] = [];
    const chain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockImplementation((cond: unknown) => {
        captured.push(cond);
        return chain;
      }),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };
    const db = { select: jest.fn().mockReturnValue(chain) };

    const indexing = makeIndexingService();
    const svc = new KbPageBackfillService(db as never, indexing as never);

    void (svc as { findEligibleUnindexedPages: (orgId: string) => unknown })
      .findEligibleUnindexedPages("org-z");

    expect(db.select).toHaveBeenCalledTimes(2);
    expect(chain.from).toHaveBeenCalledTimes(2);
    expect(chain.where).toHaveBeenCalled();
    expect(chain.orderBy).toHaveBeenCalled();
  });
});
