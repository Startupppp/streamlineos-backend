import type { Redis } from "@upstash/redis";
import {
  AccessVersionChannel,
  accessVersionChannel,
  type AccessVersionStore,
} from "../rbac/access-version-channel";
import { bumpPermissionsVersion, type DbOrTx } from "../rbac/access-invalidate";
import { CACHE_KEYS } from "./cache-keys";
import { CacheService } from "./cache.service";
import { InMemoryRedis } from "./in-memory-redis.test-double";

function makeVersionStore(redis: InMemoryRedis): AccessVersionStore {
  return {
    get: (orgId) => redis.get<number>(`av:${orgId}`),
    set: (orgId, version) => redis.set(`av:${orgId}`, version).then((): void => {}),
    clear: (orgId) => redis.del(`av:${orgId}`).then((): void => {}),
  };
}

function makeDelDeafRedis(): Redis {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string): Promise<T | null> =>
      Promise.resolve((store.get(key) as T | undefined) ?? null),
    set: (key: string, value: unknown, opts?: { ex?: number; nx?: boolean }): Promise<string | null> => {
      if (opts?.nx === true && store.has(key)) return Promise.resolve(null);
      store.set(key, value);
      return Promise.resolve("OK");
    },
    incr: (key: string): Promise<number> => {
      const n = Number(store.get(key) ?? 0) + 1;
      store.set(key, n);
      return Promise.resolve(n);
    },
    del: (_key: string): Promise<number> => Promise.resolve(0),
    eval: (_s: string, keys: string[]): Promise<number> => {
      for (const k of keys) store.delete(k);
      return Promise.resolve(1);
    },
  } as unknown as Redis;
}

function makeDeafToDelVersionStore(): AccessVersionStore {
  const entries = new Map<string, number>();
  return {
    get: (orgId) => Promise.resolve(entries.get(orgId) ?? null),
    set: (orgId, version) => {
      entries.set(orgId, version);
      return Promise.resolve();
    },
    clear: (_orgId) => Promise.resolve(),
  };
}

function makeMockTx(rows: Map<string, number>) {
  const pending = new Map<string, number>();
  const tx = {
    insert: () => ({
      values: (v: { orgId: string }) => ({
        onConflictDoUpdate: async (_opts: unknown) => {
          const cur = rows.get(v.orgId) ?? 1;
          pending.set(v.orgId, cur + 1);
        },
      }),
    }),
  } as unknown as DbOrTx;
  const commit = (): void => { for (const [k, v] of pending) rows.set(k, v); pending.clear(); };
  const rollback = (): void => { pending.clear(); };
  return { tx, commit, rollback };
}

describe("cross-instance cache invalidation", () => {
  afterEach(() => accessVersionChannel.useStore(null));

  it("P1 mutation: A invalidates a key; B misses on next read", async () => {
    const redis = new InMemoryRedis();
    const instanceA = new CacheService(redis as unknown as Redis);
    const instanceB = new CacheService(redis as unknown as Redis);

    await instanceA.cached("p1:key", () => Promise.resolve("stale"), 300);
    await instanceA.invalidate("p1:key");

    const fetcher = jest.fn().mockResolvedValueOnce("fresh");
    const result = await instanceB.cached("p1:key", fetcher, 300);

    expect(result).toBe("fresh");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("P1 bite: del no-op means B serves stale value", async () => {
    const redis = makeDelDeafRedis();
    const instanceA = new CacheService(redis);
    const instanceB = new CacheService(redis);

    await instanceA.cached("p1:key", () => Promise.resolve("stale"), 300);
    await instanceA.invalidate("p1:key");

    const fetcher = jest.fn().mockResolvedValue("fresh");
    const result = await instanceB.cached("p1:key", fetcher, 300);

    expect(result).toBe("stale");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("P2 membership: removed member's session invalidated; B misses", async () => {
    const redis = new InMemoryRedis();
    const instanceA = new CacheService(redis as unknown as Redis);
    const instanceB = new CacheService(redis as unknown as Redis);
    const key = CACHE_KEYS.userSession("user-removed");

    await instanceA.cached(key, () => Promise.resolve({ role: "MEMBER" }), 300);
    await instanceA.invalidate(key);

    const fetcher = jest.fn().mockResolvedValueOnce({ role: "removed" });
    const result = await instanceB.cached(key, fetcher, 300);

    expect(result).toEqual({ role: "removed" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("P2 bite: without session del B serves stale grant", async () => {
    const redis = makeDelDeafRedis();
    const instanceA = new CacheService(redis);
    const instanceB = new CacheService(redis);
    const key = CACHE_KEYS.userSession("user-removed");

    await instanceA.cached(key, () => Promise.resolve({ role: "MEMBER" }), 300);
    await instanceA.invalidate(key);

    const fetcher = jest.fn().mockResolvedValue({ role: "removed" });
    const result = await instanceB.cached(key, fetcher, 300);

    expect(result).toEqual({ role: "MEMBER" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("P3a role change: version bump propagates from A to B via shared store", async () => {
    const redis = new InMemoryRedis();
    const store = makeVersionStore(redis);
    accessVersionChannel.useStore(store);
    const instanceB = new AccessVersionChannel();
    instanceB.useStore(store);

    const rows = new Map<string, number>([["org-1", 7]]);
    const { tx, commit } = makeMockTx(rows);

    await bumpPermissionsVersion(tx, "org-1");
    commit();

    const version = await instanceB.read("org-1", () => Promise.resolve(rows.get("org-1") ?? 1));
    expect(version).toBe(8);
  });

  it("P3b role change: rolled-back tx does not advance B-observed version", async () => {
    const redis = new InMemoryRedis();
    const store = makeVersionStore(redis);
    accessVersionChannel.useStore(store);
    const instanceB = new AccessVersionChannel();
    instanceB.useStore(store);

    const rows = new Map<string, number>([["org-1", 5]]);
    const { tx, rollback } = makeMockTx(rows);

    await bumpPermissionsVersion(tx, "org-1");
    rollback();

    const version = await instanceB.read("org-1", () => Promise.resolve(rows.get("org-1") ?? 1));
    expect(version).toBe(5);
  });

  it("P3 bite: if channel store clear is skipped B serves stale version", async () => {
    const store = makeDeafToDelVersionStore();
    const instanceB = new AccessVersionChannel();
    instanceB.useStore(store);

    await instanceB.read("org-1", () => Promise.resolve(3));

    const rows = new Map<string, number>([["org-1", 4]]);
    const version = await instanceB.read("org-1", () => Promise.resolve(rows.get("org-1") ?? 1));
    expect(version).toBe(3);
  });

  it("P4 entitlement: setModuleEnabled busts all active members' sessions", async () => {
    const redis = new InMemoryRedis();
    const instanceA = new CacheService(redis as unknown as Redis);
    const instanceB = new CacheService(redis as unknown as Redis);
    const members = ["u-a", "u-b", "u-c"];

    for (const m of members)
      await instanceA.cached(CACHE_KEYS.userSession(m), () => Promise.resolve({ org: "org-1" }), 300);

    await Promise.all(members.map((m) => instanceA.invalidate(CACHE_KEYS.userSession(m))));

    const refreshed: string[] = [];
    for (const m of members) {
      const fetcher = jest.fn().mockResolvedValueOnce({ org: "org-1", fresh: true });
      await instanceB.cached(CACHE_KEYS.userSession(m), fetcher, 300);
      if (fetcher.mock.calls.length > 0) refreshed.push(m);
    }

    expect(refreshed).toEqual(members);
  });

  it("P4 bite: actor-only invalidation leaves non-actors with stale sessions on B", async () => {
    const redis = new InMemoryRedis();
    const instanceA = new CacheService(redis as unknown as Redis);
    const instanceB = new CacheService(redis as unknown as Redis);
    const members = ["actor", "user-b", "user-c"];

    for (const m of members)
      await instanceA.cached(CACHE_KEYS.userSession(m), () => Promise.resolve({ org: "org-1" }), 300);

    await instanceA.invalidate(CACHE_KEYS.userSession("actor"));

    const actorFetcher = jest.fn().mockResolvedValue({ fresh: true });
    const actorResult = await instanceB.cached(CACHE_KEYS.userSession("actor"), actorFetcher, 300);
    expect(actorResult).toEqual({ fresh: true });

    const bFetcher = jest.fn().mockResolvedValue({ fresh: true });
    const bResult = await instanceB.cached(CACHE_KEYS.userSession("user-b"), bFetcher, 300);
    expect(bResult).toEqual({ org: "org-1" });
    expect(bFetcher).not.toHaveBeenCalled();
  });

  it("P5 org switch: switching user's session invalidated; B misses", async () => {
    const redis = new InMemoryRedis();
    const instanceA = new CacheService(redis as unknown as Redis);
    const instanceB = new CacheService(redis as unknown as Redis);
    const key = CACHE_KEYS.userSession("user-switch");

    await instanceA.cached(key, () => Promise.resolve({ orgId: "org-old" }), 300);
    await instanceA.invalidate(key);

    const fetcher = jest.fn().mockResolvedValueOnce({ orgId: "org-new" });
    const result = await instanceB.cached(key, fetcher, 300);

    expect(result).toEqual({ orgId: "org-new" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("P6 placement: hierarchy mutation invalidates namespace; B misses", async () => {
    const redis = new InMemoryRedis();
    const instanceA = new CacheService(redis as unknown as Redis);
    const instanceB = new CacheService(redis as unknown as Redis);

    const stale = jest.fn().mockResolvedValueOnce({ nodes: ["root"] });
    await instanceA.cachedVersionedForOrg("org-1", "org:hierarchy", "overview:all", stale, 300);

    await instanceA.invalidateNamespaceForOrg("org-1", "org:hierarchy");

    const fresh = jest.fn().mockResolvedValueOnce({ nodes: ["root", "branch-a"] });
    const result = await instanceB.cachedVersionedForOrg("org-1", "org:hierarchy", "overview:all", fresh, 300);

    expect(result).toEqual({ nodes: ["root", "branch-a"] });
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("P6 bite: deaf incr leaves namespace version stuck; B serves stale hierarchy", async () => {
    const redis = new InMemoryRedis(true);
    const instanceA = new CacheService(redis as unknown as Redis);
    const instanceB = new CacheService(redis as unknown as Redis);

    const stale = jest.fn().mockResolvedValueOnce({ nodes: ["root"] });
    await instanceA.cachedVersionedForOrg("org-1", "org:hierarchy", "overview:all", stale, 300);

    await instanceA.invalidateNamespaceForOrg("org-1", "org:hierarchy");

    const fresh = jest.fn().mockResolvedValue({ nodes: ["root", "branch-a"] });
    const result = await instanceB.cachedVersionedForOrg("org-1", "org:hierarchy", "overview:all", fresh, 300);

    expect(result).toEqual({ nodes: ["root"] });
    expect(fresh).not.toHaveBeenCalled();
  });

  it("P7 session revocation: tombstone written by A is visible to B", async () => {
    const redis = new InMemoryRedis();
    const instanceA = new CacheService(redis as unknown as Redis);
    const instanceB = new CacheService(redis as unknown as Redis);

    await instanceA.set("revoked:session:sess-abc", true, 86400);

    const tombstone = await instanceB.get<boolean>("revoked:session:sess-abc");
    expect(tombstone).toBe(true);
  });

  it("P7 bite: without tombstone B reads null and does not deny access", async () => {
    const redis = new InMemoryRedis();
    const instanceB = new CacheService(redis as unknown as Redis);

    const tombstone = await instanceB.get<boolean>("revoked:session:sess-abc");
    expect(tombstone).toBeNull();
  });

  it("stampede: concurrent reads across two instances run the fetcher exactly once", async () => {
    const redis = new InMemoryRedis();
    const instanceA = new CacheService(redis as unknown as Redis);
    const instanceB = new CacheService(redis as unknown as Redis);
    let calls = 0;
    const fetcher = async (): Promise<{ answer: number }> => {
      calls += 1;
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      return { answer: 42 };
    };

    const [a, b] = await Promise.all([
      instanceA.cached("shared:cold", fetcher, 300),
      instanceB.cached("shared:cold", fetcher, 300),
    ]);

    expect(calls).toBe(1);
    expect(a).toEqual({ answer: 42 });
    expect(b).toEqual({ answer: 42 });
  });

  it("stampede bite: sequential start means both calls hit cold cache independently", async () => {
    const redis = new InMemoryRedis();
    const instanceA = new CacheService(redis as unknown as Redis);
    const instanceB = new CacheService(redis as unknown as Redis);
    let calls = 0;
    const fetcher = async (): Promise<{ n: number }> => {
      calls += 1;
      return { n: calls };
    };

    const a = await instanceA.cached("seq:key", fetcher, 300);
    const b = await instanceB.cached("seq:key", fetcher, 300);

    expect(calls).toBe(1);
    expect(a).toEqual({ n: 1 });
    expect(b).toEqual({ n: 1 });
  });
});
