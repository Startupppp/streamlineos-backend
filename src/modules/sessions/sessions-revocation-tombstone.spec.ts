import { SessionsService } from "./sessions.service";

type SetCall = { key: string; value: unknown; opts?: { ex?: number } };

function makeRedis() {
  const store = new Map<string, unknown>();
  const zset = new Map<string, number>();
  const setCalls: SetCall[] = [];

  return {
    store,
    zset,
    setCalls,
    set: jest.fn((key: string, value: unknown, opts?: { ex?: number }) => {
      setCalls.push({ key, value, opts });
      store.set(key, value);
      return Promise.resolve("OK");
    }),
    zadd: jest.fn((key: string, scoreMember: { score: number; member: string }) => {
      zset.set(scoreMember.member, scoreMember.score);
      return Promise.resolve(1);
    }),
    zrange: jest.fn((_key: string, min: number, max: number) =>
      Promise.resolve(
        [...zset.entries()]
          .filter(([, score]) => score >= min && score <= max)
          .map(([member]) => member),
      ),
    ),
    zremrangebyscore: jest.fn((_key: string, min: number, max: number) => {
      let removed = 0;
      for (const [member, score] of [...zset.entries()]) {
        if (score >= min && score <= max) {
          zset.delete(member);
          removed += 1;
        }
      }
      return Promise.resolve(removed);
    }),
    del: jest.fn((...keys: string[]) => {
      for (const k of keys) store.delete(k);
      return Promise.resolve(keys.length);
    }),
  };
}

function makeService(redis: ReturnType<typeof makeRedis>) {
  return new SessionsService({} as never, redis as never);
}

describe("SessionsService revocation tombstones", () => {
  it("writes tombstones with NO ttl so volatile-lru can never evict them", async () => {
    const redis = makeRedis();
    await makeService(redis).publishRevocations(["s1", "s2"]);

    const tombstoneWrites = redis.setCalls.filter((c) => c.key.startsWith("revoked:session:"));
    expect(tombstoneWrites).toHaveLength(2);
    for (const call of tombstoneWrites) {
      expect(call.opts?.ex).toBeUndefined();
    }
  });

  it("indexes each tombstone by its expiry so it can be reclaimed without redis expiry", async () => {
    const redis = makeRedis();
    await makeService(redis).publishRevocations(["s1"]);

    expect(redis.zadd).toHaveBeenCalledTimes(1);
    const score = redis.zset.get("s1");
    expect(score).toBeGreaterThan(Date.now());
  });

  it("prunes only tombstones whose window has passed, leaving live ones revoked", async () => {
    const redis = makeRedis();
    const svc = makeService(redis);

    redis.store.set("revoked:session:stale", true);
    redis.zset.set("stale", Date.now() - 1000);
    redis.store.set("revoked:session:live", true);
    redis.zset.set("live", Date.now() + 60_000);

    const result = await svc.pruneExpiredRevocations();

    expect(result.removed).toBe(1);
    expect(redis.store.has("revoked:session:stale")).toBe(false);
    expect(redis.store.has("revoked:session:live")).toBe(true);
    expect(redis.zset.has("live")).toBe(true);
  });

  it("is a no-op when nothing has expired", async () => {
    const redis = makeRedis();
    redis.zset.set("live", Date.now() + 60_000);

    const result = await makeService(redis).pruneExpiredRevocations();

    expect(result.removed).toBe(0);
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("degrades to a no-op when redis is absent rather than throwing", async () => {
    const svc = new SessionsService({} as never, null as never);
    await expect(svc.publishRevocations(["s1"])).resolves.toBeUndefined();
    await expect(svc.pruneExpiredRevocations()).resolves.toEqual({ removed: 0 });
  });
});
