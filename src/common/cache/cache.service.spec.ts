import type { Redis } from "@upstash/redis";
import { CacheService } from "./cache.service";

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

  it("applyJitter — TTLs across many fills are spread rather than identical", () => {
    const cache = new CacheService(null);
    const base = 300;
    const ttls = new Set<number>();
    for (let i = 0; i < 50; i++) {
      const result = cache["applyJitter"](base);
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
});

describe("cross-instance invalidation", () => {
  it("invalidation by one instance is visible to a second instance sharing the same Redis", async () => {
    const values = new Map<string, unknown>();
    function makeSharedRedis() {
      return {
        get: jest.fn(async (key: string) => values.get(key) ?? null),
        set: jest.fn(async (key: string, value: unknown, options?: { nx?: boolean; ex?: number }) => {
          if (options?.nx && values.has(key)) return null;
          values.set(key, value);
          return "OK";
        }),
        del: jest.fn(async (key: string) => {
          const had = values.has(key) ? 1 : 0;
          values.delete(key);
          return had;
        }),
        incr: jest.fn(async (key: string) => {
          const next = Number(values.get(key) ?? 0) + 1;
          values.set(key, next);
          return next;
        }),
        eval: jest.fn(async (_script: string, keys: string[], args: string[]) => {
          if (values.get(keys[0] as string) !== args[0]) return 0;
          values.delete(keys[0] as string);
          return 1;
        }),
      } as unknown as import("@upstash/redis").Redis;
    }

    const instanceA = new CacheService(makeSharedRedis());
    const instanceB = new CacheService(makeSharedRedis());

    let fetchCount = 0;
    await instanceA.cachedVersioned("cross:org-x", "key", async () => {
      fetchCount++;
      return "initial";
    });

    const cached = await instanceB.cachedVersioned("cross:org-x", "key", async () => {
      fetchCount++;
      return "would-not-be-served";
    });
    expect(cached).toBe("initial");
    expect(fetchCount).toBe(1);

    await instanceA.invalidateNamespace("cross:org-x");

    const fresh = await instanceB.cachedVersioned("cross:org-x", "key", async () => {
      fetchCount++;
      return "after-invalidation";
    });
    expect(fresh).toBe("after-invalidation");
    expect(fetchCount).toBe(2);
  });

  it("org-scoped invalidation by one instance does not affect another org on another instance", async () => {
    const values = new Map<string, unknown>();
    function makeSharedRedis() {
      return {
        get: jest.fn(async (key: string) => values.get(key) ?? null),
        set: jest.fn(async (key: string, value: unknown, options?: { nx?: boolean }) => {
          if (options?.nx && values.has(key)) return null;
          values.set(key, value);
          return "OK";
        }),
        del: jest.fn(async (key: string) => {
          const had = values.has(key) ? 1 : 0;
          values.delete(key);
          return had;
        }),
        incr: jest.fn(async (key: string) => {
          const next = Number(values.get(key) ?? 0) + 1;
          values.set(key, next);
          return next;
        }),
        eval: jest.fn(async (_script: string, keys: string[], args: string[]) => {
          if (values.get(keys[0] as string) !== args[0]) return 0;
          values.delete(keys[0] as string);
          return 1;
        }),
      } as unknown as import("@upstash/redis").Redis;
    }

    const instanceA = new CacheService(makeSharedRedis());
    const instanceB = new CacheService(makeSharedRedis());

    let fetchOrgA = 0;
    let fetchOrgB = 0;

    await instanceA.cachedForOrg("org-a", "report:q1", async () => {
      fetchOrgA++;
      return "org-a-data";
    });
    await instanceB.cachedForOrg("org-b", "report:q1", async () => {
      fetchOrgB++;
      return "org-b-data";
    });

    await instanceA.invalidateForOrg("org-a", "report:q1");

    const orgBResult = await instanceB.cachedForOrg("org-b", "report:q1", async () => {
      fetchOrgB++;
      return "org-b-should-not-refetch";
    });
    expect(orgBResult).toBe("org-b-data");
    expect(fetchOrgB).toBe(1);

    const orgAResult = await instanceA.cachedForOrg("org-a", "report:q1", async () => {
      fetchOrgA++;
      return "org-a-refetched";
    });
    expect(orgAResult).toBe("org-a-refetched");
    expect(fetchOrgA).toBe(2);
  });
});
