import type { Redis } from "@upstash/redis";
import { CacheService } from "./cache.service";

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
