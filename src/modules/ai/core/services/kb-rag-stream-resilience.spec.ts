jest.mock("ai", () => ({ streamText: jest.fn() }));

jest.mock("./chat-assistant-model", () => ({
  resolveChatModel: jest.fn(() => "test-model"),
  resolveChatModelId: jest.fn(() => "test-model-id"),
}));

import { ServiceUnavailableException } from "@nestjs/common";
import { streamText } from "ai";
import { AiProviderUnavailableException } from "./ai-service-exceptions";
import { KbRagService } from "./kb-rag.service";
import { AI_STREAM_BREAKER_FAILURE_THRESHOLD } from "../streaming/ai-stream-breaker";
import type { KbAnswerSource } from "./kb-rag-retrieval.service";

const ORG_ID = "org_1";
const QUESTION = "How do I reset my password?";

const SOURCES: KbAnswerSource[] = [
  {
    articleId: 10,
    title: "Getting Started",
    slug: "getting-started",
    attachmentId: null,
    attachmentName: null,
    similarity: 0.85,
  },
];

interface StreamOpts {
  maxRetries?: number;
  abortSignal?: AbortSignal;
  onChunk?: () => void;
  onError?: (event: { error: unknown }) => void;
  onFinish?: (event: {
    usage?: { inputTokens?: number; outputTokens?: number };
  }) => Promise<void> | void;
}

function buildHarness() {
  const retrieval = {
    isEmbeddingConfigured: jest.fn().mockReturnValue(true),
    hasPublishedPublicArticles: jest.fn().mockResolvedValue(true),
    retrieveContext: jest.fn().mockResolvedValue({
      sources: SOURCES,
      system: "system prompt",
      userContext: "context excerpt",
    }),
    recordNoContext: jest.fn(),
  };
  const gateway = { invokeText: jest.fn(), isEmbeddingConfigured: jest.fn().mockReturnValue(true) };
  const ledger = {
    reserve: jest.fn().mockResolvedValue({ reservationId: 42 }),
    settle: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  };
  const usageSvc = { track: jest.fn().mockResolvedValue(undefined) };
  const limiter = { acquire: jest.fn().mockResolvedValue(true), release: jest.fn() };

  const service = new KbRagService(
    retrieval as never,
    gateway as never,
    ledger as never,
    usageSvc as never,
    limiter as never,
  );

  return { service, retrieval, gateway, ledger, usageSvc, limiter };
}

function captureStreamOpts(): () => StreamOpts {
  let captured: StreamOpts = {};
  (streamText as jest.Mock).mockImplementation((opts: StreamOpts) => {
    captured = opts;
    return { finishReason: new Promise<string>(() => undefined) };
  });
  return () => captured;
}

describe("KbRagService — the public KB stream has a breaker and it trips", () => {
  beforeEach(() => jest.clearAllMocks());

  it("opens after the threshold of provider faults and rejects the next request", async () => {
    const opts = captureStreamOpts();
    const { service } = buildHarness();

    for (let i = 0; i < AI_STREAM_BREAKER_FAILURE_THRESHOLD; i += 1) {
      await service.streamAnswer({ orgId: ORG_ID, question: QUESTION });
      opts().onError?.({ error: new Error("upstream 503") });
    }

    await expect(service.streamAnswer({ orgId: ORG_ID, question: QUESTION })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("short-circuits BEFORE retrieval, so an open breaker spends nothing on embeddings or credits", async () => {
    const opts = captureStreamOpts();
    const { service, retrieval, ledger, limiter } = buildHarness();

    for (let i = 0; i < AI_STREAM_BREAKER_FAILURE_THRESHOLD; i += 1) {
      await service.streamAnswer({ orgId: ORG_ID, question: QUESTION });
      opts().onError?.({ error: new Error("upstream 503") });
    }

    retrieval.retrieveContext.mockClear();
    retrieval.hasPublishedPublicArticles.mockClear();
    ledger.reserve.mockClear();
    limiter.acquire.mockClear();

    await expect(service.streamAnswer({ orgId: ORG_ID, question: QUESTION })).rejects.toThrow(AiProviderUnavailableException);

    expect(retrieval.hasPublishedPublicArticles).not.toHaveBeenCalled();
    expect(retrieval.retrieveContext).not.toHaveBeenCalled();
    expect(ledger.reserve).not.toHaveBeenCalled();
    expect(limiter.acquire).not.toHaveBeenCalled();
  });

  it("also short-circuits the buffered sibling, so an open breaker is not routed around", async () => {
    const opts = captureStreamOpts();
    const { service, retrieval } = buildHarness();

    for (let i = 0; i < AI_STREAM_BREAKER_FAILURE_THRESHOLD; i += 1) {
      await service.streamAnswer({ orgId: ORG_ID, question: QUESTION });
      opts().onError?.({ error: new Error("upstream 503") });
    }
    retrieval.hasPublishedPublicArticles.mockClear();

    await expect(service.answerQuestion({ orgId: ORG_ID, question: QUESTION })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(retrieval.hasPublishedPublicArticles).not.toHaveBeenCalled();
  });

  it("does not count a client abort as a provider fault", async () => {
    const opts = captureStreamOpts();
    const { service } = buildHarness();
    const controller = new AbortController();
    controller.abort();

    for (let i = 0; i < AI_STREAM_BREAKER_FAILURE_THRESHOLD * 2; i += 1) {
      await service.streamAnswer({ orgId: ORG_ID, question: QUESTION }, controller.signal);
      opts().onError?.({ error: Object.assign(new Error("aborted"), { name: "AbortError" }) });
    }

    await expect(
      service.streamAnswer({ orgId: ORG_ID, question: QUESTION }),
    ).resolves.toMatchObject({ hasContext: true });
  });

  it("a finished stream resets the failure count", async () => {
    const opts = captureStreamOpts();
    const { service } = buildHarness();

    for (let i = 0; i < AI_STREAM_BREAKER_FAILURE_THRESHOLD - 1; i += 1) {
      await service.streamAnswer({ orgId: ORG_ID, question: QUESTION });
      opts().onError?.({ error: new Error("upstream 503") });
    }

    await service.streamAnswer({ orgId: ORG_ID, question: QUESTION });
    await opts().onFinish?.({ usage: { inputTokens: 10, outputTokens: 4 } });

    for (let i = 0; i < AI_STREAM_BREAKER_FAILURE_THRESHOLD - 1; i += 1) {
      await service.streamAnswer({ orgId: ORG_ID, question: QUESTION });
      opts().onError?.({ error: new Error("upstream 503") });
    }

    await expect(
      service.streamAnswer({ orgId: ORG_ID, question: QUESTION }),
    ).resolves.toMatchObject({ hasContext: true });
  });
});

describe("KbRagService — abort, deadline and retry reach the provider call", () => {
  beforeEach(() => jest.clearAllMocks());

  it("forwards the caller's signal so a disconnect stops the spend at the provider", async () => {
    const opts = captureStreamOpts();
    const { service } = buildHarness();
    const controller = new AbortController();

    await service.streamAnswer({ orgId: ORG_ID, question: QUESTION }, controller.signal);

    expect(opts().abortSignal).toBe(controller.signal);
  });

  it("omits the signal key entirely when the caller supplies none", async () => {
    const opts = captureStreamOpts();
    const { service } = buildHarness();

    await service.streamAnswer({ orgId: ORG_ID, question: QUESTION });

    expect(opts().abortSignal).toBeUndefined();
  });

  it("bounds retries with the shared policy — the SDK replays only the pre-stream dispatch", async () => {
    const opts = captureStreamOpts();
    const { service } = buildHarness();

    await service.streamAnswer({ orgId: ORG_ID, question: QUESTION });

    expect(opts().maxRetries).toBe(2);
  });

  it("dispatches the paid streaming call exactly once per turn", async () => {
    captureStreamOpts();
    const { service, ledger } = buildHarness();

    await service.streamAnswer({ orgId: ORG_ID, question: QUESTION });

    expect((streamText as jest.Mock).mock.calls).toHaveLength(1);
    expect(ledger.reserve).toHaveBeenCalledTimes(1);
  });

  it("settles the reservation exactly once even if onFinish is invoked twice", async () => {
    const opts = captureStreamOpts();
    const { service, ledger } = buildHarness();

    await service.streamAnswer({ orgId: ORG_ID, question: QUESTION });
    await opts().onFinish?.({ usage: { inputTokens: 10, outputTokens: 4 } });
    await opts().onFinish?.({ usage: { inputTokens: 10, outputTokens: 4 } });

    expect(ledger.settle).toHaveBeenCalledTimes(1);
  });
});

describe("KbRagService — first-token latency and pre-dispatch overhead are recorded", () => {
  beforeEach(() => jest.clearAllMocks());

  it("records ttft and app overhead on the settled usage row", async () => {
    const opts = captureStreamOpts();
    const { service, usageSvc } = buildHarness();

    await service.streamAnswer({ orgId: ORG_ID, question: QUESTION });
    opts().onChunk?.();
    await opts().onFinish?.({ usage: { inputTokens: 10, outputTokens: 4 } });

    const tracked = usageSvc.track.mock.calls[0]?.[0] as {
      ttftMs?: number;
      appOverheadMs?: number;
      feature?: string;
    };
    expect(tracked.feature).toBe("kb.public-ask");
    expect(typeof tracked.ttftMs).toBe("number");
    expect(typeof tracked.appOverheadMs).toBe("number");
  });

  it("omits ttft when no chunk ever arrived rather than reporting a fabricated zero", async () => {
    const opts = captureStreamOpts();
    const { service, usageSvc } = buildHarness();

    await service.streamAnswer({ orgId: ORG_ID, question: QUESTION });
    await opts().onFinish?.({ usage: { inputTokens: 10, outputTokens: 0 } });

    const tracked = usageSvc.track.mock.calls[0]?.[0] as { ttftMs?: number };
    expect(tracked.ttftMs).toBeUndefined();
  });
});

describe("KbRagService — citation integrity on the streaming path", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns the retrieved sources alongside the stream so the route can emit them", async () => {
    captureStreamOpts();
    const { service } = buildHarness();

    const result = await service.streamAnswer({ orgId: ORG_ID, question: QUESTION });

    expect(result.hasContext).toBe(true);
    expect(result.sources).toEqual(SOURCES);
  });
});
