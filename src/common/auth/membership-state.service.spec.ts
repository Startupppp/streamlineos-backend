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

interface MembershipRow {
  membershipId: number;
  status: string;
  isOwner: boolean;
  role: string;
  userIsActive: boolean;
  userDeletedAt: Date | null;
  orgStatus: string;
  orgDeletedAt: Date | null;
}

const LIVE_ROW: MembershipRow = {
  membershipId: 11,
  status: "ACTIVE",
  isOwner: false,
  role: "MEMBER",
  userIsActive: true,
  userDeletedAt: null,
  orgStatus: "ACTIVE",
  orgDeletedAt: null,
};

function buildDbReturning(rows: MembershipRow[]): Db {
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "innerJoin", "where", "orderBy"])
    chain[method] = () => chain;
  chain["limit"] = () => Promise.resolve(rows);
  const tx = { execute: async () => undefined, select: () => chain };
  return {
    transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    execute: async () => undefined,
  } as unknown as Db;
}

async function resolveWithRow(partial: Partial<MembershipRow>) {
  const { cache } = buildCache();
  const service = new MembershipStateService(
    buildDbReturning([{ ...LIVE_ROW, ...partial }]),
    cache,
  );
  return service.resolve(USER, ORG_A);
}

describe("MembershipStateService is the one definition of a live membership", () => {
  it("reports an active member of a live organization as active", async () => {
    const state = await resolveWithRow({});
    expect(state).toEqual({
      active: true,
      isOwner: false,
      role: "MEMBER",
      membershipId: 11,
    });
  });

  it.each([
    ["a suspended membership", { status: "SUSPENDED" }],
    ["a membership that has left", { status: "LEFT" }],
    ["an invited-but-not-active membership", { status: "INVITED" }],
    ["a deactivated user account", { userIsActive: false }],
    ["a soft-deleted user account", { userDeletedAt: new Date() }],
    ["an organization that is not active", { orgStatus: "SUSPENDED" }],
    ["a soft-deleted organization", { orgDeletedAt: new Date() }],
  ] as const)("denies %s", async (_label, partial) => {
    const state = await resolveWithRow(partial);
    expect(state.active).toBe(false);
  });

  it("denies an owner whose membership is suspended, owner flag notwithstanding", async () => {
    const state = await resolveWithRow({ status: "SUSPENDED", isOwner: true });
    expect(state.active).toBe(false);
    expect(state.isOwner).toBe(true);
  });

  it("denies when there is no membership row at all", async () => {
    const { cache } = buildCache();
    const service = new MembershipStateService(buildDbReturning([]), cache);

    await expect(service.resolve(USER, ORG_B)).resolves.toEqual({
      active: false,
      isOwner: false,
      role: "",
      membershipId: null,
    });
  });

  // Was "denies, rather than throws". Swallowing the read into UNKNOWN cached "not a member" for
  // the whole TTL, so one transient database error 403'd every route for the owner until it expired.
  // Propagating is the fail-closed answer that does not outlive the failure: the request errors and
  // nothing is written, so the next one asks again.
  it("propagates a failed read instead of caching a denial", async () => {
    const { cache, store } = buildCache();
    const db = {
      transaction: async () => {
        throw new Error("connection reset");
      },
      execute: async () => undefined,
    } as unknown as Db;

    await expect(
      new MembershipStateService(db, cache).resolve(USER, ORG_A),
    ).rejects.toThrow("connection reset");

    expect(store.size).toBe(0);
  });

  it("still denies, without throwing, when the read succeeds and finds nothing", async () => {
    const { cache } = buildCache();

    await expect(
      new MembershipStateService(buildDbReturning([]), cache).resolve(USER, ORG_A),
    ).resolves.toEqual({
      active: false,
      isOwner: false,
      role: "",
      membershipId: null,
    });
  });
});
