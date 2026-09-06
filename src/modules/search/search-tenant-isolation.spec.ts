jest.mock("../access/authorize", () => ({
  authorize: jest.fn().mockResolvedValue({ allow: false, scope: "none", reason: "FORBIDDEN" }),
}));

import type { Db } from "../../db/drizzle.module";
import { SearchService } from "./search.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

describe("SearchService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  const makeU = (orgId: string): CurrentUserContext =>
    ({ orgId, userId: "user-1" }) as CurrentUserContext;

  function makeDb() {
    return {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue(Object.assign(Promise.resolve([]), {
            limit: jest.fn().mockResolvedValue([]),
          })),
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue(Object.assign(Promise.resolve([]), {
              limit: jest.fn().mockResolvedValue([]),
            })),
          }),
        }),
      })),
      execute: jest.fn().mockResolvedValue([]),
    } as unknown as Db;
  }

  const capturedCacheKeys: string[] = [];

  function makeAccess() {
    return {
      getPermissionsVersion: jest.fn().mockResolvedValue(1),
      getModuleState: jest.fn().mockResolvedValue(undefined),
      buildModuleAvailabilityResolver: jest.fn().mockReturnValue({
        isCoreModule: () => false,
        getModuleMap: async () => ({}),
        getUserDeniedModules: async () => new Set<string>(),
        getPlanLockedModules: async () => [],
      }),
      scopeFor: jest.fn().mockResolvedValue("none"),
    } as never;
  }

  function makeCache() {
    return {
      cached: jest.fn().mockImplementation((key: string, fn: () => unknown) => {
        capturedCacheKeys.push(key);
        return fn();
      }),
    } as never;
  }

  beforeEach(() => {
    capturedCacheKeys.length = 0;
  });

  it("scopes search cache key to the requesting org (tenant isolation)", async () => {
    const svc = new SearchService(makeDb(), makeCache(), makeAccess());

    await svc.search(makeU(ATTACKER), "test query", 10);

    expect(capturedCacheKeys.length).toBeGreaterThan(0);
    const key = capturedCacheKeys[0];
    expect(key).toContain(ATTACKER);
    expect(key).not.toContain(OWNER);
  });

  it("returns empty results for the owning org (same-tenant control)", async () => {
    const svc = new SearchService(makeDb(), makeCache(), makeAccess());

    const result = await svc.search(makeU(OWNER), "test query", 10);

    expect(result).toBeDefined();
    expect(result).toHaveProperty("results");
    expect(Array.isArray(result.results)).toBe(true);
    const key = capturedCacheKeys[0];
    expect(key).toContain(OWNER);
  });
});
