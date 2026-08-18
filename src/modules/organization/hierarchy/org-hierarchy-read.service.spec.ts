import type { OrgHierarchyCacheService } from "../../../common/cache/org-hierarchy-cache.service";
import type { Db } from "../../../db/drizzle.module";
import { OrgHierarchyReadService } from "./org-hierarchy-read.service";
import type { OrgHierarchyTreeSourceService } from "./org-hierarchy-tree-source.service";

describe("OrgHierarchyReadService", () => {
  const orgId = "org-1";
  const accessContext = { actorUserId: "user-1", scope: "all" as const };
  let selectQuery: jest.Mock;
  let hierarchyCache: { read: jest.Mock };
  let treeSource: {
    resolveReadProfile: jest.Mock;
    loadTreeRows: jest.Mock;
  };
  let service: OrgHierarchyReadService;

  beforeEach(() => {
    selectQuery = jest.fn();
    hierarchyCache = {
      read: jest
        .fn()
        .mockImplementation(
          async (
            _orgId: string,
            _resource: string,
            _context: unknown,
            fetcher: () => Promise<unknown>,
          ) => fetcher(),
        ),
    };
    treeSource = {
      resolveReadProfile: jest
        .fn()
        .mockResolvedValue({ mode: "ADJACENCY", revision: 0 }),
      loadTreeRows: jest.fn(),
    };
    service = new OrgHierarchyReadService(
      { select: selectQuery } as unknown as Db,
      hierarchyCache as unknown as OrgHierarchyCacheService,
      treeSource as unknown as OrgHierarchyTreeSourceService,
    );
  });

  it("uses one grouped database query for the hierarchy overview", async () => {
    const groupByKind = jest.fn().mockResolvedValue([
      { kind: "BUSINESS_UNIT", count: 2 },
      { kind: "DEPARTMENT", count: 7 },
      { kind: "TEAM", count: 11 },
    ]);
    selectQuery.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ groupBy: groupByKind }),
      }),
    });

    await expect(service.getHierarchy(orgId, accessContext)).resolves.toEqual({
      businessUnits: 2,
      branches: 0,
      departments: 7,
      teams: 11,
      locations: 0,
      costCenters: 0,
    });

    expect(selectQuery).toHaveBeenCalledTimes(1);
    expect(groupByKind).toHaveBeenCalledTimes(1);
    expect(hierarchyCache.read).toHaveBeenCalledWith(
      orgId,
      "overview",
      accessContext,
      expect.any(Function),
    );
  });

  it("uses the profile-selected source to build a tree on a cache miss", async () => {
    treeSource.loadTreeRows.mockResolvedValue([
      {
        id: "business-unit-1",
        orgId,
        kind: "BUSINESS_UNIT",
        parentId: null,
        name: "Operations",
        code: "OPS",
        description: null,
        headUserId: null,
        status: "ACTIVE",
        metadata: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        deletedAt: null,
      },
    ]);

    const tree = await service.getTree(orgId, accessContext);

    expect(treeSource.resolveReadProfile).toHaveBeenCalledWith(orgId);
    expect(treeSource.loadTreeRows).toHaveBeenCalledWith(orgId, {
      mode: "ADJACENCY",
      revision: 0,
    });
    expect(hierarchyCache.read).toHaveBeenCalledWith(
      orgId,
      "tree:ADJACENCY:r0",
      accessContext,
      expect.any(Function),
    );
    expect(tree).toEqual([
      expect.objectContaining({
        id: "business-unit-1",
        type: "business_unit",
        children: [],
      }),
    ]);
  });

  it("does not query the database when the versioned cache serves the tree", async () => {
    const cachedTree = [{ id: "cached-unit", children: [] }];
    hierarchyCache.read.mockResolvedValue(cachedTree);

    await expect(service.getTree(orgId, accessContext)).resolves.toBe(
      cachedTree,
    );
    expect(selectQuery).not.toHaveBeenCalled();
    expect(treeSource.loadTreeRows).not.toHaveBeenCalled();
  });
});
