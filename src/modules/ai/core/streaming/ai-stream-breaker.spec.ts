import { ServiceUnavailableException } from "@nestjs/common";
import {
  AiStreamBreaker,
  AI_STREAM_BREAKER_FAILURE_THRESHOLD,
  AI_STREAM_BREAKER_OPEN_DURATION_MS,
  type AiStreamBreakerRedis,
} from "./ai-stream-breaker";

const MESSAGE = "AI provider is temporarily unavailable";

function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function makeRedis(): jest.Mocked<AiStreamBreakerRedis> {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue("OK"),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    del: jest.fn().mockResolvedValue(1),
  } as unknown as jest.Mocked<AiStreamBreakerRedis>;
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
};

describe("AiStreamBreaker — the breaker actually trips", () => {
  it("is closed with no failures and lets traffic through", async () => {
    const breaker = new AiStreamBreaker({ key: "test", unavailableMessage: MESSAGE });

    await expect(breaker.isOpen()).resolves.toBe(false);
    await expect(breaker.assertClosed()).resolves.toBeUndefined();
  });

  it("stays closed one failure short of the threshold", async () => {
    const breaker = new AiStreamBreaker({ key: "test", unavailableMessage: MESSAGE });

    for (let i = 0; i < AI_STREAM_BREAKER_FAILURE_THRESHOLD - 1; i += 1)
      breaker.recordFailure();

    await expect(breaker.isOpen()).resolves.toBe(false);
  });

  it("opens on the threshold failure and the open state rejects", async () => {
    const breaker = new AiStreamBreaker({ key: "test", unavailableMessage: MESSAGE });

    for (let i = 0; i < AI_STREAM_BREAKER_FAILURE_THRESHOLD; i += 1)
      breaker.recordFailure();

    await expect(breaker.isOpen()).resolves.toBe(true);
    await expect(breaker.assertClosed()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(breaker.assertClosed()).rejects.toThrow(MESSAGE);
  });

  it("closes again once the open window has elapsed, so one probe gets through", async () => {
    const clock = makeClock();
    const breaker = new AiStreamBreaker({ key: "test", unavailableMessage: MESSAGE, now: clock.now });

    for (let i = 0; i < AI_STREAM_BREAKER_FAILURE_THRESHOLD; i += 1)
      breaker.recordFailure();
    await expect(breaker.isOpen()).resolves.toBe(true);

    clock.advance(AI_STREAM_BREAKER_OPEN_DURATION_MS + 1);

    await expect(breaker.isOpen()).resolves.toBe(false);
  });

  it("RE-OPENS when the probe after the window also fails — counting equality against the threshold would open exactly once, ever", async () => {
    const clock = makeClock();
    const breaker = new AiStreamBreaker({ key: "test", unavailableMessage: MESSAGE, now: clock.now });

    for (let i = 0; i < AI_STREAM_BREAKER_FAILURE_THRESHOLD; i += 1)
      breaker.recordFailure();
    clock.advance(AI_STREAM_BREAKER_OPEN_DURATION_MS + 1);
    await expect(breaker.isOpen()).resolves.toBe(false);

    breaker.recordFailure();

    await expect(breaker.isOpen()).resolves.toBe(true);
    await expect(breaker.assertClosed()).rejects.toThrow(MESSAGE);
  });

  it("stays open across many consecutive failures rather than latching to the first open instant", async () => {
    const clock = makeClock();
    const breaker = new AiStreamBreaker({ key: "test", unavailableMessage: MESSAGE, now: clock.now });

    for (let cycle = 0; cycle < 4; cycle += 1) {
      for (let i = 0; i < AI_STREAM_BREAKER_FAILURE_THRESHOLD; i += 1) breaker.recordFailure();
      await expect(breaker.isOpen()).resolves.toBe(true);
      clock.advance(AI_STREAM_BREAKER_OPEN_DURATION_MS + 1);
      await expect(breaker.isOpen()).resolves.toBe(false);
    }
  });

  it("a success resets the count so an isolated blip never opens it", async () => {
    const breaker = new AiStreamBreaker({ key: "test", unavailableMessage: MESSAGE });

    for (let i = 0; i < AI_STREAM_BREAKER_FAILURE_THRESHOLD - 1; i += 1) breaker.recordFailure();
    breaker.recordSuccess();
    for (let i = 0; i < AI_STREAM_BREAKER_FAILURE_THRESHOLD - 1; i += 1) breaker.recordFailure();

    await expect(breaker.isOpen()).resolves.toBe(false);
  });
});

describe("AiStreamBreaker — shared state through Redis", () => {
  it("reports open when another instance wrote the opened_at key", async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValue(1_700_000_000_000);
    const breaker = new AiStreamBreaker({ key: "test", unavailableMessage: MESSAGE, redis });

    await expect(breaker.isOpen()).resolves.toBe(true);
    expect(redis.get).toHaveBeenCalledWith("ai:cb:test:opened_at");
  });

  it("falls back to local state when Redis throws rather than failing every request", async () => {
    const redis = makeRedis();
    redis.get.mockRejectedValue(new Error("Redis unavailable"));
    const breaker = new AiStreamBreaker({ key: "test", unavailableMessage: MESSAGE, redis });

    await expect(breaker.isOpen()).resolves.toBe(false);

    for (let i = 0; i < AI_STREAM_BREAKER_FAILURE_THRESHOLD; i += 1) breaker.recordFailure();
    await expect(breaker.isOpen()).resolves.toBe(true);
  });

  it("writes opened_at on every failure at or above the threshold, not only on the exact threshold hit", async () => {
    const redis = makeRedis();
    redis.incr.mockResolvedValueOnce(7);
    const breaker = new AiStreamBreaker({ key: "test", unavailableMessage: MESSAGE, redis });

    breaker.recordFailure();
    await flush();

    expect(redis.set).toHaveBeenCalledWith("ai:cb:test:opened_at", expect.any(Number), { ex: 30 });
  });

  it("expires the failure counter so a count from an old outage cannot pre-open the breaker", async () => {
    const redis = makeRedis();
    const breaker = new AiStreamBreaker({ key: "test", unavailableMessage: MESSAGE, redis });

    breaker.recordFailure();
    await flush();

    expect(redis.expire).toHaveBeenCalledWith("ai:cb:test:failures", 60);
  });

  it("clears both keys on success", async () => {
    const redis = makeRedis();
    const breaker = new AiStreamBreaker({ key: "test", unavailableMessage: MESSAGE, redis });

    breaker.recordSuccess();
    await flush();

    expect(redis.del).toHaveBeenCalledWith("ai:cb:test:failures");
    expect(redis.del).toHaveBeenCalledWith("ai:cb:test:opened_at");
  });

  it("keeps the chat breaker on the key names an already-deployed instance shares", () => {
    const redis = makeRedis();
    const breaker = new AiStreamBreaker({ key: "chat", unavailableMessage: MESSAGE, redis });

    void breaker.isOpen();

    expect(redis.get).toHaveBeenCalledWith("ai:cb:chat:opened_at");
  });
});
