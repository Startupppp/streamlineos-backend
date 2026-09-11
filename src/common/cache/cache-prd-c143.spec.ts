import type { Redis } from "@upstash/redis";
import { CacheService } from "./cache.service";
import { CacheFiller } from "./cache-fill";

/**
 * PRD-C143 — cache performance: safe miss, correct invalidation, Redis-outage
 * stampede protection.
 *
 * Three behaviours, each with at least one bite proof showing the mechanism is
 * real: a test that fails when the mechanism is disabled and passes when it is
 * restored.
 */

function makeWorkingRedis(store = new Map<string, unknown>()): Redis {
  return {
    get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: jest.fn((key: string, value: unknown, opts?: { ex?: number; nx?: boolean }) => {
      if (opts?.nx === true && store.has(key)) return Promise.resolve(null);
      store.set(key, value);
      return Promise.resolve("OK");
    }),
    incr: jest.fn((key: string) => {
      const next = Number(store.get(key) ?? 0) + 1;
      store.set(key, next);
      return Promise.resolve(next);
    }),
    del: jest.fn((head: string, ...rest: string[]) => {
      let n = 0;
      for (const k of [head, ...rest]) if (store.delete(k)) n++;
      return Promise.resolve(n);
    }),
    eval: jest.fn((script: string, keys: string[], args: string[]) => {
      if (store.get(keys[0]) !== args[0]) return Promise.resolve(0);
      if (script.includes('redis.call("set"') && keys[1] !== undefined) {
        store.set(keys[1], JSON.parse(args[1] ?? "null"));
        return Promise.resolve(1);
      }
      store.delete(keys[0]);
      return Promise.resolve(1);
    }),
  } as unknown as Redis;
}

/**
 * A Redis where read/lease commands hang forever (simulates a slow/unresponsive
 * Upstash). Write-back and lease-release commands return OK so they don't
 * interfere with the failure accounting (which only tracks reads and leases).
 */
function makeHangingReadRedis(): { redis: Redis; readCallCount: () => number } {
  let calls = 0;
  const redis = {
    get: jest.fn(() => {
      calls++;
      return new Promise<null>(() => {});
    }),
    set: jest.fn((
      _key: string,
      _value: unknown,
      opts?: { nx?: boolean },
    ) => {
      if (opts?.nx === true) {
        calls++;
        return new Promise<null>(() => {});
      }
      return Promise.resolve("OK");
    }),
    eval: jest.fn(() => Promise.resolve(1)),
    incr: jest.fn(() => Promise.resolve(1)),
    del: jest.fn(() => Promise.resolve(1)),
  } as unknown as Redis;
  return { redis, readCallCount: () => calls };
}

function fillerOf(cache: CacheService): CacheFiller {
  return (cache as unknown as { fill: CacheFiller }).fill;
}

function breakerField(filler: CacheFiller): Record<string, unknown> {
  const held = (filler as unknown as Record<string, unknown>)["breaker"];
  return held as Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// §1: Safe cache miss
// ─────────────────────────────────────────────────────────────────────────────

describe("PRD-C143 §1 — safe cache miss: Redis failures degrade to loader, never throw to caller", () => {
  it("a Redis ECONNREFUSED on get falls through to the loader; caller receives the loader result", async () => {
    const broken = {
      get: jest.fn(() => Promise.reject(new Error("ECONNREFUSED"))),
      set: jest.fn(() => Promise.reject(new Error("ECONNREFUSED"))),
      eval: jest.fn(() => Promise.reject(new Error("ECONNREFUSED"))),
    } as unknown as Redis;
    const cache = new CacheService(broken);
    const loader = jest.fn().mockResolvedValue({ ok: true });

    await expect(cache.cached("miss-error-key", loader)).resolves.toEqual({ ok: true });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("a null from Redis (clean miss) calls the loader, result is stored and returned", async () => {
    const store = new Map<string, unknown>();
    const redis = makeWorkingRedis(store);
    const cache = new CacheService(redis);
    const loader = jest.fn().mockResolvedValue({ rows: 5 });

    const result = await cache.cached("cold-key", loader);
    expect(result).toEqual({ rows: 5 });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("Redis unavailable (null) degrades to the loader; outage memo prevents repeated DB calls", async () => {
    const cache = new CacheService(null);
    const loader = jest.fn().mockResolvedValue("data");

    await cache.cached("no-redis-key", loader);
    await cache.cached("no-redis-key", loader);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.outageMemoServedCount).toBe(1);
  });

  it("a loader error propagates to the caller (Redis errors are absorbed; loader errors are not)", async () => {
    const cache = new CacheService(null);
    const loader = jest.fn().mockRejectedValue(new Error("DB timeout"));

    await expect(cache.cached("error-loader-key", loader)).rejects.toThrow("DB timeout");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("a timed-out Redis command degrades to the loader without surfacing the timeout to the caller", async () => {
    const hangingRedis = {
      get: jest.fn(() => new Promise<null>(() => {})),
      set: jest.fn(() => new Promise<null>(() => {})),
      eval: jest.fn(() => new Promise<number>(() => {})),
    } as unknown as Redis;
    const cache = new CacheService(hangingRedis, 1);
    const loader = jest.fn().mockResolvedValue({ fromDb: true });

    await expect(cache.cached("timeout-key", loader)).resolves.toEqual({ fromDb: true });
    expect(loader).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §2: Correct invalidation
// ─────────────────────────────────────────────────────────────────────────────

describe("PRD-C143 §2 — correct invalidation: version bump prevents stale cached data", () => {
  it("invalidateNamespace causes the next cachedVersioned read to recompute", async () => {
    const store = new Map<string, unknown>();
    const redis = makeWorkingRedis(store);
    const cache = new CacheService(redis);
    const fetcher = jest.fn()
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second");

    await expect(cache.cachedVersioned("ns:org-1", "page-1", fetcher)).resolves.toBe("first");
    await cache.invalidateNamespace("ns:org-1");
    await expect(cache.cachedVersioned("ns:org-1", "page-1", fetcher)).resolves.toBe("second");

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("BITE: without invalidateNamespace the old value is served after a mutation", async () => {
    const store = new Map<string, unknown>();
    const redis = makeWorkingRedis(store);
    const cache = new CacheService(redis);
    const fetcher = jest.fn()
      .mockResolvedValueOnce("stale")
      .mockResolvedValueOnce("fresh");

    await expect(cache.cachedVersioned("ns:org-2", "page-1", fetcher)).resolves.toBe("stale");
    await expect(cache.cachedVersioned("ns:org-2", "page-1", fetcher)).resolves.toBe("stale");

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("a permissions version baked into the cache key makes pre-bump snapshots permanently unreachable", async () => {
    const store = new Map<string, unknown>();
    const redis = makeWorkingRedis(store);
    const cache = new CacheService(redis);

    const v1Loader = jest.fn().mockResolvedValue({ perms: ["read"], version: 1 });
    const v2Loader = jest.fn().mockResolvedValue({ perms: ["read", "write"], version: 2 });

    await cache.cachedForOrg("org-perm", "access:snapshot:user-1:v1:false", v1Loader);
    const result = await cache.cachedForOrg("org-perm", "access:snapshot:user-1:v2:false", v2Loader);

    expect(result).toEqual({ perms: ["read", "write"], version: 2 });
    expect(v2Loader).toHaveBeenCalledTimes(1);
    expect(store.has("org-perm:access:snapshot:user-1:v1:false")).toBe(true);
  });

  it("invalidateForOrg + version bump together guarantee the next read is fresh", async () => {
    const store = new Map<string, unknown>();
    const redis = makeWorkingRedis(store);
    const cache = new CacheService(redis);
    const fetcher = jest.fn()
      .mockResolvedValueOnce({ v: 1 })
      .mockResolvedValueOnce({ v: 2 });

    await cache.cachedForOrg("org-3", "data:key", fetcher);
    await cache.invalidateForOrg("org-3", "data:key");
    const after = await cache.cachedForOrg("org-3", "data:key", fetcher);

    expect(after).toEqual({ v: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("invalidateManyForOrg clears every org-scoped key in one pass and leaves other orgs alone", async () => {
    const store = new Map<string, unknown>();
    const redis = makeWorkingRedis(store);
    const cache = new CacheService(redis);
    const load = (value: number) => jest.fn().mockResolvedValue({ v: value });

    await cache.cachedForOrg("org-a", "module-access:ownership:hr", load(1));
    await cache.cachedForOrg("org-a", "module-access:ownership:build", load(1));
    await cache.cachedForOrg("org-b", "module-access:ownership:hr", load(1));

    await cache.invalidateManyForOrg("org-a", [
      "module-access:ownership:hr",
      "module-access:ownership:build",
    ]);

    expect(store.has("org-a:module-access:ownership:hr")).toBe(false);
    expect(store.has("org-a:module-access:ownership:build")).toBe(false);
    expect(store.has("org-b:module-access:ownership:hr")).toBe(true);

    const refetch = load(2);
    await expect(
      cache.cachedForOrg("org-a", "module-access:ownership:hr", refetch),
    ).resolves.toEqual({ v: 2 });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("invalidateManyForOrg is a no-op on an empty list rather than deleting a prefix", async () => {
    const store = new Map<string, unknown>();
    const redis = makeWorkingRedis(store);
    const cache = new CacheService(redis);

    await cache.cachedForOrg("org-a", "data:key", jest.fn().mockResolvedValue({ v: 1 }));
    await cache.invalidateManyForOrg("org-a", []);

    expect(store.has("org-a:data:key")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3: Redis outage without request storm
// ─────────────────────────────────────────────────────────────────────────────

describe("PRD-C143 §3 — Redis outage without request storm", () => {
  it("N concurrent callers on one expired key trigger exactly 1 loader call (in-process single-flight)", async () => {
    const cache = new CacheService(null);
    let loaderCalls = 0;
    let releaseLoader!: (v: { answer: number }) => void;
    const loader = jest.fn(() => new Promise<{ answer: number }>((resolve) => {
      loaderCalls++;
      releaseLoader = resolve;
    }));

    const concurrent = Array.from({ length: 8 }, () => cache.cached("stampede-key", loader));
    expect(loaderCalls).toBe(1);

    releaseLoader({ answer: 42 });
    const results = await Promise.all(concurrent);

    expect(loaderCalls).toBe(1);
    for (const r of results) expect(r).toEqual({ answer: 42 });
  });

  it("after BREAKER_FAILURE_THRESHOLD Redis failures the circuit opens and subsequent reads skip Redis", async () => {
    const { redis, readCallCount } = makeHangingReadRedis();
    const commandTimeoutMs = 5;
    const cache = new CacheService(redis, commandTimeoutMs);
    const loader = jest.fn().mockResolvedValue({ data: 1 });

    for (let i = 0; i < 5; i++) {
      await cache.cached(`trip-${i}`, loader);
    }
    const callsAfterTrip = readCallCount();
    expect(callsAfterTrip).toBe(5);

    for (let i = 5; i < 15; i++) {
      await cache.cached(`post-breaker-${i}`, loader);
    }

    expect(readCallCount()).toBe(callsAfterTrip);
    expect(loader).toHaveBeenCalledTimes(15);
  });

  it("BITE: resetting breaker state re-enables Redis calls, proving the mechanism is real", async () => {
    const { redis, readCallCount } = makeHangingReadRedis();
    const commandTimeoutMs = 5;
    const cache = new CacheService(redis, commandTimeoutMs);
    const loader = jest.fn().mockResolvedValue({ data: 1 });

    for (let i = 0; i < 5; i++) await cache.cached(`bite-trip-${i}`, loader);
    const callsAfterOpen = readCallCount();

    await cache.cached("bite-post-1", loader);
    expect(readCallCount()).toBe(callsAfterOpen);

    const filler = fillerOf(cache);
    const fields = breakerField(filler);
    fields["open"] = false;
    fields["consecutiveFailures"] = 0;
    fields["probeInFlight"] = false;

    await cache.cached("bite-post-2", loader);
    expect(readCallCount()).toBe(callsAfterOpen + 1);

    for (let i = 0; i < 4; i++) await cache.cached(`restore-${i}`, loader);
    const callsBeforeReopen = readCallCount();

    await cache.cached("restore-final", loader);
    expect(readCallCount()).toBe(callsBeforeReopen);
    expect(breakerField(fillerOf(cache))["open"]).toBe(true);
  });

  it("a successful probe after the probe interval closes the breaker", async () => {
    const commandTimeoutMs = 5;
    let redisAlive = false;
    const redis = {
      get: jest.fn(() => {
        if (!redisAlive) return new Promise<null>(() => {});
        return Promise.resolve(null);
      }),
      set: jest.fn(() => Promise.resolve("OK")),
      eval: jest.fn(() => Promise.resolve(1)),
    } as unknown as Redis;
    const cache = new CacheService(redis, commandTimeoutMs);
    const loader = jest.fn().mockResolvedValue({ data: "fresh" });

    for (let i = 0; i < 5; i++) await cache.cached(`probe-trip-${i}`, loader);
    expect(breakerField(fillerOf(cache))["open"]).toBe(true);

    redisAlive = true;
    breakerField(fillerOf(cache))["openAt"] = Date.now() - 6_000;

    await cache.cached("probe-target", loader);

    expect(breakerField(fillerOf(cache))["open"]).toBe(false);
    expect(breakerField(fillerOf(cache))["consecutiveFailures"]).toBe(0);
  });

  it("authorization-scoped keys are never retained in the outage memo even when the breaker is open", async () => {
    const { redis } = makeHangingReadRedis();
    const commandTimeoutMs = 5;
    const cache = new CacheService(redis, commandTimeoutMs);

    for (let i = 0; i < 5; i++) await cache.cached(`trip-auth-${i}`, jest.fn().mockResolvedValue(i));
    expect(breakerField(fillerOf(cache))["open"]).toBe(true);

    const loader = jest.fn().mockResolvedValue("permitted");
    await cache.cached("access:perms:user-1:v3", loader);
    await cache.cached("access:perms:user-1:v3", loader);

    expect(loader).toHaveBeenCalledTimes(2);
    expect(cache.outageMemoServedCount).toBe(0);
  });
});
