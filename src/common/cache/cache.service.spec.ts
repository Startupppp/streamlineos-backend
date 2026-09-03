import type { Redis } from "@upstash/redis";
import { CacheService } from "./cache.service";
import { REDIS_COMMAND_TIMEOUT } from "./cache.service";
import { CacheFiller } from "./cache-fill";

function buildRedis(values = new Map<string, unknown>()): Redis {
  return {
    get: jest.fn(async (key: string) => values.get(key) ?? null),
    set: jest.fn(async (key: string, value: unknown, options?: { nx?: boolean; ex?: number }) => {
      if (options?.nx && values.has(key)) return null;
      values.set(key, value);
      return "OK";
    }),
    incr: jest.fn(async (key: string) => {
      const next = Number(values.get(key) ?? 0) + 1;
      values.set(key, next);
      return next;
    }),
    eval: jest.fn(async (_script: string, keys: string[], args: string[]) => {
      if (values.get(keys[0]) !== args[0]) return 0;
      values.delete(keys[0]);
      return 1;
    }),
  } as unknown as Redis;
}

describe("CacheService", () => {
  it("coalesces concurrent misses for the same key", async () => {
    let release!: (value: { ok: true }) => void;
    const fetcher = jest.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          release = resolve;
        }),
    );
    const cache = new CacheService(null);

    const first = cache.cached("same-key", fetcher);
    const second = cache.cached("same-key", fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    release({ ok: true });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);
  });

  it("coalesces a miss across service instances with a distributed fill lease", async () => {
    const values = new Map<string, unknown>();
    const redis = {
      get: jest.fn(async (key: string) => values.get(key) ?? null),
      set: jest.fn(async (key: string, value: unknown, options?: { nx?: boolean }) => {
        if (options?.nx && values.has(key)) return null;
        values.set(key, value);
        return "OK";
      }),
      eval: jest.fn(async (_script: string, keys: string[], args: string[]) => {
        if (values.get(keys[0]) !== args[0]) return 0;
        values.delete(keys[0]);
        return 1;
      }),
    } as unknown as Redis;
    const first = new CacheService(redis);
    const second = new CacheService(redis);
    const fetcher = jest.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 75));
      return { ok: true };
    });

    await expect(
      Promise.all([first.cached("shared-key", fetcher), second.cached("shared-key", fetcher)]),
    ).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("invalidates versioned namespaces without scanning keys", async () => {
    const values = new Map<string, unknown>();
    const redis = {
      get: jest.fn(async (key: string) => values.get(key) ?? null),
      set: jest.fn(async (key: string, value: unknown) => {
        values.set(key, value);
        return "OK";
      }),
      incr: jest.fn(async (key: string) => {
        const next = Number(values.get(key) ?? 0) + 1;
        values.set(key, next);
        return next;
      }),
      eval: jest.fn(async (_script: string, keys: string[], args: string[]) => {
        if (values.get(keys[0]) !== args[0]) return 0;
        values.delete(keys[0]);
        return 1;
      }),
      scan: jest.fn(),
    } as unknown as Redis;
    const cache = new CacheService(redis);
    const fetcher = jest.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("second");

    await expect(cache.cachedVersioned("contacts:org-1", "page-1", fetcher)).resolves.toBe("first");
    await cache.invalidateNamespace("contacts:org-1");
    await expect(cache.cachedVersioned("contacts:org-1", "page-1", fetcher)).resolves.toBe("second");

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(redis.incr).toHaveBeenCalledWith("cache:namespace:contacts:org-1:version");
    expect(redis.scan).not.toHaveBeenCalled();
  });
});

describe("tenant-aware wrappers", () => {
  it("cachedForOrg — org structurally required, keys never collide across tenants", async () => {
    const store = new Map<string, unknown>();
    const redis = buildRedis(store);
    const cache = new CacheService(redis);

    const fetchA = jest.fn().mockResolvedValue("data-a");
    const fetchB = jest.fn().mockResolvedValue("data-b");

    const a = await cache.cachedForOrg("org-a", "reports:summary", fetchA);
    const b = await cache.cachedForOrg("org-b", "reports:summary", fetchB);

    expect(a).toBe("data-a");
    expect(b).toBe("data-b");
    expect(fetchA).toHaveBeenCalledTimes(1);
    expect(fetchB).toHaveBeenCalledTimes(1);

    const keysWritten = [...store.keys()].filter((k) => !k.startsWith("cache:fill-lease:"));
    expect(keysWritten.some((k) => k.startsWith("org-a:"))).toBe(true);
    expect(keysWritten.some((k) => k.startsWith("org-b:"))).toBe(true);
    const orgAKey = keysWritten.find((k) => k.startsWith("org-a:"))!;
    const orgBKey = keysWritten.find((k) => k.startsWith("org-b:"))!;
    expect(orgAKey).not.toBe(orgBKey);
  });

  it("cachedVersionedForOrg — org structurally required, namespaces are tenant-scoped", async () => {
    const store = new Map<string, unknown>();
    const redis = buildRedis(store);
    const cache = new CacheService(redis);

    const fetchC = jest.fn().mockResolvedValue("data-c");
    const fetchD = jest.fn().mockResolvedValue("data-d");

    const c = await cache.cachedVersionedForOrg("org-c", "contacts:list", "page-1", fetchC);
    const d = await cache.cachedVersionedForOrg("org-d", "contacts:list", "page-1", fetchD);

    expect(c).toBe("data-c");
    expect(d).toBe("data-d");
    expect(fetchC).toHaveBeenCalledTimes(1);
    expect(fetchD).toHaveBeenCalledTimes(1);

    const dataKeys = [...store.keys()].filter((k) => !k.startsWith("cache:lease:"));
    expect(dataKeys.some((k) => k.startsWith("org-c:contacts:list:"))).toBe(true);
    expect(dataKeys.some((k) => k.startsWith("org-d:contacts:list:"))).toBe(true);
    expect(dataKeys.some((k) => k.startsWith("org-c:")) && dataKeys.some((k) => k.startsWith("org-d:"))).toBe(true);
  });

  it("invalidateNamespaceForOrg — invalidates only the specified org namespace", async () => {
    const store = new Map<string, unknown>();
    const redis = buildRedis(store);
    const cache = new CacheService(redis);

    const fetchE = jest.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    await cache.cachedVersionedForOrg("org-e", "items", "all", fetchE);
    await cache.invalidateNamespaceForOrg("org-e", "items");
    const after = await cache.cachedVersionedForOrg("org-e", "items", "all", fetchE);

    expect(after).toBe("second");
    expect(fetchE).toHaveBeenCalledTimes(2);
  });

  // TTL jitter is now owned by CacheFiller, which is the collaborator that
  // resolves a TTL for the write; CacheService.cachedForOrgWith is the only
  // caller that needs it directly, to jitter inside its own declared bound.
  it("jitterTtl — TTLs across many fills are spread rather than identical", () => {
    const filler = new CacheFiller((operation) => operation());
    const base = 300;
    const ttls = new Set<number>();
    for (let i = 0; i < 50; i++) {
      const result = filler.jitterTtl(base);
      expect(result).toBeGreaterThanOrEqual(Math.floor(base * 0.85));
      expect(result).toBeLessThanOrEqual(Math.ceil(base * 1.15));
      ttls.add(result);
    }
    expect(ttls.size).toBeGreaterThan(1);
  });
  it("distinct keys filled together get spread expiries, so they cannot re-stampede in lockstep", async () => {
    const captured: number[] = [];
    const redis = {
      get: jest.fn(async () => null),
      set: jest.fn(async (_key: string, _value: unknown, options?: { nx?: boolean; ex?: number }) => {
        if (options?.ex !== undefined && !options.nx) captured.push(options.ex);
        return "OK";
      }),
      incr: jest.fn(async () => 1),
      eval: jest.fn(async () => 1),
    } as unknown as Redis;

    const cache = new CacheService(redis);
    const base = 300;

    await Promise.all(
      Array.from({ length: 40 }, (_unused, i) =>
        cache.cachedForOrg("org-stampede", `report:${i}`, async () => ({ i }), base),
      ),
    );

    expect(captured).toHaveLength(40);
    for (const ttl of captured) {
      expect(ttl).toBeGreaterThanOrEqual(Math.floor(base * 0.85));
      expect(ttl).toBeLessThanOrEqual(Math.ceil(base * 1.15));
    }
    expect(new Set(captured).size).toBeGreaterThan(1);
  });

  it("never serves a null fetch result from cache, so a denial cannot outlive the grant that ends it", async () => {
    const values = new Map<string, unknown>();
    const redis = buildRedis(values);
    const cache = new CacheService(redis);

    const fetcher = jest
      .fn<Promise<{ ok: true } | null>, []>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ ok: true });

    await expect(cache.cached("negative-key", fetcher)).resolves.toBeNull();
    await expect(cache.cached("negative-key", fetcher)).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retries a failing invalidation and records the drop instead of swallowing it", async () => {
    const del = jest.fn(async () => {
      throw new Error("redis down");
    });
    const redis = { del, get: jest.fn(async () => null) } as unknown as Redis;
    const cache = new CacheService(redis);
    const logged = jest
      .spyOn(cache["logger"], "error")
      .mockImplementation(() => undefined);

    await cache.invalidate("stale-key");

    expect(del).toHaveBeenCalledTimes(3);
    expect(cache.droppedInvalidationCount).toBe(1);
    expect(String(logged.mock.calls[0]?.[0])).toContain("cache.invalidation.dropped");
    logged.mockRestore();
  });

  it("stops retrying an invalidation as soon as one attempt succeeds", async () => {
    let attempts = 0;
    const del = jest.fn(async () => {
      attempts++;
      if (attempts === 1) throw new Error("transient");
      return 1;
    });
    const redis = { del, get: jest.fn(async () => null) } as unknown as Redis;
    const cache = new CacheService(redis);

    await cache.invalidate("flaky-key");

    expect(del).toHaveBeenCalledTimes(2);
    expect(cache.droppedInvalidationCount).toBe(0);
  });
});

describe("command-timeout boundary", () => {
  it("a timed-out get degrades to the underlying source without surfacing an error", async () => {
    const redis = {
      get: jest.fn((): Promise<null> => new Promise(() => {})),
      set: jest.fn((): Promise<string | null> => new Promise(() => {})),
      eval: jest.fn((): Promise<number> => new Promise(() => {})),
    } as unknown as Redis;
    const cache = new CacheService(redis, 1);
    const source = jest.fn().mockResolvedValue({ fromDb: true });

    await expect(cache.cached("timeout-read-key", source)).resolves.toEqual({ fromDb: true });
    expect(source).toHaveBeenCalledTimes(1);
  });

  it("a timed-out invalidation surfaces through the drop counter and error log, not swallowed", async () => {
    const redis = {
      del: jest.fn((): Promise<number> => new Promise(() => {})),
      get: jest.fn((): Promise<null> => new Promise(() => {})),
    } as unknown as Redis;
    const cache = new CacheService(redis, 1);
    const errorSpy = jest
      .spyOn(cache["logger"], "error")
      .mockImplementation(() => undefined);

    await cache.invalidate("timeout-invalidation-key");

    expect(redis.del).toHaveBeenCalledTimes(3);
    expect(cache.droppedInvalidationCount).toBe(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("cache.invalidation.dropped");
    errorSpy.mockRestore();
  });

  it("REDIS_COMMAND_TIMEOUT token is exported for injection", () => {
    expect(REDIS_COMMAND_TIMEOUT).toBe("REDIS_COMMAND_TIMEOUT");
  });
});
