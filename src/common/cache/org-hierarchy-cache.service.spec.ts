import { runWithTenantContext } from "../tenant";
import { CACHE_KEYS } from "./cache-keys";
import type { CacheService } from "./cache.service";
import {
  OrgHierarchyCacheService,
  type OrgHierarchyCacheResource,
} from "./org-hierarchy-cache.service";

const TREE: OrgHierarchyCacheResource = "tree:ADJACENCY:r1";

describe("OrgHierarchyCacheService", () => {
  let cache: {
    cachedVersioned: jest.Mock;
    invalidateNamespace: jest.Mock;
  };
  let service: OrgHierarchyCacheService;

  beforeEach(() => {
    cache = {
      cachedVersioned: jest
        .fn()
        .mockImplementation(
          async (
            _namespace: string,
            _cacheKey: string,
            fetcher: () => Promise<unknown>,
          ) => fetcher(),
        ),
      invalidateNamespace: jest.fn().mockResolvedValue(undefined),
    };
    service = new OrgHierarchyCacheService(cache as unknown as CacheService);
  });

  it("partitions versioned entries by tenant and permission-derived viewer scope", async () => {
    const fetchTree = jest.fn().mockResolvedValue([]);

    await service.read(
      "org-1",
      TREE,
      { actorUserId: "user-all", scope: "all" },
      fetchTree,
    );
    await service.read(
      "org-1",
      TREE,
      { actorUserId: "user-1", scope: "team" },
      fetchTree,
    );
    await service.read(
      "org-1",
      TREE,
      { actorUserId: "user-2", scope: "team" },
      fetchTree,
    );
    await service.read(
      "org-2",
      TREE,
      { actorUserId: "user-1", scope: "team" },
      fetchTree,
    );

    expect(cache.cachedVersioned.mock.calls.map((cacheCall) => cacheCall[0]))
      .toEqual([
        CACHE_KEYS.orgHierarchyNamespace("org-1"),
        CACHE_KEYS.orgHierarchyNamespace("org-1"),
        CACHE_KEYS.orgHierarchyNamespace("org-1"),
        CACHE_KEYS.orgHierarchyNamespace("org-2"),
      ]);
    expect(cache.cachedVersioned.mock.calls.map((cacheCall) => cacheCall[1]))
      .toEqual([
        "tree:ADJACENCY:r1:scope:all",
        "tree:ADJACENCY:r1:scope:team:actor:user-1",
        "tree:ADJACENCY:r1:scope:team:actor:user-2",
        "tree:ADJACENCY:r1:scope:team:actor:user-1",
      ]);
  });

  it("invalidates canonical hierarchy and HR headcount namespaces immediately outside a transaction", async () => {
    await service.invalidateAfterMutation("org-1");

    expect(cache.invalidateNamespace).toHaveBeenCalledTimes(2);
    expect(cache.invalidateNamespace).toHaveBeenCalledWith(
      CACHE_KEYS.orgHierarchyNamespace("org-1"),
    );
    expect(cache.invalidateNamespace).toHaveBeenCalledWith(
      CACHE_KEYS.hrHeadcountNamespace("org-1"),
    );
  });

  it("defers invalidation until the tenant transaction commits", async () => {
    const afterCommit: Array<() => Promise<unknown>> = [];

    await runWithTenantContext(
      {
        orgId: "org-1",
        audience: "INTERNAL",
        tx: {} as never,
        afterCommit,
      },
      () => service.invalidateAfterMutation("org-1"),
    );

    expect(cache.invalidateNamespace).not.toHaveBeenCalled();
    expect(afterCommit).toHaveLength(1);
    await afterCommit[0]!();
    expect(cache.invalidateNamespace).toHaveBeenCalledTimes(2);
  });
});
