import { runWithTenantContext } from "../tenant";
import type { CacheService } from "./cache.service";
import {
  OrgHierarchyCacheService,
  type OrgHierarchyCacheResource,
} from "./org-hierarchy-cache.service";

const TREE: OrgHierarchyCacheResource = "tree:ADJACENCY:r1";

describe("OrgHierarchyCacheService", () => {
  let cache: {
    cachedVersionedForOrg: jest.Mock;
    invalidateNamespaceForOrg: jest.Mock;
  };
  let service: OrgHierarchyCacheService;

  beforeEach(() => {
    cache = {
      cachedVersionedForOrg: jest
        .fn()
        .mockImplementation(
          async (
            _orgId: string,
            _namespace: string,
            _cacheKey: string,
            fetcher: () => Promise<unknown>,
          ) => fetcher(),
        ),
      invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
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

    expect(cache.cachedVersionedForOrg.mock.calls.map((c) => [c[0], c[1]]))
      .toEqual([
        ["org-1", "org:hierarchy"],
        ["org-1", "org:hierarchy"],
        ["org-1", "org:hierarchy"],
        ["org-2", "org:hierarchy"],
      ]);
    expect(cache.cachedVersionedForOrg.mock.calls.map((c) => c[2]))
      .toEqual([
        "tree:ADJACENCY:r1:scope:all",
        "tree:ADJACENCY:r1:scope:team:actor:user-1",
        "tree:ADJACENCY:r1:scope:team:actor:user-2",
        "tree:ADJACENCY:r1:scope:team:actor:user-1",
      ]);
  });

  it("invalidates canonical hierarchy and HR headcount namespaces immediately outside a transaction", async () => {
    await service.invalidateAfterMutation("org-1");

    expect(cache.invalidateNamespaceForOrg).toHaveBeenCalledTimes(2);
    expect(cache.invalidateNamespaceForOrg).toHaveBeenCalledWith("org-1", "org:hierarchy");
    expect(cache.invalidateNamespaceForOrg).toHaveBeenCalledWith("org-1", "hr:headcount");
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

    expect(cache.invalidateNamespaceForOrg).not.toHaveBeenCalled();
    expect(afterCommit).toHaveLength(1);
    await afterCommit[0]!();
    expect(cache.invalidateNamespaceForOrg).toHaveBeenCalledTimes(2);
  });
});
