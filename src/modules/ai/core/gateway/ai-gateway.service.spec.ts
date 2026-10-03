import { ServiceUnavailableException } from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../../common/http/api-exceptions";
import { Test, type TestingModule } from "@nestjs/testing";
import { z } from "zod";
import { AiGatewayService } from "./ai-gateway.service";
import { AI_CREDIT_LEDGER } from "./credit-ledger.interface";
import type { AiCreditLedger } from "./credit-ledger.interface";
import { LlmService } from "../providers/llm.service";
import { AiUsageService } from "../services/ai-usage.service";
import { AuditService } from "../../../../common/audit/audit.service";
import { AiConcurrencyLimiter } from "./ai-concurrency-limiter";
import { EmbeddingsService } from "../providers/embeddings.service";

const GreetingSchema = z.object({ message: z.string() });

const ACTOR = { orgId: "org_1", userId: "user_1" };
const PROMPT = { system: "You are helpful.", user: "Say hello" };
const FEATURE = "test.feature";

function makeLlm(overrides: Partial<{
  invokeTextWithUsage: jest.Mock;
  invokeStructuredWithUsage: jest.Mock;
}> = {}) {
  return {
    isConfigured: jest.fn().mockReturnValue(true),
    invokeTextWithUsage: overrides.invokeTextWithUsage ?? jest.fn().mockResolvedValue({
      text: "Hello!",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      model: "gpt-4o-mini",
    }),
    invokeStructuredWithUsage: overrides.invokeStructuredWithUsage ?? jest.fn().mockResolvedValue({
      data: { message: "Hello!" },
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      model: "gpt-4o-mini",
    }),
  };
}

function makeLedger(overrides: Partial<AiCreditLedger> = {}): jest.Mocked<AiCreditLedger> {
  return {
    reserve: overrides.reserve ?? jest.fn().mockResolvedValue({ reservationId: 42 }),
    settle: overrides.settle ?? jest.fn().mockResolvedValue(undefined),
    release: overrides.release ?? jest.fn().mockResolvedValue(undefined),
  } as jest.Mocked<AiCreditLedger>;
}

function makeEmbeddings(overrides: Partial<{ embedQueryRaw: jest.Mock; embedBatchRaw: jest.Mock }> = {}) {
  return {
    isConfigured: jest.fn().mockReturnValue(true),
    embedQueryRaw: overrides.embedQueryRaw ?? jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    embedBatchRaw:
      overrides.embedBatchRaw ??
      jest.fn().mockImplementation((texts: string[]) => Promise.resolve(texts.map(() => [0.1, 0.2, 0.3]))),
    toVectorLiteral: jest.fn().mockReturnValue("[0.1,0.2,0.3]"),
  };
}

async function buildModule(
  llmOverride?: ReturnType<typeof makeLlm>,
  ledgerOverride?: jest.Mocked<AiCreditLedger>,
  extras: Partial<{
    embeddings: ReturnType<typeof makeEmbeddings>;
    limiter: { acquire: jest.Mock; release: jest.Mock };
  }> = {},
) {
  const mockUsage = { track: jest.fn().mockResolvedValue(undefined) };
  const mockAudit = { log: jest.fn() };
  const llm = llmOverride ?? makeLlm();
  const ledger = ledgerOverride ?? makeLedger();

  const mockConcurrencyLimiter =
    extras.limiter ?? { acquire: jest.fn().mockResolvedValue(true), release: jest.fn() };

  const mockEmbeddings = extras.embeddings ?? makeEmbeddings();

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      AiGatewayService,
      { provide: LlmService, useValue: llm },
      { provide: EmbeddingsService, useValue: mockEmbeddings },
      { provide: AiUsageService, useValue: mockUsage },
      { provide: AuditService, useValue: mockAudit },
      { provide: AI_CREDIT_LEDGER, useValue: ledger },
      { provide: AiConcurrencyLimiter, useValue: mockConcurrencyLimiter },
    ],
  }).compile();

  return {
    svc: module.get(AiGatewayService),
    llm,
    ledger,
    mockUsage,
    mockAudit,
    mockEmbeddings,
    mockConcurrencyLimiter,
  };
}

describe("AiGatewayService", () => {
  beforeEach(() => jest.clearAllMocks());

  describe("invokeText — success", () => {
    it("returns ok=true with text and usage", async () => {
      const { svc } = await buildModule();
      const result = await svc.invokeText({ actor: ACTOR, feature: FEATURE, prompt: PROMPT });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toBe("Hello!");
      expect(result.model).toBe("gpt-4o-mini");
      expect(result.usage.promptTokens).toBe(10);
      expect(result.usage.completionTokens).toBe(5);
      expect(result.usage.totalTokens).toBe(15);
      expect(result.correlationId).toBeDefined();
    });

    it("tracks usage and audits on success", async () => {
      const { svc, mockUsage, mockAudit } = await buildModule();
      await svc.invokeText({ actor: ACTOR, feature: FEATURE, prompt: PROMPT });

      await new Promise((r) => setTimeout(r, 10));
      expect(mockUsage.track).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org_1", feature: FEATURE }));
      expect(mockAudit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "ai.invoke", orgId: "org_1" }));
    });
  });

  describe("invokeStructured — success", () => {
    it("returns ok=true with typed data", async () => {
      const { svc } = await buildModule();
      const result = await svc.invokeStructured({ actor: ACTOR, feature: FEATURE, prompt: PROMPT, schema: GreetingSchema });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toEqual({ message: "Hello!" });
    });

    it("settles the ledger on success when charge is provided", async () => {
      const ledger = makeLedger();
      const { svc } = await buildModule(undefined, ledger);
      await svc.invokeStructured({
        actor: ACTOR,
        feature: FEATURE,
        prompt: PROMPT,
        schema: GreetingSchema,
        charge: true,
      });

      expect(ledger.reserve).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org_1", credits: 1000 }));
      await new Promise((r) => setTimeout(r, 10));
      expect(ledger.settle).toHaveBeenCalledWith(42, expect.objectContaining({ actualMilli: expect.any(Number) }));
    });
  });

  describe("provider failure", () => {
    it("returns provider_unavailable and releases ledger reservation", async () => {
      const llm = makeLlm({
        invokeTextWithUsage: jest.fn().mockRejectedValue(new ServiceUnavailableException("AI provider is temporarily unavailable")),
      });
      const ledger = makeLedger();
      const { svc } = await buildModule(llm, ledger);

      const result = await svc.invokeText({
        actor: ACTOR,
        feature: FEATURE,
        prompt: PROMPT,
        charge: true,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe("provider_unavailable");
      expect(ledger.release).toHaveBeenCalledWith(42, "provider_error", "org_1");
    });

    it("returns not_configured when provider error message contains 'not configured'", async () => {
      const llm = makeLlm({
        invokeTextWithUsage: jest.fn().mockRejectedValue(new ServiceUnavailableException("AI provider is not configured correctly")),
      });
      const { svc } = await buildModule(llm);

      const result = await svc.invokeText({ actor: ACTOR, feature: FEATURE, prompt: PROMPT });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe("not_configured");
    });
  });

  describe("quota_exceeded", () => {
    it("returns quota_exceeded when ledger.reserve throws InsufficientAiCreditsException", async () => {
      const ledger = makeLedger({
        reserve: jest.fn().mockRejectedValue(new InsufficientAiCreditsException()),
      });
      const llm = makeLlm();
      const { svc } = await buildModule(llm, ledger);

      const result = await svc.invokeText({
        actor: ACTOR,
        feature: FEATURE,
        prompt: PROMPT,
        charge: true,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe("quota_exceeded");
      expect(llm.invokeTextWithUsage).not.toHaveBeenCalled();
    });
  });

  describe("redaction", () => {
    it("redacts PII from prompt before passing to LlmService when redact=true (default)", async () => {
      const llm = makeLlm();
      const { svc } = await buildModule(llm);

      await svc.invokeText({
        actor: ACTOR,
        feature: FEATURE,
        prompt: { system: "System", user: "Email is test@example.com, SSN 123-45-6789" },
        redact: true,
      });

      const callArg = (llm.invokeTextWithUsage as jest.Mock).mock.calls[0][0] as { user: string };
      expect(callArg.user).not.toContain("test@example.com");
      expect(callArg.user).not.toContain("123-45-6789");
      expect(callArg.user).toContain("[REDACTED");
    });

    it("does not redact when redact=false", async () => {
      const llm = makeLlm();
      const { svc } = await buildModule(llm);

      await svc.invokeText({
        actor: ACTOR,
        feature: FEATURE,
        prompt: { system: "System", user: "Email is test@example.com" },
        redact: false,
      });

      const callArg = (llm.invokeTextWithUsage as jest.Mock).mock.calls[0][0] as { user: string };
      expect(callArg.user).toContain("test@example.com");
    });
  });

  describe("dedupe", () => {
    it("shares in-flight promise for identical dedupe calls", async () => {
      let resolveCall!: (v: string) => void;
      const blockedPromise = new Promise<string>((r) => { resolveCall = r; });
      const llm = makeLlm({
        invokeTextWithUsage: jest.fn().mockReturnValueOnce(
          blockedPromise.then((text) => ({ text, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: "gpt-4o-mini" })),
        ),
      });
      const { svc } = await buildModule(llm);

      const opts = { actor: ACTOR, feature: FEATURE, prompt: PROMPT, dedupe: true };
      const p1 = svc.invokeText(opts);
      const p2 = svc.invokeText(opts);

      resolveCall("Hello!");
      const [r1, r2] = await Promise.all([p1, p2]);

      expect(llm.invokeTextWithUsage).toHaveBeenCalledTimes(1);
      expect(r1).toStrictEqual(r2);
    });
  });

  describe("reservationId=0 (noop ledger)", () => {
    it("skips settle and release when reservationId is 0", async () => {
      const ledger = makeLedger({
        reserve: jest.fn().mockResolvedValue({ reservationId: 0 }),
      });
      const { svc } = await buildModule(undefined, ledger);

      await svc.invokeText({
        actor: ACTOR,
        feature: FEATURE,
        prompt: PROMPT,
        charge: true,
      });

      expect(ledger.settle).not.toHaveBeenCalled();
      expect(ledger.release).not.toHaveBeenCalled();
    });
  });

  describe("concurrency_exceeded (item 3)", () => {
    it("returns concurrency_exceeded and does not call LLM when limiter denies", async () => {
      const llm = makeLlm();
      const ledger = makeLedger();
      const mockUsage = { track: jest.fn().mockResolvedValue(undefined) };
      const mockAudit = { log: jest.fn() };
      const denyingLimiter = { acquire: jest.fn().mockResolvedValue(false), release: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          AiGatewayService,
          { provide: LlmService, useValue: llm },
          { provide: EmbeddingsService, useValue: { isConfigured: jest.fn().mockReturnValue(false), embedQueryRaw: jest.fn(), embedBatchRaw: jest.fn(), toVectorLiteral: jest.fn() } },
          { provide: AiUsageService, useValue: mockUsage },
          { provide: AuditService, useValue: mockAudit },
          { provide: AI_CREDIT_LEDGER, useValue: ledger },
          { provide: AiConcurrencyLimiter, useValue: denyingLimiter },
        ],
      }).compile();

      const svc = module.get(AiGatewayService);
      const result = await svc.invokeText({ actor: ACTOR, feature: FEATURE, prompt: PROMPT });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe("concurrency_exceeded");
      expect(llm.invokeTextWithUsage).not.toHaveBeenCalled();
    });

    it("releases the concurrency slot even when the runner throws", async () => {
      const llm = makeLlm({
        invokeTextWithUsage: jest.fn().mockRejectedValue(new ServiceUnavailableException("provider down")),
      });
      const { svc } = await buildModule(llm);
      await svc.invokeText({ actor: ACTOR, feature: FEATURE, prompt: PROMPT });

      const module2: TestingModule = await Test.createTestingModule({
        providers: [
          AiGatewayService,
          { provide: LlmService, useValue: llm },
          { provide: EmbeddingsService, useValue: { isConfigured: jest.fn().mockReturnValue(false), embedQueryRaw: jest.fn(), embedBatchRaw: jest.fn(), toVectorLiteral: jest.fn() } },
          { provide: AiUsageService, useValue: { track: jest.fn().mockResolvedValue(undefined) } },
          { provide: AuditService, useValue: { log: jest.fn() } },
          { provide: AI_CREDIT_LEDGER, useValue: makeLedger() },
          { provide: AiConcurrencyLimiter, useValue: { acquire: jest.fn().mockResolvedValue(true), release: jest.fn() } },
        ],
      }).compile();

      const svc2 = module2.get(AiGatewayService);
      const limiter2 = module2.get(AiConcurrencyLimiter) as jest.Mocked<AiConcurrencyLimiter>;
      await svc2.invokeText({ actor: ACTOR, feature: FEATURE, prompt: PROMPT });
      expect(limiter2.release).toHaveBeenCalledWith(ACTOR.orgId);
    });
  });
  describe("embedQueryWithCredit — credit before the paid call (ticket 10)", () => {
    const EMBED_FEATURE = "kb.public-embedding";
    const RESERVE_CEILING_MILLI = 1000;

    it("reserves credit BEFORE the embedding provider is called", async () => {
      const { svc, ledger, mockEmbeddings } = await buildModule();
      const result = await svc.embedQueryWithCredit({
        text: "how do I reset my password",
        orgId: ACTOR.orgId,
        feature: EMBED_FEATURE,
        charge: true,
      });

      expect(result.ok).toBe(true);
      expect(ledger.reserve).toHaveBeenCalledWith({
        orgId: ACTOR.orgId,
        userId: null,
        feature: EMBED_FEATURE,
        credits: RESERVE_CEILING_MILLI,
      });
      const reserveOrder = ledger.reserve.mock.invocationCallOrder[0];
      const embedOrder = mockEmbeddings.embedQueryRaw.mock.invocationCallOrder[0];
      expect(reserveOrder).toBeDefined();
      expect(embedOrder).toBeDefined();
      expect(reserveOrder).toBeLessThan(embedOrder);
    });

    it("never calls the provider when the wallet is short", async () => {
      const ledger = makeLedger({
        reserve: jest.fn().mockRejectedValue(new InsufficientAiCreditsException({ message: "Insufficient AI credits" })),
      });
      const { svc, mockEmbeddings } = await buildModule(undefined, ledger);

      const result = await svc.embedQueryWithCredit({
        text: "anything",
        orgId: ACTOR.orgId,
        feature: EMBED_FEATURE,
        charge: true,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe("quota_exceeded");
      expect(mockEmbeddings.embedQueryRaw).not.toHaveBeenCalled();
      expect(ledger.settle).not.toHaveBeenCalled();
    });

    it("settles the token-metered charge, not the flat reserve ceiling, and scales with input size", async () => {
      const short = await buildModule();
      await short.svc.embedQueryWithCredit({
        text: "x".repeat(4_000),
        orgId: ACTOR.orgId,
        feature: EMBED_FEATURE,
        charge: true,
      });
      const shortSettle = short.ledger.settle.mock.calls[0]?.[1];
      expect(shortSettle?.actualMilli).toBe(10);
      expect(shortSettle?.promptTokens).toBe(1_000);

      const long = await buildModule();
      await long.svc.embedQueryWithCredit({
        text: "x".repeat(40_000),
        orgId: ACTOR.orgId,
        feature: EMBED_FEATURE,
        charge: true,
      });
      const longSettle = long.ledger.settle.mock.calls[0]?.[1];
      expect(longSettle?.actualMilli).toBe(30);
      expect(longSettle?.promptTokens).toBe(10_000);
      expect(longSettle?.actualMilli).not.toBe(RESERVE_CEILING_MILLI);
    });

    it("records the settled milli-credits on the usage log", async () => {
      const { svc, mockUsage } = await buildModule();
      await svc.embedQueryWithCredit({
        text: "x".repeat(40_000),
        orgId: ACTOR.orgId,
        feature: EMBED_FEATURE,
        charge: true,
      });

      expect(mockUsage.track).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: ACTOR.orgId,
          feature: EMBED_FEATURE,
          creditsMilli: 30,
          promptTokens: 10_000,
          outcome: "ok",
        }),
      );
    });

    it("releases the reservation when the provider throws and reports provider_unavailable", async () => {
      const embeddings = makeEmbeddings({
        embedQueryRaw: jest.fn().mockRejectedValue(new Error("openai down")),
      });
      const { svc, ledger } = await buildModule(undefined, undefined, { embeddings });

      const result = await svc.embedQueryWithCredit({
        text: "anything",
        orgId: ACTOR.orgId,
        feature: EMBED_FEATURE,
        charge: true,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe("provider_unavailable");
      expect(ledger.release).toHaveBeenCalledWith(42, "embedding_error", ACTOR.orgId);
      expect(ledger.settle).not.toHaveBeenCalled();
    });

    it("does not refund or fail a successful embedding when settlement throws", async () => {
      const ledger = makeLedger({
        settle: jest.fn().mockRejectedValue(new Error("ledger unavailable")),
      });
      const { svc } = await buildModule(undefined, ledger);

      const result = await svc.embedQueryWithCredit({
        text: "anything",
        orgId: ACTOR.orgId,
        feature: EMBED_FEATURE,
        charge: true,
      });

      expect(result.ok).toBe(true);
      expect(ledger.release).not.toHaveBeenCalled();
    });

    it("takes a concurrency slot and releases it on both success and provider failure", async () => {
      const ok = await buildModule();
      await ok.svc.embedQueryWithCredit({
        text: "anything",
        orgId: ACTOR.orgId,
        feature: EMBED_FEATURE,
        charge: true,
      });
      expect(ok.mockConcurrencyLimiter.acquire).toHaveBeenCalledWith(ACTOR.orgId);
      expect(ok.mockConcurrencyLimiter.release).toHaveBeenCalledWith(ACTOR.orgId);

      const failing = await buildModule(undefined, undefined, {
        embeddings: makeEmbeddings({ embedQueryRaw: jest.fn().mockRejectedValue(new Error("down")) }),
      });
      await failing.svc.embedQueryWithCredit({
        text: "anything",
        orgId: ACTOR.orgId,
        feature: EMBED_FEATURE,
        charge: true,
      });
      expect(failing.mockConcurrencyLimiter.release).toHaveBeenCalledWith(ACTOR.orgId);
    });

    it("does not leak a slot when the wallet is short", async () => {
      const ledger = makeLedger({
        reserve: jest.fn().mockRejectedValue(new InsufficientAiCreditsException()),
      });
      const { svc, mockConcurrencyLimiter } = await buildModule(undefined, ledger);

      await svc.embedQueryWithCredit({
        text: "anything",
        orgId: ACTOR.orgId,
        feature: EMBED_FEATURE,
        charge: true,
      });

      expect(mockConcurrencyLimiter.acquire).toHaveBeenCalledTimes(1);
      expect(mockConcurrencyLimiter.release).toHaveBeenCalledTimes(1);
    });

    it("returns concurrency_exceeded without reserving credit or calling the provider", async () => {
      const { svc, ledger, mockEmbeddings } = await buildModule(undefined, undefined, {
        limiter: { acquire: jest.fn().mockResolvedValue(false), release: jest.fn() },
      });

      const result = await svc.embedQueryWithCredit({
        text: "anything",
        orgId: ACTOR.orgId,
        feature: EMBED_FEATURE,
        charge: true,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe("concurrency_exceeded");
      expect(ledger.reserve).not.toHaveBeenCalled();
      expect(mockEmbeddings.embedQueryRaw).not.toHaveBeenCalled();
    });

    it("charge: false neither reserves nor settles but still returns a vector", async () => {
      const { svc, ledger } = await buildModule();
      const result = await svc.embedQueryWithCredit({
        text: "anything",
        orgId: ACTOR.orgId,
        feature: EMBED_FEATURE,
        charge: false,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.vectorLiteral).toBe("[0.1,0.2,0.3]");
      expect(ledger.reserve).not.toHaveBeenCalled();
      expect(ledger.settle).not.toHaveBeenCalled();
    });
  });
  describe("embedBatchWithCredit — one reservation for the whole batch (ticket 10)", () => {
    const INDEX_FEATURE = "kb.indexing";
    const RESERVE_CEILING_MILLI = 1000;
    const PER_CHUNK_RESERVE_MILLI = 5;

    it("reserves ONCE for the whole batch, not once per text", async () => {
      const { svc, ledger, mockEmbeddings } = await buildModule();
      const texts = Array.from({ length: 120 }, (_, i) => `chunk ${i} `.repeat(50));

      const result = await svc.embedBatchWithCredit({
        texts,
        orgId: ACTOR.orgId,
        feature: INDEX_FEATURE,
        charge: true,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.vectors).toHaveLength(120);
      expect(ledger.reserve).toHaveBeenCalledTimes(1);
      expect(ledger.settle).toHaveBeenCalledTimes(1);
      expect(mockEmbeddings.embedBatchRaw).toHaveBeenCalledTimes(1);
      expect(ledger.reserve).toHaveBeenCalledWith(
        expect.objectContaining({ feature: INDEX_FEATURE, credits: PER_CHUNK_RESERVE_MILLI * texts.length }),
      );
    });

    it("settles on the summed actual tokens of the batch, not the per-call floor", async () => {
      const { svc, ledger } = await buildModule();
      const texts = Array.from({ length: 10 }, () => "x".repeat(4_000));

      await svc.embedBatchWithCredit({
        texts,
        orgId: ACTOR.orgId,
        feature: INDEX_FEATURE,
        charge: true,
      });

      const settle = ledger.settle.mock.calls[0]?.[1];
      expect(settle?.promptTokens).toBe(10_000);
      expect(settle?.actualMilli).toBe(30);
      expect(settle?.actualMilli).not.toBe(RESERVE_CEILING_MILLI);
    });

    it("takes exactly one concurrency slot for the whole batch and releases it", async () => {
      const { svc, mockConcurrencyLimiter } = await buildModule();
      await svc.embedBatchWithCredit({
        texts: Array.from({ length: 200 }, (_, i) => `t${i}`),
        orgId: ACTOR.orgId,
        feature: INDEX_FEATURE,
        charge: true,
      });

      expect(mockConcurrencyLimiter.acquire).toHaveBeenCalledTimes(1);
      expect(mockConcurrencyLimiter.release).toHaveBeenCalledTimes(1);
    });

    it("never calls the provider when the wallet is short", async () => {
      const ledger = makeLedger({
        reserve: jest.fn().mockRejectedValue(new InsufficientAiCreditsException()),
      });
      const { svc, mockEmbeddings, mockConcurrencyLimiter } = await buildModule(undefined, ledger);

      const result = await svc.embedBatchWithCredit({
        texts: ["a", "b"],
        orgId: ACTOR.orgId,
        feature: INDEX_FEATURE,
        charge: true,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe("quota_exceeded");
      expect(mockEmbeddings.embedBatchRaw).not.toHaveBeenCalled();
      expect(mockConcurrencyLimiter.release).toHaveBeenCalledTimes(1);
    });

    it("releases the reservation when the provider throws mid-batch", async () => {
      const embeddings = makeEmbeddings({
        embedBatchRaw: jest.fn().mockRejectedValue(new Error("openai down")),
      });
      const { svc, ledger } = await buildModule(undefined, undefined, { embeddings });

      const result = await svc.embedBatchWithCredit({
        texts: ["a", "b"],
        orgId: ACTOR.orgId,
        feature: INDEX_FEATURE,
        charge: true,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe("provider_unavailable");
      expect(ledger.release).toHaveBeenCalledWith(42, "embedding_error", ACTOR.orgId);
      expect(ledger.settle).not.toHaveBeenCalled();
    });

    it("an empty batch spends nothing: no slot, no reservation, no provider call", async () => {
      const { svc, ledger, mockEmbeddings, mockConcurrencyLimiter } = await buildModule();

      const result = await svc.embedBatchWithCredit({
        texts: [],
        orgId: ACTOR.orgId,
        feature: INDEX_FEATURE,
        charge: true,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.vectors).toEqual([]);
      expect(mockConcurrencyLimiter.acquire).not.toHaveBeenCalled();
      expect(ledger.reserve).not.toHaveBeenCalled();
      expect(mockEmbeddings.embedBatchRaw).not.toHaveBeenCalled();
    });

    it("returns concurrency_exceeded without reserving or calling the provider", async () => {
      const { svc, ledger, mockEmbeddings } = await buildModule(undefined, undefined, {
        limiter: { acquire: jest.fn().mockResolvedValue(false), release: jest.fn() },
      });

      const result = await svc.embedBatchWithCredit({
        texts: ["a"],
        orgId: ACTOR.orgId,
        feature: INDEX_FEATURE,
        charge: true,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe("concurrency_exceeded");
      expect(ledger.reserve).not.toHaveBeenCalled();
      expect(mockEmbeddings.embedBatchRaw).not.toHaveBeenCalled();
    });

    it("records one usage row for the batch carrying the settled milli-credits", async () => {
      const { svc, mockUsage } = await buildModule();
      await svc.embedBatchWithCredit({
        texts: Array.from({ length: 10 }, () => "x".repeat(4_000)),
        orgId: ACTOR.orgId,
        feature: INDEX_FEATURE,
        charge: true,
      });

      expect(mockUsage.track).toHaveBeenCalledTimes(1);
      expect(mockUsage.track).toHaveBeenCalledWith(
        expect.objectContaining({
          feature: INDEX_FEATURE,
          creditsMilli: 30,
          promptTokens: 10_000,
          metadata: expect.objectContaining({ batchSize: 10 }),
        }),
      );
    });
  });
});
