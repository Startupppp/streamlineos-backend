import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import type { CacheService } from "../../../common/cache/cache.service";
import type { Db } from "../../../db/drizzle.module";
import { OrgStructureService } from "./org-structure.service";

describe("OrgStructureService headcount aggregation", () => {
  it("groups department headcount in one query behind the versioned tenant namespace", async () => {
    const groupByDepartment = jest.fn().mockResolvedValue([
      { label: "Engineering", count: 12 },
      { label: "Unassigned", count: 2 },
    ]);
    const joinChain: Record<string, jest.Mock> = {
      leftJoin: jest.fn(),
      where: jest.fn().mockReturnValue({ groupBy: groupByDepartment }),
    };
    joinChain["leftJoin"].mockReturnValue(joinChain);
    const selectHeadcount = jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue(joinChain),
      }),
    });
    const cache = {
      cachedVersioned: jest
        .fn()
        .mockImplementation(
          async (
            _namespace: string,
            _cacheKey: string,
            fetcher: () => Promise<unknown>,
          ) => fetcher(),
        ),
    };
    const service = new OrgStructureService(
      { select: selectHeadcount } as unknown as Db,
      cache as unknown as CacheService,
      undefined as never,
    );

    await expect(
      service.getHeadcount("org-1", { groupBy: "department" }),
    ).resolves.toEqual([
      { label: "Engineering", count: 12 },
      { label: "Unassigned", count: 2 },
    ]);

    expect(selectHeadcount).toHaveBeenCalledTimes(1);
    expect(groupByDepartment).toHaveBeenCalledTimes(1);
    expect(cache.cachedVersioned).toHaveBeenCalledWith(
      CACHE_KEYS.hrHeadcountNamespace("org-1"),
      "group:department",
      expect.any(Function),
      300,
    );
  });
});
