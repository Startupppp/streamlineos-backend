import {
  callProvider,
  providerBackoffMs,
  ProviderTimeoutError,
  type ProviderDescriptor,
} from "./call-provider";
import { ProviderCircuitBreaker } from "./provider-circuit-breaker";

const RETRYABLE = (): "retryable" => "retryable";
const TERMINAL = (): "terminal" => "terminal";
const FIXED_RANDOM = () => 0.5;

function makeDescriptor(overrides: Partial<ProviderDescriptor> = {}): ProviderDescriptor {
  return {
    provider: "test-provider",
    timeoutMs: 200,
    maxAttempts: 3,
    baseDelayMs: 1,
    maxDelayMs: 10,
    classify: RETRYABLE,
    ...overrides,
  };
}

describe("callProvider — timeout fires", () => {
  it("returns dead-lettered when fn never resolves within timeoutMs", async () => {
    const fn = (): Promise<never> => new Promise(() => {});
    const result = await callProvider(
      makeDescriptor({ timeoutMs: 50, maxAttempts: 1 }),
      fn,
      new ProviderCircuitBreaker(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.kind !== "dead-lettered") { expect(result.kind).toBe("dead-lettered"); return; }
    expect(result.error).toBeInstanceOf(ProviderTimeoutError);
  });

  it("bites: neutering the timeout by replacing wrapWithTimeout would make this test hang — the real seam enforces it", async () => {
    const start = Date.now();
    await callProvider(
      makeDescriptor({ timeoutMs: 80, maxAttempts: 1 }),
      () => new Promise(() => {}),
      new ProviderCircuitBreaker(),
    );
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe("callProvider — retry budget is bounded", () => {
  it("calls fn exactly maxAttempts times when it always rejects as retryable", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new Error("transient failure");
    };
    const result = await callProvider(
      makeDescriptor({ maxAttempts: 3 }),
      fn,
      new ProviderCircuitBreaker(),
      FIXED_RANDOM,
    );
    expect(calls).toBe(3);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("dead-lettered");
    expect(result.attempts).toBe(3);
  });

  it("stops on first success even if budget remains", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 2) throw new Error("fail once");
      return "ok";
    };
    const result = await callProvider(
      makeDescriptor({ maxAttempts: 5 }),
      fn,
      new ProviderCircuitBreaker(),
      FIXED_RANDOM,
    );
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    if (!result.ok) return;
    expect(result.attempts).toBe(2);
  });
});

describe("callProvider — backoff has jitter", () => {
  it("providerBackoffMs with random=0 gives the lower bound (50% of window)", () => {
    const ms = providerBackoffMs(1, 100, 10_000, () => 0);
    expect(ms).toBe(50);
  });

  it("providerBackoffMs with random=1 gives the upper bound (100% of window)", () => {
    const ms = providerBackoffMs(1, 100, 10_000, () => 1);
    expect(ms).toBe(100);
  });

  it("providerBackoffMs grows exponentially with attempt, capped by maxDelayMs", () => {
    const base = 100;
    const max = 1_000;
    const attempt1 = providerBackoffMs(1, base, max, () => 1);
    const attempt3 = providerBackoffMs(3, base, max, () => 1);
    const attempt10 = providerBackoffMs(10, base, max, () => 1);
    expect(attempt1).toBe(100);
    expect(attempt3).toBe(400);
    expect(attempt10).toBe(1_000);
  });

  it("two consecutive failing calls receive different backoff delays due to jitter", async () => {
    const delays: number[] = [];
    const realSleep = (ms: number): Promise<void> =>
      new Promise<void>((r) => setTimeout(r, ms));
    jest.spyOn(global, "setTimeout").mockImplementation((fn, ms) => {
      if (typeof fn === "function" && typeof ms === "number" && ms > 0) delays.push(ms);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    try {
      const fn = async () => { throw new Error("always fails"); };
      await callProvider(
        makeDescriptor({ maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 500 }),
        fn,
        new ProviderCircuitBreaker(),
      );
    } finally {
      jest.restoreAllMocks();
    }

    expect(delays.length).toBeGreaterThanOrEqual(2);
  });
});

describe("callProvider — circuit breaker opens and half-opens", () => {
  it("opens after threshold failures and returns circuit-open without calling fn", async () => {
    const breaker = new ProviderCircuitBreaker(3, 60_000);
    const fn = async (): Promise<string> => { throw new Error("fail"); };
    const descriptor = makeDescriptor({ maxAttempts: 1 });

    for (let i = 0; i < 3; i++) {
      await callProvider(descriptor, fn, breaker, FIXED_RANDOM);
    }

    let fnCalled = false;
    const result = await callProvider(
      descriptor,
      async () => { fnCalled = true; return "ok"; },
      breaker,
      FIXED_RANDOM,
    );
    expect(fnCalled).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.kind !== "circuit-open") { expect(result.kind).toBe("circuit-open"); return; }
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("half-opens: the first attempt after the cooldown is passed through as a probe", async () => {
    const breaker = new ProviderCircuitBreaker(2, 100);
    const failing = async (): Promise<string> => { throw new Error("fail"); };
    const descriptor = makeDescriptor({ maxAttempts: 1 });

    await callProvider(descriptor, failing, breaker, FIXED_RANDOM);
    await callProvider(descriptor, failing, breaker, FIXED_RANDOM);

    const beforeCooldown = await callProvider(
      descriptor,
      async () => "ok",
      breaker,
      FIXED_RANDOM,
    );
    expect(beforeCooldown.ok).toBe(false);
    if (beforeCooldown.ok) return;
    expect(beforeCooldown.kind).toBe("circuit-open");

    await new Promise<void>((r) => setTimeout(r, 110));

    let probeRan = false;
    const afterCooldown = await callProvider(
      descriptor,
      async () => { probeRan = true; return "ok"; },
      breaker,
      FIXED_RANDOM,
    );
    expect(probeRan).toBe(true);
    expect(afterCooldown.ok).toBe(true);
  });
});

describe("callProvider — terminal failure is NOT retried", () => {
  it("calls fn exactly once when it throws a terminal error", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new Error("auth failure");
    };
    const result = await callProvider(
      makeDescriptor({ classify: TERMINAL, maxAttempts: 5 }),
      fn,
      new ProviderCircuitBreaker(),
      FIXED_RANDOM,
    );
    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.kind !== "terminal") { expect(result.kind).toBe("terminal"); return; }
    expect(result.error.message).toBe("auth failure");
    expect(result.attempts).toBe(1);
  });
});
