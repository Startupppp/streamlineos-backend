import { KbIndexingService } from "./kb-indexing.service";
import { runWithTenantContext } from "../../../common/tenant/tenant-context";

describe("KbIndexingService.reindexAllPages", () => {
  it("bounds a large run and returns a cursor that resumes at the overflow", async () => {
    const firstBatch = Array.from({ length: 101 }, (_, index) => ({ id: index + 1, orgId: "org-1" }));
    const secondBatch = [{ id: 101, orgId: "org-1" }];
    const batches = [firstBatch, secondBatch];
    const limits: number[] = [];
    const indexPage = jest.fn().mockResolvedValue(undefined);
    const db = {
      select: jest.fn(() => {
        const rows = batches.shift() ?? [];
        const chain = {
          from: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          limit: jest.fn((limit: number) => {
            limits.push(limit);
            return Promise.resolve(rows);
          }),
        };
        return chain;
      }),
    };
    const service = new KbIndexingService(db as never, {} as never, {} as never);
    service.indexPage = indexPage;

    /**
     * The page listing now opens a tenant transaction, because `POST /kb/pages/reindex-all`
     * is `@NoTenantTransaction()` and a bare pool read carries no GUC — `kb_pages`' policy
     * resolves the org through `app.current_org_id_or_null()`, so it would have matched
     * nothing and reported `reindexed: 0`. Here the ambient context stands in for the
     * outbox-driven caller, which is the branch `runInTenantTransaction` reuses; the
     * no-ambient branch is proved against a real Postgres in
     * `kb-page-reindex-placement.db.spec.ts`.
     */
    const inTenant = <T>(fn: () => Promise<T>): Promise<T> =>
      runWithTenantContext({ orgId: "org-1", audience: "INTERNAL", tx: db as never }, fn);

    const first = await inTenant(() => service.reindexAllPages("org-1"));
    expect(first).toEqual({ reindexed: 100, nextPageId: 100 });
    expect(indexPage).toHaveBeenCalledTimes(100);
    expect(limits[0]).toBe(101);

    const second = await inTenant(() => service.reindexAllPages("org-1", first.nextPageId ?? 0));
    expect(second).toEqual({ reindexed: 1, nextPageId: null });
    expect(indexPage).toHaveBeenLastCalledWith("org-1", 101);
    expect(limits).toEqual([101, 101]);
  });
});
