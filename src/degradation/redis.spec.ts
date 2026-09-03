import { Redis } from "@upstash/redis";
import { FaultServer, refusedPort } from "./fault-server";
import { CacheService } from "../common/cache/cache.service";
import { RateLimitService, effectiveRateLimit } from "../common/ratelimit/rate-limit.service";

function makeRedis(url: string): Redis {
  return new Redis({ url, token: "test-token", retry: { retries: 0 } });
}

function makeRedisWithPerRequestTimeout(url: string, timeoutMs: number): Redis {
  return new Redis({ url, token: "test-token", retry: { retries: 0 }, signal: () => AbortSignal.timeout(timeoutMs) });
}

describe("CacheService — Redis dead (REFUSED)", () => {
  let redis: Redis;

  beforeAll(async () => {
    const port = await refusedPort();
    redis = makeRedis(`http://127.0.0.1:${port}`);
  });

  it("falls back to the fetcher when Redis is unavailable — correctness is database-backed", async () => {
    const cache = new CacheService(redis);
    const fetcher = jest.fn().mockResolvedValue("db-result");

    const result = await cache.cached("some-key", fetcher, 60);

    expect(result).toBe("db-result");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  /**
   * This used to assert "no stale value served" for EVERY key. That made the
   * degraded path serve the whole read volume to the database on every request
   * for the length of the outage — the stampede §6 forbids, arriving exactly
   * when the database can least absorb it. The invariant is kept where it was
   * earned, on authorization, and narrowed elsewhere: during an outage the
   * alternative to a one-second process-local memo is not a fresher answer, it
   * is no cache at all.
   */
  it("never serves an authorization answer from memory when Redis is dead", async () => {
    const cache = new CacheService(redis);

    for (const key of [
      "user:session:user-1",
      "cell-a:org-1:access:perms:user-1:v3",
      "membership:account:user-1",
      "mfa:user-totp:user-1",
      "rbac:matrix:org-1:v2",
    ]) {
      const fetcher = jest.fn().mockResolvedValue("fresh");
      await cache.cached(key, fetcher, 60);
      await cache.cached(key, fetcher, 60);
      expect(fetcher).toHaveBeenCalledTimes(2);
    }

    expect(cache.outageMemoServedCount).toBe(0);
  });

  it("coalesces an ordinary key for one second rather than serialising onto the database", async () => {
    const cache = new CacheService(redis);
    const fetcher = jest.fn().mockResolvedValue("fresh");

    await cache.cached("another-key", fetcher, 60);
    await cache.cached("another-key", fetcher, 60);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.outageMemoServedCount).toBe(1);
  });

  it("an explicit invalidation still bites during the outage", async () => {
    const cache = new CacheService(redis);
    const fetcher = jest.fn().mockResolvedValueOnce("before").mockResolvedValue("after");

    await expect(cache.cached("invalidated-during-outage", fetcher, 60)).resolves.toBe("before");
    await cache.invalidate("invalidated-during-outage");
    await expect(cache.cached("invalidated-during-outage", fetcher, 60)).resolves.toBe("after");

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("cachedVersioned falls back to the fetcher rather than throwing", async () => {
    const cache = new CacheService(redis);
    const fetcher = jest.fn().mockResolvedValue(42);

    const result = await cache.cachedVersioned("ns", "k", fetcher, 60);

    expect(result).toBe(42);
  });
});

describe("RateLimitService — Redis dead, in-memory fallback is conservative", () => {
  let service: RateLimitService;

  beforeAll(async () => {
    const port = await refusedPort();
    const redis = makeRedis(`http://127.0.0.1:${port}`);
    service = new RateLimitService(redis);
  });

  it("falls back to in-memory and still DENIES requests past effectiveRateLimit", async () => {
    const tier = "auth:login";
    const id = `test-user-${Date.now()}`;
    const limit = effectiveRateLimit(tier);

    expect(limit).toBeGreaterThan(0);

    let lastResult: { allowed: boolean; retryAfterSecs: number } | undefined;
    for (let i = 0; i < limit + 1; i++)
      lastResult = await service.check(tier, id);

    expect(lastResult?.allowed).toBe(false);
    expect(lastResult?.retryAfterSecs).toBeGreaterThan(0);
  });

  it("allows requests up to (not past) the effective limit", async () => {
    const tier = "auth:register";
    const id = `allow-user-${Date.now()}`;
    const limit = effectiveRateLimit(tier);

    const results: boolean[] = [];
    for (let i = 0; i < limit; i++) {
      const r = await service.check(tier, id);
      results.push(r.allowed);
    }

    expect(results.every((v) => v)).toBe(true);
  });

  it("does not count different identifiers against each other", async () => {
    const tier = "auth:login";
    const limit = effectiveRateLimit(tier);

    const idA = `user-A-${Date.now()}`;
    const idB = `user-B-${Date.now()}`;

    for (let i = 0; i < limit + 1; i++) await service.check(tier, idA);

    const r = await service.check(tier, idB);
    expect(r.allowed).toBe(true);
  });
});

describe("RateLimitService — unknown tier always denies (fail-closed)", () => {
  it("denies an unknown tier even when Redis is healthy (null Redis = no Redis path)", async () => {
    const service = new RateLimitService(null);

    const result = await service.check("unknown-tier-that-does-not-exist", "user");

    expect(result.allowed).toBe(false);
    expect(result.retryAfterSecs).toBe(60);
  });

  it("denies an unknown tier even when Redis is dead", async () => {
    const port = await refusedPort();
    const redis = makeRedis(`http://127.0.0.1:${port}`);
    const service = new RateLimitService(redis);

    const result = await service.check("not-in-TIERS-at-all", "user");

    expect(result.allowed).toBe(false);
  });
});

describe("effectiveRateLimit", () => {
  it("returns zero for an unknown tier, not the declared limit", () => {
    expect(effectiveRateLimit("nonexistent-tier")).toBe(0);
  });

  it("returns a positive number for a known tier", () => {
    expect(effectiveRateLimit("auth:login")).toBeGreaterThan(0);
  });

  it("is higher than the raw declared limit outside production (DEV_LIMIT_MULTIPLIER)", () => {
    if (process.env.NODE_ENV === "production") return;
    const effective = effectiveRateLimit("auth:login");
    expect(effective).toBeGreaterThan(5);
  });
});

describe("FaultServer — Redis pointed at blackhole", () => {
  let server: FaultServer;
  let service: RateLimitService;

  beforeAll(async () => {
    server = new FaultServer({ mode: "blackhole" });
    await server.start();
    const redis = makeRedisWithPerRequestTimeout(server.url, 150);
    service = new RateLimitService(redis);
  }, 10_000);

  afterAll(() => server.stop());

  it("falls back to in-memory when Redis hangs and still enforces limit", async () => {
    const tier = "auth:login";
    const id = `blackhole-user-${Date.now()}`;
    const limit = effectiveRateLimit(tier);

    let last: { allowed: boolean; retryAfterSecs: number } | undefined;
    for (let i = 0; i < limit + 1; i++)
      last = await service.check(tier, id);

    expect(last?.allowed).toBe(false);
  }, 15_000);
});
