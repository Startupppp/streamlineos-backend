import { streamText } from "ai";
import {
  AiGatewayStreamHelper,
  breakerAttribution,
  tenantBreakerKey,
} from "../ai-gateway-stream.helper";
import { AiConcurrencyLimiter, AI_CONCURRENCY_CAP } from "../ai-concurrency-limiter";
import { AiUsageService } from "../../services/ai-usage.service";
import { AiProviderUnavailableException } from "../../services/ai-service-exceptions";
import type { AiCreditLedger } from "../credit-ledger.interface";

jest.mock("ai", () => ({
  streamText: jest.fn(),
  stepCountIs: jest.fn(),
}));

jest.mock("../ai-stream-model", () => ({
  resolveAiStreamModel: () => ({ model: "model-handle", modelId: "gemini-1.5-pro-latest" }),
}));

const FEATURE = "blog.improve-writing";

interface StreamCall {
  onError?: (event: { error: unknown }) => void;
}

function captureStream(): StreamCall[] {
  const calls: StreamCall[] = [];
  jest.mocked(streamText).mockImplementation((config: unknown) => {
    calls.push(config as StreamCall);
    return { finishReason: Promise.resolve("stop") } as unknown as ReturnType<typeof streamText>;
  });
  return calls;
}

function makeLedger() {
  return {
    reserve: jest.fn().mockResolvedValue({ reservationId: 9 }),
    settle: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<AiCreditLedger>;
}

function makeUsage() {
  return { track: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AiUsageService>;
}

function makeHelper() {
  return new AiGatewayStreamHelper(makeLedger(), makeUsage(), new AiConcurrencyLimiter());
}

function statusError(status: number): Error {
  const error = new Error(`provider said ${status}`);
  Object.assign(error, { status });
  return error;
}

function opts(orgId: string) {
  return {
    actor: { orgId, userId: "user_1" },
    feature: FEATURE,
    prompt: { system: "sys", user: "user" },
  };
}

/**
 * PRD-C153's "enforce circuit breakers" clause.
 *
 * The breaker counted EVERY non-abort error on ONE globally shared key, so a
 * verdict on the request — a 400 from a malformed prompt, an over-length
 * context, a content-policy refusal — was recorded as evidence the provider was
 * unwell. Five of them from a single tenant opened the only breaker there was
 * and denied AI to every other tenant in the deployment for 30 s, while the
 * provider was perfectly healthy the whole time. `llm-retry` already draws that
 * line for retries; the breaker now draws the same one.
 */
describe("the breaker attributes a failure to the right subject", () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([
    ["a malformed prompt (400)", 400, "request"],
    ["an auth refusal (401)", 401, "request"],
    ["a content-policy refusal (403)", 403, "request"],
    ["a tenant rate limit (429)", 429, "tenant"],
    ["a provider fault (500)", 500, "provider"],
    ["provider overload (503)", 503, "provider"],
  ])("%s is evidence against the %s", (_label, status, expected) => {
    expect(breakerAttribution(statusError(status))).toBe(expected);
  });

  it("a storm of 4xx verdicts never opens the shared provider breaker", async () => {
    const calls = captureStream();
    const helper = makeHelper();

    await helper.run(opts("org_noisy"));
    for (let i = 0; i < 20; i += 1) calls[0]?.onError?.({ error: statusError(400) });

    expect(await helper.breakerFor("stream").isOpen()).toBe(false);
    await expect(helper.run(opts("org_innocent"))).resolves.toBeDefined();
  });

  it("a tenant burning its rate limit opens only its own breaker", async () => {
    const calls = captureStream();
    const helper = makeHelper();

    await helper.run(opts("org_noisy"));
    for (let i = 0; i < 5; i += 1) calls[0]?.onError?.({ error: statusError(429) });

    expect(await helper.breakerFor(tenantBreakerKey("stream", "org_noisy")).isOpen()).toBe(true);
    expect(await helper.breakerFor("stream").isOpen()).toBe(false);
    await expect(helper.run(opts("org_noisy"))).rejects.toThrow(AiProviderUnavailableException);
    await expect(helper.run(opts("org_innocent"))).resolves.toBeDefined();
  });

  it("a genuine provider fault still opens the shared breaker for everyone", async () => {
    const calls = captureStream();
    const helper = makeHelper();

    await helper.run(opts("org_a"));
    for (let i = 0; i < 5; i += 1) calls[0]?.onError?.({ error: statusError(503) });

    expect(await helper.breakerFor("stream").isOpen()).toBe(true);
    await expect(helper.run(opts("org_b"))).rejects.toThrow(AiProviderUnavailableException);
  });
});

/**
 * PRD-C153's concurrency half. A Redis outage used to `return true` — the cap
 * was waived at precisely the moment the shared counter stopped working, so
 * every pod let unbounded concurrent PAID calls through. The in-process counter
 * below the catch was already the right answer and was never reached.
 */
describe("the concurrency cap survives a Redis outage", () => {
  function brokenRedis() {
    return {
      incr: jest.fn().mockRejectedValue(new Error("redis down")),
      decr: jest.fn().mockRejectedValue(new Error("redis down")),
      expire: jest.fn().mockRejectedValue(new Error("redis down")),
    };
  }

  it("falls back to the in-process counter instead of waving the cap through", async () => {
    const redis = brokenRedis();
    const limiter = new AiConcurrencyLimiter(redis as never);

    const granted: boolean[] = [];
    for (let i = 0; i < AI_CONCURRENCY_CAP + 5; i += 1)
      granted.push(await limiter.acquire("org_1"));

    expect(granted.filter(Boolean)).toHaveLength(AI_CONCURRENCY_CAP);
    expect(granted.slice(AI_CONCURRENCY_CAP)).toEqual([false, false, false, false, false]);
  });

  it("releases a fallback slot against the counter that granted it", async () => {
    const redis = brokenRedis();
    const limiter = new AiConcurrencyLimiter(redis as never);

    for (let i = 0; i < AI_CONCURRENCY_CAP; i += 1) await limiter.acquire("org_1");
    expect(await limiter.acquire("org_1")).toBe(false);

    limiter.release("org_1");
    expect(await limiter.acquire("org_1")).toBe(true);
    expect(redis.decr).not.toHaveBeenCalled();
  });

  it("still uses Redis, and its release, while Redis is healthy", async () => {
    let count = 0;
    const redis = {
      incr: jest.fn().mockImplementation(() => Promise.resolve(++count)),
      decr: jest.fn().mockImplementation(() => Promise.resolve(--count)),
      expire: jest.fn().mockResolvedValue(1),
    };
    const limiter = new AiConcurrencyLimiter(redis as never);

    expect(await limiter.acquire("org_1")).toBe(true);
    limiter.release("org_1");
    expect(redis.decr).toHaveBeenCalledTimes(1);
  });
});
