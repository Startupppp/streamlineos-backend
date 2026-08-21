import { AccessService } from "../access.service";
import type { Db } from "../../../db/drizzle.module";

const transactionCalls = { count: 0 };

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => {
    transactionCalls.count += 1;
    return fn({});
  },
}));

const ORG = "org-1";
const USER = "user-1";

/**
 * The warm path returns without opening a transaction and the cold path returns
 * from inside one. They are separate pieces of code that must agree exactly: if
 * they drift, a person's access silently depends on whether a cache happened to
 * be warm, which is the worst kind of authorization bug to reproduce.
 */
function buildService(roleGrants: { permissionKey: string; scope: string }[]) {
  const chain = (rows: unknown[]) => {
    const link: Record<string, unknown> = {};
    for (const method of ["from", "innerJoin", "leftJoin", "where", "orderBy"])
      link[method] = () => link;
    link["limit"] = () => Promise.resolve(rows);
    link["then"] = (resolve: (value: unknown) => unknown) => resolve(rows);
    return link;
  };

  const queue: unknown[][] = [
    [{ roleId: 1 }],
    [],
    [],
    [],
    [{ id: 1, slug: "HR_MODULE_MEMBER" }],
    roleGrants.map((g) => ({ roleId: 1, ...g })),
    [],
    [],
  ];
  let cursor = 0;

  const db = {
    query: {
      accessVersions: { findFirst: () => Promise.resolve({ permissionsVersion: 1 }) },
      organizationMembers: {
        findFirst: () =>
          Promise.resolve({ isOwner: false, status: "ACTIVE", id: 42, role: "MEMBER" }),
      },
    },
    select: () => chain(queue[cursor++] ?? []),
  } as unknown as Db;

  const cache = {
    get: () => Promise.resolve(null),
    set: () => Promise.resolve(),
    cached: <T>(_key: string, fetcher: () => Promise<T>) => fetcher(),
    cachedVersioned: <T>(_ns: string, _key: string, fetcher: () => Promise<T>) => fetcher(),
    invalidate: () => Promise.resolve(),
    invalidateNamespace: () => Promise.resolve(),
  };
  const entitlements = { isModuleEnabled: () => Promise.resolve(true) };
  const mfaPolicy = { isSatisfied: () => Promise.resolve(true) };

  return new AccessService(
    db,
    cache as never,
    entitlements as never,
    mfaPolicy as never,
  );
}

beforeEach(() => {
  transactionCalls.count = 0;
});

describe("warm and cold permission resolution agree", () => {
  it("serves the second call from cache without opening another transaction", async () => {
    const service = buildService([
      { permissionKey: "hr:employees:view", scope: "all" },
    ]);

    await service.resolveUserPermissions(ORG, USER);
    const afterCold = transactionCalls.count;
    await service.resolveUserPermissions(ORG, USER);
    const warmCost = transactionCalls.count - afterCold;

    expect(afterCold).toBeGreaterThan(0);
    expect(warmCost).toBe(0);
  });

  it("returns the identical permission set on the second, cache-served call", async () => {
    const service = buildService([
      { permissionKey: "hr:employees:view", scope: "all" },
    ]);

    const cold = await service.resolveUserPermissions(ORG, USER);
    const warm = await service.resolveUserPermissions(ORG, USER);

    expect([...warm.entries()].sort()).toEqual([...cold.entries()].sort());
    expect(warm.get("hr:employees:view")).toBe("all");
  });

  it("carries the universal member grants on both paths, not just the cold one", async () => {
    const service = buildService([]);

    const cold = await service.resolveUserPermissions(ORG, USER);
    const warm = await service.resolveUserPermissions(ORG, USER);

    expect(cold.get("calendar:read")).toBeDefined();
    expect(warm.get("calendar:read")).toBe(cold.get("calendar:read"));
    expect(warm.get("chat:messages:read")).toBe(cold.get("chat:messages:read"));
  });
});
