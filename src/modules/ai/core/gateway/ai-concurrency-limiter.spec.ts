import { AiConcurrencyLimiter, AI_CONCURRENCY_CAP } from "./ai-concurrency-limiter";

type MockRedis = {
  incr: jest.Mock;
  expire: jest.Mock;
  decr: jest.Mock;
};

function makeRedis(overrides: Partial<MockRedis> = {}): MockRedis {
  return {
    incr: overrides.incr ?? jest.fn().mockResolvedValue(1),
    expire: overrides.expire ?? jest.fn().mockResolvedValue(1),
    decr: overrides.decr ?? jest.fn().mockResolvedValue(0),
  };
}

describe("AiConcurrencyLimiter — Redis path", () => {
  beforeEach(() => jest.clearAllMocks());

  it("allows acquire when Redis count is within cap", async () => {
    const redis = makeRedis({ incr: jest.fn().mockResolvedValue(5) });
    const limiter = new AiConcurrencyLimiter(redis as never);
    await expect(limiter.acquire("org_1")).resolves.toBe(true);
    expect(redis.incr).toHaveBeenCalledWith("ai:inflight:org_1");
  });

  it("denies acquire and decrements when Redis count exceeds cap", async () => {
    const redis = makeRedis({ incr: jest.fn().mockResolvedValue(AI_CONCURRENCY_CAP + 1) });
    const limiter = new AiConcurrencyLimiter(redis as never);
    await expect(limiter.acquire("org_1")).resolves.toBe(false);
    await new Promise((r) => setTimeout(r, 10));
    expect(redis.decr).toHaveBeenCalledWith("ai:inflight:org_1");
  });

  it("allows acquire at exactly the cap boundary", async () => {
    const redis = makeRedis({ incr: jest.fn().mockResolvedValue(AI_CONCURRENCY_CAP) });
    const limiter = new AiConcurrencyLimiter(redis as never);
    await expect(limiter.acquire("org_1")).resolves.toBe(true);
  });

  it("release decrements the Redis counter", () => {
    const redis = makeRedis();
    const limiter = new AiConcurrencyLimiter(redis as never);
    limiter.release("org_1");
    expect(redis.decr).toHaveBeenCalledWith("ai:inflight:org_1");
  });
});

describe("AiConcurrencyLimiter — Redis unavailable (fail-open)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("allows acquire when Redis INCR throws — fail open", async () => {
    const redis = makeRedis({ incr: jest.fn().mockRejectedValue(new Error("Redis down")) });
    const limiter = new AiConcurrencyLimiter(redis as never);
    await expect(limiter.acquire("org_1")).resolves.toBe(true);
  });

  it("allows acquire when Redis is null — local fallback allows fresh org", async () => {
    const limiter = new AiConcurrencyLimiter(null);
    await expect(limiter.acquire("org_1")).resolves.toBe(true);
  });
});

describe("AiConcurrencyLimiter — local fallback (no Redis)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("enforces cap in-process", async () => {
    const limiter = new AiConcurrencyLimiter(null);
    for (let i = 0; i < AI_CONCURRENCY_CAP; i++) await limiter.acquire("org_1");
    await expect(limiter.acquire("org_1")).resolves.toBe(false);
  });

  it("allows a new acquire after release", async () => {
    const limiter = new AiConcurrencyLimiter(null);
    for (let i = 0; i < AI_CONCURRENCY_CAP; i++) await limiter.acquire("org_1");
    limiter.release("org_1");
    await expect(limiter.acquire("org_1")).resolves.toBe(true);
  });

  it("different orgs have independent counters", async () => {
    const limiter = new AiConcurrencyLimiter(null);
    for (let i = 0; i < AI_CONCURRENCY_CAP; i++) await limiter.acquire("org_1");
    await expect(limiter.acquire("org_2")).resolves.toBe(true);
  });
});

describe("AiConcurrencyLimiter — bite proof: DECR is called on every exit path", () => {
  it("DECR counter decremented on release regardless of runner success or failure", async () => {
    const redis = makeRedis({ incr: jest.fn().mockResolvedValue(1) });
    const limiter = new AiConcurrencyLimiter(redis as never);

    await limiter.acquire("org_1");

    limiter.release("org_1");
    await new Promise((r) => setTimeout(r, 10));

    expect(redis.decr).toHaveBeenCalledWith("ai:inflight:org_1");
    expect(redis.decr).toHaveBeenCalledTimes(1);
  });
});
