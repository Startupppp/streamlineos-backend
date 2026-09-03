import { ServiceUnavailableException } from "@nestjs/common";
import { SessionsService } from "./sessions.service";
import { logger } from "../../common/logger/logger.service";

type Trace = string[];

function makeRedis(trace: Trace, fail: { mset?: boolean; zadd?: boolean } = {}) {
  const store = new Map<string, unknown>();
  const zset = new Map<string, number>();
  return {
    store,
    zset,
    mset: jest.fn((kv: Record<string, unknown>) => {
      trace.push(`mset:${String(Object.keys(kv).length)}`);
      if (fail.mset) return Promise.reject(new Error("upstash: fetch failed"));
      for (const [k, v] of Object.entries(kv)) store.set(k, v);
      return Promise.resolve("OK");
    }),
    zadd: jest.fn((_key: string, ...sm: { score: number; member: string }[]) => {
      trace.push(`zadd:${String(sm.length)}`);
      if (fail.zadd) return Promise.reject(new Error("upstash: WRONGTYPE"));
      for (const one of sm) zset.set(one.member, one.score);
      return Promise.resolve(sm.length);
    }),
    zrange: jest.fn(() => Promise.resolve([])),
    zremrangebyscore: jest.fn(() => Promise.resolve(0)),
    del: jest.fn(() => Promise.resolve(0)),
  };
}

/** Only the two shapes SessionsService drives: a `query.*` read and an update chain. */
function makeDb(trace: Trace, rows: { id: string }[]) {
  const update = () => ({
    set: () => ({
      where: () => {
        trace.push("db:update");
        return Promise.resolve(undefined);
      },
    }),
  });
  return {
    query: {
      userSessions: {
        findMany: () => Promise.resolve(rows),
        findFirst: () => Promise.resolve(rows[0] ?? null),
      },
    },
    update,
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve(rows),
        }),
      }),
    }),
  };
}

function makeService(db: unknown, redis: unknown) {
  return new SessionsService(db as never, redis as never);
}

describe("SessionsService tombstone failures are not swallowed", () => {
  let errors: jest.SpyInstance;

  beforeEach(() => {
    errors = jest.spyOn(logger, "error").mockImplementation(() => undefined);
  });
  afterEach(() => errors.mockRestore());

  it("rejects with ServiceUnavailableException when the MSET that publishes the tombstone fails", async () => {
    const trace: Trace = [];
    const svc = makeService(makeDb(trace, []), makeRedis(trace, { mset: true }));

    await expect(svc.publishRevocations(["s1", "s2"])).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(errors).toHaveBeenCalledWith(
      "session revocation tombstone write failed",
      expect.objectContaining({ sessions: 2 }),
    );
  });

  it("still writes every other chunk and reports the whole lost count, not one id", async () => {
    const trace: Trace = [];
    const redis = makeRedis(trace);
    let call = 0;
    redis.mset.mockImplementation((kv: Record<string, unknown>) => {
      call += 1;
      if (call === 1) return Promise.reject(new Error("upstash: fetch failed"));
      for (const [k, v] of Object.entries(kv)) redis.store.set(k, v);
      return Promise.resolve("OK");
    });
    const ids = Array.from({ length: 512 }, (_, i) => `s${String(i)}`);

    await expect(
      makeService(makeDb(trace, []), redis).publishRevocations(ids),
    ).rejects.toThrow("Could not publish 256 session revocation(s)");

    expect(redis.store.size).toBe(256);
    expect(redis.store.has("revoked:session:s511")).toBe(true);
  });

  it("keeps a failed reclaim-index ZADD non-fatal — the tombstone is durable, only the prune key leaks", async () => {
    const trace: Trace = [];
    const redis = makeRedis(trace, { zadd: true });

    await expect(
      makeService(makeDb(trace, []), redis).publishRevocations(["s1"]),
    ).resolves.toBeUndefined();

    expect(redis.store.has("revoked:session:s1")).toBe(true);
    expect(errors).toHaveBeenCalledWith(
      "session revocation index write failed",
      expect.objectContaining({ sessions: 1 }),
    );
  });

  it("writes the database revocation BEFORE the tombstone so the guard's database fallback still denies a lost tombstone", async () => {
    const trace: Trace = [];
    const svc = makeService(
      makeDb(trace, [{ id: "s1" }, { id: "s2" }]),
      makeRedis(trace),
    );

    await svc.revokeAllForUser("u1");

    expect(trace).toEqual(["db:update", "mset:2", "zadd:2"]);
  });

  it("never fails sign-in when the session-cap eviction cannot publish its tombstones", async () => {
    const trace: Trace = [];
    const rows = Array.from({ length: 4 }, (_, i) => ({ id: `s${String(i)}` }));
    const svc = makeService(makeDb(trace, rows), makeRedis(trace, { mset: true }));

    await expect(svc.enforceMaxSessions("u1", 2, "s3")).resolves.toBeUndefined();

    expect(trace).toContain("db:update");
    expect(errors).toHaveBeenCalledWith(
      "session cap eviction left sessions untombstoned",
      expect.objectContaining({ userId: "u1", sessions: 2 }),
    );
  });
});
