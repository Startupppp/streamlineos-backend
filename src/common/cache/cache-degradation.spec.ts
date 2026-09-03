import type { Redis } from "@upstash/redis";
import { CacheService } from "./cache.service";
import { CACHE_KEYS } from "./cache-keys";

/**
 * Ticket 23 box 4 — "a miss or a cache outage degrades safely without a request
 * storm", and the two clauses of §6 line 145 that did not hold.
 *
 * These are written against Redis being *unavailable*, not merely cold: a cold
 * cache exercises the fill path, an outage exercises four different degraded
 * returns, and only the second is the clause under test.
 */

interface FakeRedisStats {
  gets: number;
  sets: number;
}

function fakeRedis(store: Map<string, unknown>, stats: FakeRedisStats): Redis {
  return {
    get: jest.fn(async (key: string) => {
      stats.gets += 1;
      return store.get(key) ?? null;
    }),
    set: jest.fn(async (key: string, value: unknown, options?: { nx?: boolean; ex?: number }) => {
      if (options?.nx && store.has(key)) return null;
      stats.sets += 1;
      store.set(key, value);
      return "OK";
    }),
    incr: jest.fn(async (key: string) => {
      const next = Number(store.get(key) ?? 0) + 1;
      store.set(key, next);
      return next;
    }),
    eval: jest.fn(async (_script: string, keys: string[], args: string[]) => {
      if (store.get(keys[0] ?? "") !== args[0]) return 0;
      store.delete(keys[0] ?? "");
      return 1;
    }),
    del: jest.fn(async () => 1),
  } as unknown as Redis;
}

function brokenRedis(): Redis {
  const explode = jest.fn(() => Promise.reject(new Error("ECONNREFUSED")));
  return {
    get: explode,
    set: explode,
    incr: explode,
    eval: explode,
    del: explode,
  } as unknown as Redis;
}

describe("cache outage degradation", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("serialized traffic during an outage does not hit the source once per request", async () => {
    const cache = new CacheService(brokenRedis());
    const fetcher = jest.fn().mockResolvedValue({ rows: 3 });

    for (let i = 0; i < 20; i++)
      await expect(cache.cached("hot-key", fetcher)).resolves.toEqual({ rows: 3 });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.outageMemoServedCount).toBe(19);
  });

  it("degrades the same way when Redis was never configured", async () => {
    const cache = new CacheService(null);
    const fetcher = jest.fn().mockResolvedValue("value");

    await cache.cached("unconfigured-key", fetcher);
    await cache.cached("unconfigured-key", fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not memoise beyond the degraded window", async () => {
    const cache = new CacheService(brokenRedis());
    const fetcher = jest.fn().mockResolvedValue("value");
    const base = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(base);

    await cache.cached("expiring-key", fetcher);
    clock.mockReturnValue(base + 999);
    await cache.cached("expiring-key", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    clock.mockReturnValue(base + 1_001);
    await cache.cached("expiring-key", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("never memoises a null, so a denial cannot outlive the grant that ends it", async () => {
    const cache = new CacheService(brokenRedis());
    const fetcher = jest
      .fn<Promise<{ ok: true } | null>, []>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ ok: true });

    await expect(cache.cached("authz-key", fetcher)).resolves.toBeNull();
    await expect(cache.cached("authz-key", fetcher)).resolves.toEqual({ ok: true });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cache.outageMemoServedCount).toBe(0);
  });

  it("an explicit invalidation drops the degraded memo at once", async () => {
    const cache = new CacheService(brokenRedis());
    const fetcher = jest.fn().mockResolvedValueOnce("before").mockResolvedValue("after");

    await expect(cache.cached("invalidated-key", fetcher)).resolves.toBe("before");
    await cache.invalidate("invalidated-key");
    await expect(cache.cached("invalidated-key", fetcher)).resolves.toBe("after");

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not arm the memo while Redis is healthy, so invalidation still bites immediately", async () => {
    const store = new Map<string, unknown>();
    const stats: FakeRedisStats = { gets: 0, sets: 0 };
    const cache = new CacheService(fakeRedis(store, stats));
    const fetcher = jest.fn().mockResolvedValueOnce("first").mockResolvedValue("second");

    await expect(cache.cached("healthy-key", fetcher)).resolves.toBe("first");
    store.clear();
    await expect(cache.cached("healthy-key", fetcher)).resolves.toBe("second");

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cache.outageMemoServedCount).toBe(0);
  });
});

describe("distributed fill lease", () => {
  it("a waiter stops as soon as the lease is gone rather than polling out the window", async () => {
    const store = new Map<string, unknown>();
    const stats: FakeRedisStats = { gets: 0, sets: 0 };
    const redis = fakeRedis(store, stats);
    const leader = new CacheService(redis);
    const follower = new CacheService(redis);

    const leaderFetch = jest.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return null;
    });
    const followerFetch = jest.fn().mockResolvedValue({ recomputed: true });

    const leaderCall = leader.cached("null-valued-key", leaderFetch);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const getsBeforeWait = stats.gets;

    const startedAt = Date.now();
    const [, followerResult] = await Promise.all([
      leaderCall,
      follower.cached("null-valued-key", followerFetch),
    ]);
    const elapsedMs = Date.now() - startedAt;

    expect(followerResult).toEqual({ recomputed: true });
    expect(followerFetch).toHaveBeenCalledTimes(1);
    expect(elapsedMs).toBeLessThan(1_000);
    expect(stats.gets - getsBeforeWait).toBeLessThan(12);
    expect(store.has("null-valued-key")).toBe(false);
  });

  it("still coalesces across instances when the value is not null", async () => {
    const store = new Map<string, unknown>();
    const stats: FakeRedisStats = { gets: 0, sets: 0 };
    const redis = fakeRedis(store, stats);
    const leader = new CacheService(redis);
    const follower = new CacheService(redis);

    const fetcher = jest.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 75));
      return { ok: true };
    });

    await expect(
      Promise.all([
        leader.cached("shared-key", fetcher),
        follower.cached("shared-key", fetcher),
      ]),
    ).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("TTL jitter reaches every fill path", () => {
  function captureTtls(): { ttls: number[]; redis: Redis } {
    const ttls: number[] = [];
    const redis = {
      get: jest.fn(async () => null),
      set: jest.fn(async (_key: string, _value: unknown, options?: { nx?: boolean; ex?: number }) => {
        if (options?.ex !== undefined && !options.nx) ttls.push(options.ex);
        return "OK";
      }),
      incr: jest.fn(async () => 1),
      eval: jest.fn(async () => 1),
    } as unknown as Redis;
    return { ttls, redis };
  }

  it("cached — 88 call sites that expired in lockstep now spread", async () => {
    const { ttls, redis } = captureTtls();
    const cache = new CacheService(redis);
    const base = 300;

    await Promise.all(
      Array.from({ length: 40 }, (_unused, i) =>
        cache.cached(`report:${String(i)}`, async () => ({ i }), base),
      ),
    );

    expect(ttls).toHaveLength(40);
    for (const ttl of ttls) {
      expect(ttl).toBeGreaterThanOrEqual(Math.floor(base * 0.85));
      expect(ttl).toBeLessThanOrEqual(Math.ceil(base * 1.15));
    }
    expect(new Set(ttls).size).toBeGreaterThan(1);
  });

  it("cachedVersioned — the path §6 names as canonical", async () => {
    const { ttls, redis } = captureTtls();
    const cache = new CacheService(redis);
    const base = 600;

    await Promise.all(
      Array.from({ length: 40 }, (_unused, i) =>
        cache.cachedVersioned("contacts:org-1", `page-${String(i)}`, async () => ({ i }), base),
      ),
    );

    expect(ttls).toHaveLength(40);
    for (const ttl of ttls) {
      expect(ttl).toBeGreaterThanOrEqual(Math.floor(base * 0.85));
      expect(ttl).toBeLessThanOrEqual(Math.ceil(base * 1.15));
    }
    expect(new Set(ttls).size).toBeGreaterThan(1);
  });

  it("a caller-declared maxTtl still bounds the jittered TTL", async () => {
    const { ttls, redis } = captureTtls();
    const cache = new CacheService(redis);

    await Promise.all(
      Array.from({ length: 30 }, (_unused, i) =>
        cache.cachedForOrgWith(
          "org-1",
          `bounded:${String(i)}`,
          async () => ({ i }),
          () => 100,
          100,
        ),
      ),
    );

    expect(ttls).toHaveLength(30);
    for (const ttl of ttls) expect(ttl).toBeLessThanOrEqual(100);
    expect(new Set(ttls).size).toBeGreaterThan(1);
  });
});

describe("the outage memo cannot answer an authorization question", () => {
  /**
   * Derived from CACHE_KEYS rather than hand-written, so a renamed key factory
   * that stops matching a marker fails here instead of silently becoming
   * memoisable. Each is checked in both the bare and the tenant-prefixed
   * spelling, because cachedForOrg prepends the org (and a region cell before
   * that) and a prefix test would miss every one.
   */
  const AUTHORIZATION_KEYS: readonly string[] = [
    CACHE_KEYS.userSession("user-1"),
    CACHE_KEYS.membershipAccount("user-1"),
    CACHE_KEYS.accessVersion("org-1"),
    CACHE_KEYS.accessPerms("org-1", "user-1", 3),
    CACHE_KEYS.permissionsMatrix("org-1", 2),
    CACHE_KEYS.mfaOrgPolicy("org-1"),
    CACHE_KEYS.mfaUserTotp("user-1"),
    "access:perms:user-1:v3",
    "revoked:session:sess-1",
  ];

  it.each(AUTHORIZATION_KEYS)("%s is never memoised during an outage", async (key) => {
    for (const spelling of [key, `org-1:${key}`, `cell-eu:org-1:${key}`]) {
      const cache = new CacheService(brokenRedis());
      const fetcher = jest.fn().mockResolvedValue("permitted");

      await cache.cached(spelling, fetcher);
      await cache.cached(spelling, fetcher);

      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(cache.outageMemoServedCount).toBe(0);
    }
  });

  it("an ordinary read is memoised, so the exclusion is not vacuous", async () => {
    const cache = new CacheService(brokenRedis());
    const fetcher = jest.fn().mockResolvedValue("rows");

    await cache.cached(CACHE_KEYS.dashboardStats("org-1"), fetcher);
    await cache.cached(CACHE_KEYS.dashboardStats("org-1"), fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.outageMemoServedCount).toBe(1);
  });
});
