import { ProjectsAnalyticsService } from "./projects-analytics.service";
import { CacheService } from "../../../common/cache/cache.service";

const DUMMY_PROJECT = { id: 7, orgId: "org-1" };

function makeChain(result: unknown[]): Record<string, unknown> {
  const settled = Promise.resolve(result);
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  for (const m of ["from", "innerJoin", "leftJoin", "where", "groupBy", "orderBy", "limit"]) {
    chain[m] = self;
  }
  chain["then"] = (fn: (v: unknown[]) => unknown): unknown => settled.then(fn);
  chain["catch"] = (fn: (e: unknown) => unknown): unknown => settled.catch(fn);
  chain["finally"] = (fn: () => void): unknown => settled.finally(fn);
  return chain;
}

function makeCachePassThrough(): CacheService {
  return {
    cachedVersioned: jest
      .fn()
      .mockImplementation(
        (_ns: string, _key: string, fetcher: () => Promise<unknown>) => fetcher(),
      ),
  } as unknown as CacheService;
}

function makeCacheCapturing(keys: string[]): CacheService {
  return {
    cachedVersioned: jest.fn().mockImplementation(
      (_ns: string, key: string, fetcher: () => Promise<unknown>) => {
        keys.push(key);
        return fetcher();
      },
    ),
  } as unknown as CacheService;
}

function makeDb(opts: { memberRow?: { id: number } } = {}) {
  const projectFindFirst = jest.fn().mockResolvedValue(DUMMY_PROJECT);
  const memberFindFirst = jest
    .fn()
    .mockResolvedValue(opts.memberRow ?? undefined);
  const execute = jest.fn().mockResolvedValue([]);
  const select = jest.fn().mockReturnValue(makeChain([]));

  const rawDb = {
    query: {
      projects: { findFirst: projectFindFirst },
      organizationMembers: { findFirst: memberFindFirst },
    },
    select,
    execute,
  };

  return { rawDb, projectFindFirst, memberFindFirst, execute, select };
}

describe("ProjectsAnalyticsService — filter propagation (C5)", () => {
  it("does not query organizationMembers when no ownerId filter is supplied so unfiltered analytics are returned", async () => {
    const { rawDb, memberFindFirst } = makeDb();
    const service = new ProjectsAnalyticsService(
      rawDb as never,
      makeCachePassThrough(),
    );

    await service.getProjectAnalytics("org-1", 7, {});

    expect(memberFindFirst).not.toHaveBeenCalled();
  });

  it("looks up the organization member when ownerId is supplied so the assignee filter targets that user's membership", async () => {
    const { rawDb, memberFindFirst } = makeDb({ memberRow: { id: 42 } });
    const service = new ProjectsAnalyticsService(
      rawDb as never,
      makeCachePassThrough(),
    );

    await service.getProjectAnalytics("org-1", 7, { ownerId: "user-abc" });

    expect(memberFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ columns: { id: true } }),
    );
  });

  it("uses a different cache key for ownerId vs unfiltered so filtered and unfiltered results never share a cached value", async () => {
    const keys: string[] = [];
    const { rawDb: db1 } = makeDb({ memberRow: { id: 42 } });
    const cache = makeCacheCapturing(keys);
    const service = new ProjectsAnalyticsService(db1 as never, cache);

    await service.getProjectAnalytics("org-1", 7, {});
    await service.getProjectAnalytics("org-1", 7, { ownerId: "user-abc" });

    expect(keys.length).toBe(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("uses a different cache key for teamId vs unfiltered so team-scoped results never collide with org-wide results", async () => {
    const keys: string[] = [];
    const { rawDb } = makeDb();
    const cache = makeCacheCapturing(keys);
    const service = new ProjectsAnalyticsService(rawDb as never, cache);

    await service.getProjectAnalytics("org-1", 7, {});
    await service.getProjectAnalytics("org-1", 7, { teamId: 5 });

    expect(keys.length).toBe(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("uses a different cache key for each range value so 7d and 30d results never alias each other", async () => {
    const keys: string[] = [];
    const { rawDb } = makeDb();
    const cache = makeCacheCapturing(keys);
    const service = new ProjectsAnalyticsService(rawDb as never, cache);

    await service.getProjectAnalytics("org-1", 7, { range: "7d" });
    await service.getProjectAnalytics("org-1", 7, { range: "30d" });
    await service.getProjectAnalytics("org-1", 7, { range: "90d" });

    expect(keys.length).toBe(3);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[1]).not.toBe(keys[2]);
    expect(keys[0]).not.toBe(keys[2]);
  });
});
