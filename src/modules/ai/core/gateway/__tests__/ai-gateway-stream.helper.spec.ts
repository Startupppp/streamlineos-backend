import { streamText } from "ai";
import { AiGatewayStreamHelper } from "../ai-gateway-stream.helper";
import { AiConcurrencyLimiter } from "../ai-concurrency-limiter";
import { AiUsageService } from "../../services/ai-usage.service";
import { AiRequestCancelledException } from "../../services/ai-service-exceptions";
import { computeTokenCharge } from "../../billing/ai-model-pricing.constants";
import { resolveChatModelId } from "../../services/chat-assistant-model";
import type { AiCreditLedger } from "../credit-ledger.interface";

jest.mock("ai", () => ({
  streamText: jest.fn(),
  stepCountIs: jest.fn(),
}));

jest.mock("../../services/chat-assistant-model", () => ({
  resolveChatModel: () => "model-handle",
  resolveChatModelId: () => "gemini-1.5-pro-latest",
  CHAT_FEATURE: "chat.message",
}));

const ACTOR = { orgId: "org_1", userId: "user_1" };
const FEATURE = "blog.improve-writing";

interface StreamCall {
  abortSignal?: AbortSignal;
  onFinish?: (event: { usage?: { inputTokens?: number; outputTokens?: number } }) => Promise<void>;
  onError?: (event: { error: unknown }) => void;
}

function captureStream(finishReason: Promise<string>) {
  const calls: StreamCall[] = [];
  jest.mocked(streamText).mockImplementation((config: unknown) => {
    calls.push(config as StreamCall);
    return { finishReason } as unknown as ReturnType<typeof streamText>;
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

function makeHelper(ledger: jest.Mocked<AiCreditLedger>, usage: jest.Mocked<AiUsageService>) {
  const limiter = new AiConcurrencyLimiter();
  return { helper: new AiGatewayStreamHelper(ledger, usage, limiter), limiter };
}

function opts(overrides: Record<string, unknown> = {}) {
  return {
    actor: ACTOR,
    feature: FEATURE,
    prompt: { system: "sys", user: "user" },
    ...overrides,
  };
}

describe("AiGatewayStreamHelper — a streamed turn bills like a buffered one", () => {
  beforeEach(() => jest.clearAllMocks());

  it("reserves before the paid call, never after", async () => {
    const calls = captureStream(Promise.resolve("stop"));
    const ledger = makeLedger();
    const { helper } = makeHelper(ledger, makeUsage());

    await helper.run(opts());

    expect(ledger.reserve).toHaveBeenCalledTimes(1);
    expect(ledger.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(streamText).mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(calls).toHaveLength(1);
  });

  it("settles the token-metered charge, not the reserve ceiling", async () => {
    const calls = captureStream(Promise.resolve("stop"));
    const ledger = makeLedger();
    const { helper } = makeHelper(ledger, makeUsage());

    await helper.run(opts());
    await calls[0]?.onFinish?.({ usage: { inputTokens: 1200, outputTokens: 400 } });

    const expected = computeTokenCharge(resolveChatModelId(), 1200, 400);
    expect(ledger.settle).toHaveBeenCalledWith(
      9,
      expect.objectContaining({
        orgId: "org_1",
        actualMilli: expected.milliCredits,
        promptTokens: 1200,
        completionTokens: 400,
      }),
    );
    expect(Number.isInteger(expected.milliCredits)).toBe(true);
  });

  it("records ttft and application overhead onto the settled usage row", async () => {
    const calls = captureStream(Promise.resolve("stop"));
    const usage = makeUsage();
    const { helper } = makeHelper(makeLedger(), usage);

    await helper.run(opts());
    await calls[0]?.onFinish?.({ usage: { inputTokens: 10, outputTokens: 5 } });

    const tracked = usage.track.mock.calls.at(-1)?.[0];
    expect(tracked?.appOverheadMs).toEqual(expect.any(Number));
    expect(tracked?.timings).toBeDefined();
  });

  it("releases the slot and the reservation when the stream dies before finishing", async () => {
    captureStream(Promise.reject(new Error("provider gone")));
    const ledger = makeLedger();
    const { helper, limiter } = makeHelper(ledger, makeUsage());
    const release = jest.spyOn(limiter, "release");

    await helper.run(opts());
    await new Promise((resolve) => setImmediate(resolve));

    expect(ledger.settle).not.toHaveBeenCalled();
    expect(ledger.release).toHaveBeenCalledWith(9, "stream_aborted_no_settle", "org_1");
    expect(release).toHaveBeenCalledWith("org_1");
  });

  /**
   * Answers the question the missing `idempotencyKey` raises: none of the five
   * `reserve` call sites passes one, so a retried stream cannot be deduplicated
   * by key. It does not need to be. Every failure path releases, and `settle`
   * debits measured tokens rather than the reserve ceiling, so the abandoned
   * turn costs nothing and only the turn that actually ran is billed.
   */
  it("a retried turn reserves again and the abandoned one is refunded, so no turn is charged twice", async () => {
    const ledger = makeLedger();
    const { helper } = makeHelper(ledger, makeUsage());

    captureStream(Promise.reject(new Error("provider gone")));
    await helper.run(opts());
    await new Promise((resolve) => setImmediate(resolve));

    const retry = captureStream(Promise.resolve("stop"));
    await helper.run(opts());
    await retry[0]?.onFinish?.({ usage: { inputTokens: 30, outputTokens: 10 } });

    expect(ledger.reserve).toHaveBeenCalledTimes(2);
    expect(ledger.release).toHaveBeenCalledTimes(1);
    expect(ledger.settle).toHaveBeenCalledTimes(1);
    expect(ledger.settle).toHaveBeenCalledWith(
      9,
      expect.objectContaining({
        actualMilli: computeTokenCharge(resolveChatModelId(), 30, 10).milliCredits,
      }),
    );
  });

  /**
   * The residual, recorded rather than claimed: a settle that fails is logged and
   * the reservation is left RESERVED, so the expiry sweep refunds a turn that did
   * consume tokens. That under-charges; releasing here instead would refund it
   * immediately, which is the same leak sooner. Neither is a double charge.
   */
  it("a settle that fails leaves the reservation for the sweep instead of crashing the stream", async () => {
    const calls = captureStream(Promise.resolve("stop"));
    const ledger = makeLedger();
    ledger.settle.mockRejectedValue(new Error("ledger unavailable"));
    const { helper } = makeHelper(ledger, makeUsage());

    await helper.run(opts());
    await expect(
      calls[0]?.onFinish?.({ usage: { inputTokens: 10, outputTokens: 5 } }),
    ).resolves.toBeUndefined();

    expect(ledger.settle).toHaveBeenCalledTimes(1);
    expect(ledger.release).not.toHaveBeenCalled();
  });

  it("settles once even if onFinish is invoked twice", async () => {
    const calls = captureStream(Promise.resolve("stop"));
    const ledger = makeLedger();
    const { helper } = makeHelper(ledger, makeUsage());

    await helper.run(opts());
    await calls[0]?.onFinish?.({ usage: { inputTokens: 10, outputTokens: 5 } });
    await calls[0]?.onFinish?.({ usage: { inputTokens: 10, outputTokens: 5 } });

    expect(ledger.settle).toHaveBeenCalledTimes(1);
  });

  it("hands the abort signal to the provider stream", async () => {
    const calls = captureStream(Promise.resolve("stop"));
    const { helper } = makeHelper(makeLedger(), makeUsage());
    const controller = new AbortController();

    await helper.run(opts({ signal: controller.signal }));

    expect(calls[0]?.abortSignal).toBe(controller.signal);
  });

  it("a caller who already left never reserves and never opens a stream", async () => {
    const calls = captureStream(Promise.resolve("stop"));
    const ledger = makeLedger();
    const { helper } = makeHelper(ledger, makeUsage());
    const controller = new AbortController();
    controller.abort();

    await expect(helper.run(opts({ signal: controller.signal }))).rejects.toBeInstanceOf(
      AiRequestCancelledException,
    );
    expect(ledger.reserve).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("an aborted stream releases rather than settles", async () => {
    const controller = new AbortController();
    captureStream(Promise.reject(new Error("aborted")));
    const ledger = makeLedger();
    const { helper } = makeHelper(ledger, makeUsage());

    await helper.run(opts({ signal: controller.signal }));
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));

    expect(ledger.settle).not.toHaveBeenCalled();
    expect(ledger.release).toHaveBeenCalledWith(9, "stream_aborted_no_settle", "org_1");
  });

  it("an open breaker refuses before reserving a credit or a slot", async () => {
    const calls = captureStream(Promise.resolve("stop"));
    const ledger = makeLedger();
    const { helper } = makeHelper(ledger, makeUsage());
    const breaker = helper.breakerFor("stream");
    for (let i = 0; i < 5; i += 1) breaker.recordFailure();

    await expect(helper.run(opts())).rejects.toThrow();
    expect(ledger.reserve).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("gives each breaker key exactly one instance, so the local counter is not split", () => {
    const { helper } = makeHelper(makeLedger(), makeUsage());

    expect(helper.breakerFor("kb")).toBe(helper.breakerFor("kb"));
    expect(helper.breakerFor("kb")).not.toBe(helper.breakerFor("stream"));
  });
});
