import { ProviderCircuitBreaker } from "../common/outbound/provider-circuit-breaker";
import { HEARTBEAT_KEY_PREFIX } from "../modules/cron/cron-lease.service";
import { cacheCheck, databaseCheck, providerCheck, queueCheck } from "./dependency-checks";
import type { ReadinessRedis } from "./readiness.types";

function redisReturning(values: Record<string, string>): ReadinessRedis {
  return {
    ping: () => Promise.resolve("PONG"),
    get: (key: string): Promise<unknown> => Promise.resolve(values[key] ?? null),
  };
}

describe("databaseCheck", () => {
  it("is up when the probe resolves", async () => {
    await expect(databaseCheck(() => Promise.resolve(undefined)).run()).resolves.toEqual({
      state: "up",
    });
  });

  it("is required, so its failure is unready rather than degraded", () => {
    expect(databaseCheck(() => Promise.resolve(undefined)).required).toBe(true);
  });

  it("propagates the failure so the service can classify it as down", async () => {
    await expect(
      databaseCheck(() => Promise.reject(new Error("terminating connection"))).run(),
    ).rejects.toThrow("terminating connection");
  });
});

describe("cacheCheck", () => {
  it("is skipped when Redis is not configured, and never required", async () => {
    const check = cacheCheck(null, () => 0);

    expect(check.required).toBe(false);
    await expect(check.run()).resolves.toEqual({
      state: "skipped",
      detail: "Redis is not configured",
    });
  });

  it("degrades when the ping fails — a cache miss still falls through to the database", async () => {
    const redis: ReadinessRedis = {
      ping: () => Promise.reject(new Error("upstash timeout")),
      get: () => Promise.resolve(null),
    };

    await expect(cacheCheck(redis, () => 0).run()).resolves.toEqual({
      state: "degraded",
      detail: "upstash timeout",
    });
  });

  it("degrades on dropped invalidations even when the connection is healthy", async () => {
    const outcome = await cacheCheck(redisReturning({}), () => 3).run();

    expect(outcome.state).toBe("degraded");
    expect(outcome.detail).toContain("3 invalidation(s) dropped");
  });

  it("is up when the connection answers and nothing has been dropped", async () => {
    await expect(cacheCheck(redisReturning({}), () => 0).run()).resolves.toEqual({ state: "up" });
  });
});

describe("queueCheck", () => {
  const NOW = Date.parse("2026-09-02T12:00:00.000Z");
  const JOB = "outbox-events-worker";
  const KEY = `${HEARTBEAT_KEY_PREFIX}${JOB}`;

  it("is up while the drain worker's heartbeat is fresh", async () => {
    const redis = redisReturning({ [KEY]: new Date(NOW - 30_000).toISOString() });

    await expect(queueCheck(redis, [JOB], 900, () => NOW).run()).resolves.toEqual({ state: "up" });
  });

  it("degrades when the heartbeat is older than the stall window", async () => {
    const redis = redisReturning({ [KEY]: new Date(NOW - 1_000_000).toISOString() });

    const outcome = await queueCheck(redis, [JOB], 900, () => NOW).run();

    expect(outcome.state).toBe("degraded");
    expect(outcome.detail).toContain(JOB);
  });

  it("degrades when the drain worker has never run", async () => {
    const outcome = await queueCheck(redisReturning({}), [JOB], 900, () => NOW).run();

    expect(outcome.state).toBe("degraded");
    expect(outcome.detail).toContain("never ran");
  });

  it("reads the heartbeat rather than counting a backlog, so it costs no database round trip", async () => {
    const get = jest.fn<Promise<unknown>, [string]>().mockResolvedValue(null);
    const redis: ReadinessRedis = { ping: () => Promise.resolve("PONG"), get };

    await queueCheck(redis, [JOB], 900, () => NOW).run();

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(KEY);
  });

  it("is skipped when Redis is absent or no drain jobs are declared", async () => {
    await expect(queueCheck(null, [JOB], 900, () => NOW).run()).resolves.toMatchObject({
      state: "skipped",
    });
    await expect(queueCheck(redisReturning({}), [], 900, () => NOW).run()).resolves.toMatchObject({
      state: "skipped",
    });
  });
});

describe("providerCheck", () => {
  const NOW = 10_000;

  it("is skipped when the deployment declares no required provider", async () => {
    const outcome = await providerCheck([], () => [], () => NOW).run();

    expect(outcome.state).toBe("skipped");
  });

  it("is down when a declared provider's circuit is open", async () => {
    const outcome = await providerCheck(["razorpay"], () => ["razorpay"], () => NOW).run();

    expect(outcome.state).toBe("down");
    expect(outcome.detail).toContain("razorpay");
  });

  it("ignores an open circuit for a provider the deployment does not require", async () => {
    const outcome = await providerCheck(["razorpay"], () => ["slack"], () => NOW).run();

    expect(outcome.state).toBe("up");
  });

  it("reads the breaker without half-opening it, so a probe never spends the recovery attempt", () => {
    const openedAt = Date.parse("2026-09-02T12:00:00.000Z");
    const breaker = new ProviderCircuitBreaker(1, 60_000);
    breaker.recordFailure("razorpay", openedAt);

    expect(breaker.openProviders(openedAt + 60_001)).toEqual([]);
    expect(breaker.openProviders(openedAt + 1_000)).toEqual(["razorpay"]);
    expect(breaker.openProviders(openedAt + 1_000)).toEqual(["razorpay"]);
    expect(breaker.check("razorpay", openedAt + 1_000).open).toBe(true);
  });

  it("stops reporting a provider once its cooldown has elapsed", () => {
    const openedAt = Date.parse("2026-09-02T12:00:00.000Z");
    const breaker = new ProviderCircuitBreaker(1, 60_000);
    breaker.recordFailure("razorpay", openedAt);

    expect(breaker.openProviders(openedAt + 60_001)).toEqual([]);
  });
});
