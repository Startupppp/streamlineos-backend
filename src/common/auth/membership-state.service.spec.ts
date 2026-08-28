import { MembershipStateService } from "./membership-state.service";
import type { Db } from "../../db/drizzle.module";
import type { CacheService } from "../cache/cache.service";

const USER = "user-in-two-orgs";
const ORG_A = "org-a";
const ORG_B = "org-b";

function buildDb(): Db {
  return {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(null),
    execute: () => Promise.resolve(undefined),
  } as unknown as Db;
}

function buildCache(): {
  cache: CacheService;
  keys: string[];
  store: Map<string, unknown>;
} {
  const keys: string[] = [];
  const store = new Map<string, unknown>();
  const cache = {
    cachedVersioned: async <T>(
      namespace: string,
      key: string,
      fetcher: () => Promise<T>,
    ): Promise<T> => {
      const composed = `${namespace}:v1:${key}`;
      keys.push(composed);
      if (store.has(composed)) return store.get(composed) as T;
      const value = await fetcher();
      store.set(composed, value);
      return value;
    },
    get: async () => null,
    set: async () => undefined,
    invalidate: async () => undefined,
    invalidateNamespace: async () => undefined,
  } as unknown as CacheService;
  return { cache, keys, store };
}

describe("MembershipStateService resolves the acting membership per organization", () => {
  it("keys the cache entry by organization, so org A's answer is never served for org B", async () => {
    const { cache, keys, store } = buildCache();
    const db = buildDb();
    const service = new MembershipStateService(db, cache);

    jest
      .spyOn(
        service as unknown as {
          fetchMembershipState: (u: string, o: string) => Promise<unknown>;
        },
        "fetchMembershipState",
      )
      .mockImplementation(async (_userId: string, orgId: string) => ({
        active: true,
        isOwner: orgId === ORG_A,
        role: orgId === ORG_A ? "OWNER" : "MEMBER",
        membershipId: orgId === ORG_A ? 11 : 22,
      }));

    const inOrgA = await service.resolve(USER, ORG_A);
    const inOrgB = await service.resolve(USER, ORG_B);

    expect(inOrgA.membershipId).toBe(11);
    expect(inOrgB.membershipId).toBe(22);
    expect(inOrgA.isOwner).toBe(true);
    expect(inOrgB.isOwner).toBe(false);

    expect(keys).toEqual([
      `membership:status:${USER}:v1:${ORG_A}`,
      `membership:status:${USER}:v1:${ORG_B}`,
    ]);
    expect(store.size).toBe(2);
  });

  it("serves the cached entry for the same organization without refetching", async () => {
    const { cache } = buildCache();
    const db = buildDb();
    const service = new MembershipStateService(db, cache);

    const fetch = jest
      .spyOn(
        service as unknown as {
          fetchMembershipState: (u: string, o: string) => Promise<unknown>;
        },
        "fetchMembershipState",
      )
      .mockResolvedValue({
        active: true,
        isOwner: false,
        role: "MEMBER",
        membershipId: 11,
      });

    await service.resolve(USER, ORG_A);
    await service.resolve(USER, ORG_A);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports no membership id when the person has no row in that organization", async () => {
    const { cache } = buildCache();
    const db = buildDb();
    const service = new MembershipStateService(db, cache);

    jest
      .spyOn(
        service as unknown as {
          fetchMembershipState: (u: string, o: string) => Promise<unknown>;
        },
        "fetchMembershipState",
      )
      .mockResolvedValue({
        active: false,
        isOwner: false,
        role: "",
        membershipId: null,
      });

    const state = await service.resolve(USER, ORG_B);

    expect(state.membershipId).toBeNull();
    expect(state.active).toBe(false);
  });
});
