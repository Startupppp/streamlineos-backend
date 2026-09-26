import { ProjectsAnalyticsService } from "./projects-analytics.service";
import { CacheService } from "../../../common/cache/cache.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { Test } from "@nestjs/testing";

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

interface MockDb {
  projects: { findFirst: jest.Mock };
  organizationMembers: { findFirst: jest.Mock };
  projectTeamMembersSelect: jest.Mock;
  execute: jest.Mock;
  select: jest.Mock;
  query: {
    projects: { findFirst: jest.Mock };
    organizationMembers: { findFirst: jest.Mock };
    cycles: { findMany: jest.Mock };
  };
}

function makeDb(): MockDb {
  const projectFindFirst = jest.fn().mockResolvedValue(DUMMY_PROJECT);
  const memberFindFirst = jest.fn().mockResolvedValue(undefined);
  const projectTeamMembersSelect = jest.fn().mockReturnValue(makeChain([]));
  const execute = jest.fn().mockResolvedValue([]);
  const select = jest.fn().mockReturnValue(makeChain([]));

  return {
    projects: { findFirst: projectFindFirst },
    organizationMembers: { findFirst: memberFindFirst },
    projectTeamMembersSelect,
    execute,
    select,
    query: {
      projects: { findFirst: projectFindFirst },
      organizationMembers: { findFirst: memberFindFirst },
      cycles: { findMany: jest.fn().mockResolvedValue([]) },
    },
  };
}

function buildService(db: MockDb): ProjectsAnalyticsService {
  const rawDb = {
    query: {
      projects: { findFirst: db.query.projects.findFirst },
      organizationMembers: { findFirst: db.query.organizationMembers.findFirst },
      cycles: { findMany: db.query.cycles.findMany },
    },
    select: db.select,
    execute: db.execute,
  };

  const cache: Partial<CacheService> = {
    cachedVersioned: (_ns: string, _key: string, fetcher: () => Promise<unknown>) => fetcher(),
  };

  return new ProjectsAnalyticsService(rawDb as never, cache as CacheService);
}

describe("ProjectsAnalyticsService — filter propagation (C5)", () => {
  it("does not query organizationMembers when no ownerId filter is supplied so unfiltered analytics are returned", async () => {
    const db = makeDb();
    const service = buildService(db);

    await service.getProjectAnalytics("org-1", 7, {});

    expect(db.query.organizationMembers.findFirst).not.toHaveBeenCalled();
  });

  it("looks up the organization member when ownerId is supplied so the assignee filter targets that user's membership", async () => {
    const db = makeDb();
    db.query.organizationMembers.findFirst.mockResolvedValue({ id: 42 });
    const service = buildService(db);

    await service.getProjectAnalytics("org-1", 7, { ownerId: "user-abc" });

    expect(db.query.organizationMembers.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.anything(),
        columns: { id: true },
      }),
    );
  });

  it("uses a different cache key for ownerId vs unfiltered so filtered and unfiltered results never share a cached value", async () => {
    const cacheKeys: string[] = [];
    const rawDb = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(DUMMY_PROJECT) },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: 42 }),
        },
        cycles: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn().mockReturnValue(makeChain([])),
      execute: jest.fn().mockResolvedValue([]),
    };

    const cache: Partial<CacheService> = {
      cachedVersioned: (_ns: string, key: string, fetcher: () => Promise<unknown>) => {
        cacheKeys.push(key);
        return fetcher();
      },
    };

    const service = new ProjectsAnalyticsService(rawDb as never, cache as CacheService);

    await service.getProjectAnalytics("org-1", 7, {});
    await service.getProjectAnalytics("org-1", 7, { ownerId: "user-abc" });

    expect(cacheKeys[0]).not.toBe(cacheKeys[1]);
  });

  it("uses a different cache key for teamId vs unfiltered so team-scoped results never collide with org-wide results", async () => {
    const cacheKeys: string[] = [];
    const rawDb = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(DUMMY_PROJECT) },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue(undefined) },
        cycles: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn().mockReturnValue(makeChain([])),
      execute: jest.fn().mockResolvedValue([]),
    };

    const cache: Partial<CacheService> = {
      cachedVersioned: (_ns: string, key: string, fetcher: () => Promise<unknown>) => {
        cacheKeys.push(key);
        return fetcher();
      },
    };

    const service = new ProjectsAnalyticsService(rawDb as never, cache as CacheService);

    await service.getProjectAnalytics("org-1", 7, {});
    await service.getProjectAnalytics("org-1", 7, { teamId: 5 });

    expect(cacheKeys[0]).not.toBe(cacheKeys[1]);
  });

  it("uses a different cache key for each range value so 7d and 30d results never alias each other", async () => {
    const cacheKeys: string[] = [];
    const rawDb = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(DUMMY_PROJECT) },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue(undefined) },
        cycles: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn().mockReturnValue(makeChain([])),
      execute: jest.fn().mockResolvedValue([]),
    };

    const cache: Partial<CacheService> = {
      cachedVersioned: (_ns: string, key: string, fetcher: () => Promise<unknown>) => {
        cacheKeys.push(key);
        return fetcher();
      },
    };

    const service = new ProjectsAnalyticsService(rawDb as never, cache as CacheService);

    await service.getProjectAnalytics("org-1", 7, { range: "7d" });
    await service.getProjectAnalytics("org-1", 7, { range: "30d" });
    await service.getProjectAnalytics("org-1", 7, { range: "90d" });

    expect(cacheKeys[0]).not.toBe(cacheKeys[1]);
    expect(cacheKeys[1]).not.toBe(cacheKeys[2]);
    expect(cacheKeys[0]).not.toBe(cacheKeys[2]);
  });
});
