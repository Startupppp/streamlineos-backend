jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db),
  runInNewTenantTransaction: (db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn(db),
}));

jest.mock("ai", () => ({
  streamText: jest.fn(() => ({ pipeTextStreamToResponse: jest.fn() })),
}));

jest.mock("./chat-assistant-model", () => ({
  resolveChatModel: jest.fn(() => "test-model"),
  resolveChatModelId: jest.fn(() => "test-model-id"),
}));

import { ServiceUnavailableException } from "@nestjs/common";
import { streamText } from "ai";
import { InsufficientAiCreditsException } from "../../../../common/http/api-exceptions";
import { logger } from "../../../../common/logger/logger.service";
import { Test, type TestingModule } from "@nestjs/testing";
import { KbRagService } from "./kb-rag.service";
import { KbRagRetrievalService } from "./kb-rag-retrieval.service";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { AiUsageService } from "./ai-usage.service";
import { AI_CREDIT_LEDGER } from "../gateway/credit-ledger.interface";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { AiConcurrencyLimiter } from "../gateway/ai-concurrency-limiter";

const makeGatewayOk = (text: string) => ({
  ok: true as const,
  data: text,
  model: "gpt-4o-mini",
  latencyMs: 10,
  correlationId: "corr-1",
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
});

const makeGatewayFail = (
  kind: "quota_exceeded" | "provider_unavailable" | "not_configured" | "invalid_output",
  message = "error",
) => ({
  ok: false as const,
  kind,
  message,
  correlationId: "corr-err",
});

const makeEmbedOk = () => ({
  ok: true as const,
  vector: new Array(4).fill(0.01),
  vectorLiteral: "[0.01,0.01,0.01,0.01]",
});

const makeEmbedFail = (kind: "quota_exceeded" | "provider_unavailable", message = "error") => ({
  ok: false as const,
  kind,
  message,
  correlationId: "corr-embed-err",
});

const chunkRow = {
  id: 1,
  articleId: 10,
  attachmentId: null,
  source: "body",
  content: "Here is some helpful content.",
  title: "Getting Started",
  slug: "getting-started",
  attachmentName: null,
  similarity: 0.85,
};

const mockDb = {
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  innerJoin: jest.fn().mockReturnThis(),
  leftJoin: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockResolvedValue([chunkRow]),
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockResolvedValue(undefined),
  catch: jest.fn(),
};

const mockLedger = {
  reserve: jest.fn(),
  settle: jest.fn(),
  release: jest.fn(),
};

const mockUsageSvc = {
  track: jest.fn(),
};

const mockGateway = {
  invokeText: jest.fn(),
  embedQueryWithCredit: jest.fn().mockResolvedValue(makeEmbedOk()),
  isEmbeddingConfigured: jest.fn().mockReturnValue(true),
};

const ORG_ID = "org1";
const QUESTION = "How do I reset?";

describe("KbRagService", () => {
  let service: KbRagService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.limit.mockResolvedValue([chunkRow]);
    mockGateway.embedQueryWithCredit.mockResolvedValue(makeEmbedOk());
    mockGateway.isEmbeddingConfigured.mockReturnValue(true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KbRagRetrievalService,
        KbRagService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AiGatewayService, useValue: mockGateway },
        { provide: AI_CREDIT_LEDGER, useValue: mockLedger },
        { provide: AiUsageService, useValue: mockUsageSvc },
        { provide: AiConcurrencyLimiter, useValue: { acquire: jest.fn().mockResolvedValue(true), release: jest.fn() } },
      ],
    }).compile();
    service = module.get(KbRagService);
  });

  describe("answerQuestion", () => {
    it("returns no-context answer when org has no published public articles", async () => {
      mockDb.limit.mockResolvedValueOnce([]).mockResolvedValue([chunkRow]);

      const result = await service.answerQuestion({
        orgId: ORG_ID,
        question: QUESTION,
      });

      expect(result.hasContext).toBe(false);
      expect(mockGateway.embedQueryWithCredit).not.toHaveBeenCalled();
      expect(mockGateway.invokeText).not.toHaveBeenCalled();
    });

    it("calls embedQueryWithCredit with charge: true before invoking LLM", async () => {
      mockDb.limit
        .mockResolvedValueOnce([{ id: 99 }])
        .mockResolvedValue([chunkRow]);
      mockGateway.invokeText.mockResolvedValueOnce(makeGatewayOk("Sure, here is how."));

      const result = await service.answerQuestion({
        orgId: ORG_ID,
        question: QUESTION,
      });

      expect(result.hasContext).toBe(true);
      expect(mockGateway.embedQueryWithCredit).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: ORG_ID, charge: true, feature: "kb.public-embedding" }),
      );
      const [call] = mockGateway.invokeText.mock.calls;
      expect(call[0].charge).toBe(true);
      expect(call[0].actor).toEqual({ orgId: ORG_ID, userId: null });
    });

    it("throws InsufficientAiCreditsException when embedding returns quota_exceeded", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: 99 }]).mockResolvedValue([chunkRow]);
      mockGateway.embedQueryWithCredit.mockResolvedValueOnce(
        makeEmbedFail("quota_exceeded", "Insufficient AI credits"),
      );

      await expect(
        service.answerQuestion({ orgId: ORG_ID, question: QUESTION }),
      ).rejects.toThrow(InsufficientAiCreditsException);
      expect(mockGateway.invokeText).not.toHaveBeenCalled();
    });

    it("answers from lexical ranking when embedding returns provider_unavailable, because an embedding outage must degrade retrieval rather than 503 the whole question", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: 99 }]).mockResolvedValue([chunkRow]);
      mockGateway.embedQueryWithCredit.mockResolvedValueOnce(
        makeEmbedFail("provider_unavailable"),
      );
      mockGateway.invokeText.mockResolvedValueOnce(makeGatewayOk("Here is how."));

      const result = await service.answerQuestion({
        orgId: ORG_ID,
        question: QUESTION,
      });

      expect(result.hasContext).toBe(true);
      expect(mockGateway.invokeText).toHaveBeenCalled();
    });

    it("maps invokeText quota_exceeded to InsufficientAiCreditsException", async () => {
      mockDb.limit
        .mockResolvedValueOnce([{ id: 99 }])
        .mockResolvedValue([chunkRow]);
      mockGateway.invokeText.mockResolvedValueOnce(
        makeGatewayFail("quota_exceeded", "Insufficient AI credits"),
      );

      await expect(
        service.answerQuestion({ orgId: ORG_ID, question: QUESTION }),
      ).rejects.toThrow(InsufficientAiCreditsException);
    });

    it("throws ServiceUnavailableException on invokeText provider_unavailable", async () => {
      mockDb.limit
        .mockResolvedValueOnce([{ id: 99 }])
        .mockResolvedValue([chunkRow]);
      mockGateway.invokeText.mockResolvedValueOnce(
        makeGatewayFail("provider_unavailable"),
      );

      await expect(
        service.answerQuestion({ orgId: ORG_ID, question: QUESTION }),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it("isEmbeddingConfigured delegates to gateway", () => {
      expect(service.isEmbeddingConfigured()).toBe(true);
      expect(mockGateway.isEmbeddingConfigured).toHaveBeenCalled();
    });
  });

  describe("streamAnswer — anonymous traffic must not reach the provider", () => {
    const mockedStreamText = jest.mocked(streamText);

    it("answers from a constant, with no provider call, when the org has no public articles", async () => {
      mockDb.limit.mockResolvedValueOnce([]).mockResolvedValue([chunkRow]);

      const result = await service.streamAnswer({ orgId: ORG_ID, question: QUESTION });

      expect(result.hasContext).toBe(false);
      expect(mockedStreamText).not.toHaveBeenCalled();
      expect(mockGateway.embedQueryWithCredit).not.toHaveBeenCalled();
      expect(mockLedger.reserve).not.toHaveBeenCalled();
    });

    it("answers from a constant, with no provider call, when retrieval returns no chunks", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: 99 }]).mockResolvedValue([]);

      const result = await service.streamAnswer({ orgId: ORG_ID, question: QUESTION });

      expect(result.hasContext).toBe(false);
      expect(mockedStreamText).not.toHaveBeenCalled();
      expect(mockLedger.reserve).not.toHaveBeenCalled();
    });

    it("returns the same wording the non-streaming path returns", async () => {
      mockDb.limit.mockResolvedValueOnce([]).mockResolvedValue([chunkRow]);
      const streamed = await service.streamAnswer({ orgId: ORG_ID, question: QUESTION });

      mockDb.limit.mockResolvedValueOnce([]).mockResolvedValue([chunkRow]);
      const plain = await service.answerQuestion({ orgId: ORG_ID, question: QUESTION });

      expect(streamed.hasContext).toBe(false);
      if (streamed.hasContext) throw new Error("expected the no-context branch");
      expect(streamed.answer).toBe(plain.answer);
    });
  });

  describe("bite proof — embedQueryWithCredit charge:true assertion", () => {
    it("FAILS when embedQueryWithCredit is neutered to not check charge", async () => {
      mockDb.limit
        .mockResolvedValueOnce([{ id: 99 }])
        .mockResolvedValue([chunkRow]);
      mockGateway.invokeText.mockResolvedValueOnce(makeGatewayOk("Answer."));

      await service.answerQuestion({ orgId: ORG_ID, question: QUESTION });

      expect(mockGateway.embedQueryWithCredit).toHaveBeenCalledWith(
        expect.objectContaining({ charge: true }),
      );
    });
  });
});

describe("KbRagService — streamAnswer with context: credit reserve precedes streamText", () => {
  const mockedStreamText = jest.mocked(streamText);

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.limit.mockResolvedValue([chunkRow]);
    mockGateway.embedQueryWithCredit.mockResolvedValue(makeEmbedOk());
    mockGateway.isEmbeddingConfigured.mockReturnValue(true);
  });

  let service: import("./kb-rag.service").KbRagService;

  beforeEach(async () => {
    const { Test } = await import("@nestjs/testing");
    const { KbRagService } = await import("./kb-rag.service");
    const { KbRagRetrievalService } = await import("./kb-rag-retrieval.service");
    const { AiGatewayService } = await import("../gateway/ai-gateway.service");
    const { AI_CREDIT_LEDGER } = await import("../gateway/credit-ledger.interface");
    const { AiUsageService } = await import("./ai-usage.service");
    const { DRIZZLE } = await import("../../../../db/drizzle.constants");

    const module = await Test.createTestingModule({
      providers: [
        KbRagRetrievalService,
        KbRagService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AiGatewayService, useValue: mockGateway },
        { provide: AI_CREDIT_LEDGER, useValue: mockLedger },
        { provide: AiUsageService, useValue: mockUsageSvc },
        { provide: AiConcurrencyLimiter, useValue: { acquire: jest.fn().mockResolvedValue(true), release: jest.fn() } },
      ],
    }).compile();
    service = module.get(KbRagService);
  });

  it("BITE PROOF — reserve is called before streamText when context is available", async () => {
    const callOrder: string[] = [];
    mockDb.limit
      .mockResolvedValueOnce([{ id: 99 }])
      .mockResolvedValue([chunkRow]);
    mockLedger.reserve.mockImplementation(async () => {
      callOrder.push("reserve");
      return { reservationId: 7 };
    });
    mockedStreamText.mockImplementation(() => {
      callOrder.push("stream");
      return { pipeTextStreamToResponse: jest.fn() } as never;
    });

    const result = await service.streamAnswer({ orgId: ORG_ID, question: QUESTION });

    expect(result.hasContext).toBe(true);
    expect(callOrder[0]).toBe("reserve");
    expect(callOrder[1]).toBe("stream");
  });

  it("BITE PROOF — embedQueryWithCredit called with charge:true on the streaming path", async () => {
    mockDb.limit
      .mockResolvedValueOnce([{ id: 99 }])
      .mockResolvedValue([chunkRow]);
    mockLedger.reserve.mockResolvedValue({ reservationId: 7 });
    mockedStreamText.mockImplementation(() => ({ pipeTextStreamToResponse: jest.fn() } as never));

    await service.streamAnswer({ orgId: ORG_ID, question: QUESTION });

    expect(mockGateway.embedQueryWithCredit).toHaveBeenCalledWith(
      expect.objectContaining({ charge: true, feature: "kb.public-embedding" }),
    );
  });
});

describe("KbRagService — the concurrency limiter is a required dependency", () => {
  it("fails to wire when no limiter provider is registered, rather than silently bypassing the cap", async () => {
    await expect(
      Test.createTestingModule({
        providers: [
          KbRagRetrievalService,
          KbRagService,
          { provide: DRIZZLE, useValue: mockDb },
          { provide: AiGatewayService, useValue: mockGateway },
          { provide: AI_CREDIT_LEDGER, useValue: mockLedger },
          { provide: AiUsageService, useValue: mockUsageSvc },
        ],
      }).compile(),
    ).rejects.toThrow(/AiConcurrencyLimiter/);
  });
});

describe("KbRagService — streamAnswer: per-org concurrency cap", () => {
  const mockedStreamText = jest.mocked(streamText);

  beforeEach(() => jest.clearAllMocks());

  it("throws ServiceUnavailableException without calling streamText or reserving credits when concurrency cap is exceeded", async () => {
    const mockConcurrencyLimiter = {
      acquire: jest.fn().mockResolvedValue(false),
      release: jest.fn(),
    };
    mockDb.limit
      .mockResolvedValueOnce([{ id: 99 }])
      .mockResolvedValue([chunkRow]);
    mockGateway.embedQueryWithCredit.mockResolvedValue(makeEmbedOk());

    const { Test } = await import("@nestjs/testing");
    const { KbRagService } = await import("./kb-rag.service");
    const { KbRagRetrievalService } = await import("./kb-rag-retrieval.service");
    const { AiGatewayService } = await import("../gateway/ai-gateway.service");
    const { AI_CREDIT_LEDGER } = await import("../gateway/credit-ledger.interface");
    const { AiUsageService } = await import("./ai-usage.service");
    const { DRIZZLE } = await import("../../../../db/drizzle.constants");
    const { AiConcurrencyLimiter } = await import("../gateway/ai-concurrency-limiter");

    const module = await Test.createTestingModule({
      providers: [
        KbRagRetrievalService,
        KbRagService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AiGatewayService, useValue: mockGateway },
        { provide: AI_CREDIT_LEDGER, useValue: mockLedger },
        { provide: AiUsageService, useValue: mockUsageSvc },
        { provide: AiConcurrencyLimiter, useValue: mockConcurrencyLimiter },
      ],
    }).compile();

    const svc = module.get(KbRagService);

    await expect(
      svc.streamAnswer({ orgId: ORG_ID, question: QUESTION }),
    ).rejects.toThrow("Too many concurrent AI requests for this organization");

    expect(mockedStreamText).not.toHaveBeenCalled();
    expect(mockLedger.reserve).not.toHaveBeenCalled();
  });

  it("releases the concurrency slot when streamText throws synchronously — slot does not leak on setup error", async () => {
    const mockConcurrencyLimiter = {
      acquire: jest.fn().mockResolvedValue(true),
      release: jest.fn(),
    };
    mockDb.limit
      .mockResolvedValueOnce([{ id: 99 }])
      .mockResolvedValue([chunkRow]);
    mockGateway.embedQueryWithCredit.mockResolvedValue(makeEmbedOk());
    mockLedger.reserve.mockResolvedValue({ reservationId: 7 });
    mockLedger.release.mockResolvedValue(undefined);
    mockedStreamText.mockImplementationOnce(() => {
      throw new Error("provider setup failed");
    });

    const { Test } = await import("@nestjs/testing");
    const { KbRagService } = await import("./kb-rag.service");
    const { KbRagRetrievalService } = await import("./kb-rag-retrieval.service");
    const { AiGatewayService } = await import("../gateway/ai-gateway.service");
    const { AI_CREDIT_LEDGER } = await import("../gateway/credit-ledger.interface");
    const { AiUsageService } = await import("./ai-usage.service");
    const { DRIZZLE } = await import("../../../../db/drizzle.constants");
    const { AiConcurrencyLimiter } = await import("../gateway/ai-concurrency-limiter");

    const module = await Test.createTestingModule({
      providers: [
        KbRagRetrievalService,
        KbRagService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AiGatewayService, useValue: mockGateway },
        { provide: AI_CREDIT_LEDGER, useValue: mockLedger },
        { provide: AiUsageService, useValue: mockUsageSvc },
        { provide: AiConcurrencyLimiter, useValue: mockConcurrencyLimiter },
      ],
    }).compile();

    const svc = module.get(KbRagService);

    await expect(
      svc.streamAnswer({ orgId: ORG_ID, question: QUESTION }),
    ).rejects.toThrow("provider setup failed");

    expect(mockConcurrencyLimiter.release).toHaveBeenCalledWith(ORG_ID);
  });

  it("releases the concurrency slot when the credit reservation is rejected — an out-of-credit org does not leak a slot per request", async () => {
    const mockConcurrencyLimiter = {
      acquire: jest.fn().mockResolvedValue(true),
      release: jest.fn(),
    };
    mockDb.limit
      .mockResolvedValueOnce([{ id: 99 }])
      .mockResolvedValue([chunkRow]);
    mockGateway.embedQueryWithCredit.mockResolvedValue(makeEmbedOk());
    mockLedger.reserve.mockRejectedValue(
      new InsufficientAiCreditsException({ message: "out of credits" }),
    );

    const module = await Test.createTestingModule({
      providers: [
        KbRagRetrievalService,
        KbRagService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AiGatewayService, useValue: mockGateway },
        { provide: AI_CREDIT_LEDGER, useValue: mockLedger },
        { provide: AiUsageService, useValue: mockUsageSvc },
        { provide: AiConcurrencyLimiter, useValue: mockConcurrencyLimiter },
      ],
    }).compile();

    const svc = module.get(KbRagService);

    await expect(
      svc.streamAnswer({ orgId: ORG_ID, question: QUESTION }),
    ).rejects.toBeInstanceOf(InsufficientAiCreditsException);

    expect(mockConcurrencyLimiter.acquire).toHaveBeenCalledWith(ORG_ID);
    expect(mockConcurrencyLimiter.release).toHaveBeenCalledWith(ORG_ID);
    expect(mockedStreamText).not.toHaveBeenCalled();
  });

  it("releases the concurrency slot in onFinish so a completed stream frees its slot", async () => {
    const mockConcurrencyLimiter = {
      acquire: jest.fn().mockResolvedValue(true),
      release: jest.fn(),
    };
    mockDb.limit
      .mockResolvedValueOnce([{ id: 99 }])
      .mockResolvedValue([chunkRow]);
    mockGateway.embedQueryWithCredit.mockResolvedValue(makeEmbedOk());
    mockLedger.reserve.mockResolvedValue({ reservationId: 11 });
    mockLedger.settle.mockResolvedValue(undefined);

    let capturedOnFinish:
      | ((opts: { usage?: { inputTokens?: number; outputTokens?: number } }) => Promise<void>)
      | undefined;
    mockedStreamText.mockImplementationOnce(((opts: { onFinish?: typeof capturedOnFinish }) => {
      capturedOnFinish = opts.onFinish;
      return {} as ReturnType<typeof streamText>;
    }) as unknown as typeof streamText);

    const module = await Test.createTestingModule({
      providers: [
        KbRagRetrievalService,
        KbRagService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AiGatewayService, useValue: mockGateway },
        { provide: AI_CREDIT_LEDGER, useValue: mockLedger },
        { provide: AiUsageService, useValue: mockUsageSvc },
        { provide: AiConcurrencyLimiter, useValue: mockConcurrencyLimiter },
      ],
    }).compile();

    const svc = module.get(KbRagService);

    await svc.streamAnswer({ orgId: ORG_ID, question: QUESTION });

    expect(mockConcurrencyLimiter.release).not.toHaveBeenCalled();

    await capturedOnFinish?.({ usage: { inputTokens: 5, outputTokens: 7 } });

    expect(mockConcurrencyLimiter.release).toHaveBeenCalledWith(ORG_ID);
  });

  it("releases the concurrency slot when the client aborts before any output", async () => {
    const mockConcurrencyLimiter = {
      acquire: jest.fn().mockResolvedValue(true),
      release: jest.fn(),
    };
    mockDb.limit
      .mockResolvedValueOnce([{ id: 99 }])
      .mockResolvedValue([chunkRow]);
    mockGateway.embedQueryWithCredit.mockResolvedValue(makeEmbedOk());
    mockLedger.reserve.mockResolvedValue({ reservationId: 12 });
    mockLedger.release.mockResolvedValue(undefined);

    mockedStreamText.mockImplementationOnce(
      (() => ({ finishReason: Promise.reject(new Error("aborted")) })) as unknown as typeof streamText,
    );

    const module = await Test.createTestingModule({
      providers: [
        KbRagRetrievalService,
        KbRagService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AiGatewayService, useValue: mockGateway },
        { provide: AI_CREDIT_LEDGER, useValue: mockLedger },
        { provide: AiUsageService, useValue: mockUsageSvc },
        { provide: AiConcurrencyLimiter, useValue: mockConcurrencyLimiter },
      ],
    }).compile();

    const svc = module.get(KbRagService);

    await svc.streamAnswer({ orgId: ORG_ID, question: QUESTION });
    await new Promise((r) => setTimeout(r, 10));

    expect(mockConcurrencyLimiter.release).toHaveBeenCalledWith(ORG_ID);
    expect(mockLedger.release).toHaveBeenCalledWith(12, "stream_aborted_no_settle", ORG_ID);
  });
});

describe("KbRagService — streamAnswer: releasing a reservation is not fire-and-forget", () => {
  const mockedStreamText = jest.mocked(streamText);

  beforeEach(() => jest.clearAllMocks());

  afterEach(() => jest.restoreAllMocks());

  it("logs a failed credit release instead of discarding it, because a silently lost release leaks the reservation", async () => {
    const errorSpy = jest.spyOn(logger, "error").mockImplementation(() => undefined);
    const mockConcurrencyLimiter = {
      acquire: jest.fn().mockResolvedValue(true),
      release: jest.fn(),
    };
    mockDb.limit.mockResolvedValueOnce([{ id: 99 }]).mockResolvedValue([chunkRow]);
    mockGateway.embedQueryWithCredit.mockResolvedValue(makeEmbedOk());
    mockLedger.reserve.mockResolvedValue({ reservationId: 31 });
    mockLedger.release.mockRejectedValue(new Error("credit ledger unreachable"));

    mockedStreamText.mockImplementationOnce(
      (() => ({ finishReason: Promise.reject(new Error("aborted")) })) as unknown as typeof streamText,
    );

    const module = await Test.createTestingModule({
      providers: [
        KbRagRetrievalService,
        KbRagService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AiGatewayService, useValue: mockGateway },
        { provide: AI_CREDIT_LEDGER, useValue: mockLedger },
        { provide: AiUsageService, useValue: mockUsageSvc },
        { provide: AiConcurrencyLimiter, useValue: mockConcurrencyLimiter },
      ],
    }).compile();

    const svc = module.get(KbRagService);

    await svc.streamAnswer({ orgId: ORG_ID, question: QUESTION });
    await new Promise((r) => setTimeout(r, 10));

    expect(mockLedger.release).toHaveBeenCalledWith(31, "stream_aborted_no_settle", ORG_ID);
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to release AI credit reservation",
      expect.objectContaining({
        orgId: ORG_ID,
        reservationId: 31,
        reason: "stream_aborted_no_settle",
        feature: "kb.public-ask",
      }),
    );
  });
});
