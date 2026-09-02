jest.mock("../../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn().mockImplementation((db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  runInNewTenantTransaction: jest.fn().mockImplementation((db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn(db)),
}));

import { BadRequestException } from "@nestjs/common";
import { AiGatewayRunnerHelper } from "../ai-gateway-runner.helper";
import { AiGatewayCreditHelper } from "../ai-gateway-credit.helper";
import { computeTokenCharge } from "../../billing/ai-model-pricing.constants";
import { withTenantScopedTools } from "../../tenant-scoped-tools";
import type { AiCreditLedger } from "../credit-ledger.interface";
import type { LlmService } from "../../providers/llm.service";
import type { AiUsageService } from "../../services/ai-usage.service";
import type { AuditService } from "../../../../../common/audit/audit.service";
import { throwOnAiFailure } from "../../services/gateway-result.util";
import { z } from "zod";

const ACTOR = { orgId: "org_1", userId: "user_1" };
const PROMPT = { system: "You are helpful.", user: "Hello" };
const FEATURE = "crm.score-lead";
const SCHEMA = z.object({ score: z.number() });

function makeLedger(overrides: Partial<AiCreditLedger> = {}): jest.Mocked<AiCreditLedger> {
  return {
    reserve: overrides.reserve ?? jest.fn().mockResolvedValue({ reservationId: 42 }),
    settle: overrides.settle ?? jest.fn().mockResolvedValue(undefined),
    release: overrides.release ?? jest.fn().mockResolvedValue(undefined),
  } as jest.Mocked<AiCreditLedger>;
}

function makeLlm(response?: { data: unknown; model: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number } }): jest.Mocked<Pick<LlmService, "invokeStructuredWithUsage" | "invokeTextWithUsage">> {
  const defaultResponse = response ?? {
    data: { score: 80 },
    model: "gpt-4o-mini",
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  };
  return {
    invokeStructuredWithUsage: jest.fn().mockResolvedValue(defaultResponse),
    invokeTextWithUsage: jest.fn().mockResolvedValue({ text: "ok", model: "gpt-4o-mini", usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } }),
  };
}

function makeUsage(): jest.Mocked<Pick<AiUsageService, "track">> {
  return { track: jest.fn().mockResolvedValue(undefined) };
}

function makeAudit(): jest.Mocked<Pick<AuditService, "log">> {
  return { log: jest.fn() };
}

function makeRunner(opts: { ledger?: jest.Mocked<AiCreditLedger>; llm?: ReturnType<typeof makeLlm> } = {}) {
  const ledger = opts.ledger ?? makeLedger();
  const llm = opts.llm ?? makeLlm();
  const usage = makeUsage();
  const audit = makeAudit();
  const credit = new AiGatewayCreditHelper(ledger, usage as never, audit as never);
  const runner = new AiGatewayRunnerHelper(llm as never, credit);
  return { runner, ledger, llm, usage, audit };
}

describe("AiGatewayRunnerHelper — context_too_large guard", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns context_too_large when system+user exceeds maxContextChars", async () => {
    const { runner, llm, ledger } = makeRunner();
    const bigPrompt = { system: "x".repeat(50_001), user: "y".repeat(50_001) };

    const result = await runner.runStructured({
      actor: ACTOR,
      feature: FEATURE,
      schema: SCHEMA,
      prompt: bigPrompt,
      maxContextChars: 100_000,
    }, "corr-big");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("context_too_large");
    expect(llm.invokeStructuredWithUsage).not.toHaveBeenCalled();
    expect(ledger.reserve).not.toHaveBeenCalled();
  });

  it("does not call the LLM or reserve credits when text context is too large", async () => {
    const { runner, llm, ledger } = makeRunner();
    const oversized = { system: "a".repeat(200_001), user: "" };

    await runner.runText({ actor: ACTOR, feature: FEATURE, prompt: oversized, charge: true }, "corr-txt");

    expect(llm.invokeTextWithUsage).not.toHaveBeenCalled();
    expect(ledger.reserve).not.toHaveBeenCalled();
  });

  it("proceeds normally when context is exactly at the limit", async () => {
    const { runner, llm } = makeRunner();
    const atLimit = { system: "a".repeat(100_000), user: "" };

    const result = await runner.runText({ actor: ACTOR, feature: FEATURE, prompt: atLimit, maxContextChars: 100_000 }, "corr-at");

    expect(result.ok).toBe(true);
    expect(llm.invokeTextWithUsage).toHaveBeenCalledTimes(1);
  });

  it("throwOnAiFailure maps context_too_large to 400 BadRequestException", () => {
    expect(() =>
      throwOnAiFailure({ ok: false, kind: "context_too_large", message: "too big", correlationId: "c" }),
    ).toThrow(BadRequestException);
  });
});

describe("AiGatewayRunnerHelper — credit milli-credit settle: under-run and over-run", () => {
  beforeEach(() => jest.clearAllMocks());

  it("settle is called with actual milli-credits (under-run: small token count, actual < catalog reserve ceiling)", async () => {
    const ledger = makeLedger({ reserve: jest.fn().mockResolvedValue({ reservationId: 10 }) });
    const llm = makeLlm({ data: { score: 80 }, model: "gpt-4o-mini", usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 } });
    const { runner } = makeRunner({ ledger, llm });

    const { milliCredits: expectedActualMilli } = computeTokenCharge("gpt-4o-mini", 20, 10);

    await runner.runStructured({ actor: ACTOR, feature: FEATURE, schema: SCHEMA, prompt: PROMPT, charge: true }, "corr-under");

    expect(ledger.settle).toHaveBeenCalledWith(10, expect.objectContaining({ actualMilli: expectedActualMilli }));
    expect(expectedActualMilli).toBeGreaterThan(0);
  });

  it("settle is called with actual milli-credits even when token count is large (over-run: debit exceeds estimate)", async () => {
    const ledger = makeLedger({ reserve: jest.fn().mockResolvedValue({ reservationId: 20 }) });
    const llm = makeLlm({ data: { score: 80 }, model: "gpt-4o", usage: { promptTokens: 5_000, completionTokens: 2_000, totalTokens: 7_000 } });
    const { runner } = makeRunner({ ledger, llm });

    const { milliCredits: expectedActualMilli } = computeTokenCharge("gpt-4o", 5_000, 2_000);

    await runner.runStructured({ actor: ACTOR, feature: FEATURE, schema: SCHEMA, prompt: PROMPT, charge: true }, "corr-over");

    expect(ledger.settle).toHaveBeenCalledWith(20, expect.objectContaining({ actualMilli: expectedActualMilli }));
    expect(expectedActualMilli).toBeGreaterThan(1_000);
  });

  it("settle is NOT called when the LLM fails — reservation is released, no double-billing", async () => {
    const ledger = makeLedger();
    const llm = makeLlm();
    llm.invokeStructuredWithUsage.mockRejectedValue(new Error("provider down"));
    const { runner } = makeRunner({ ledger, llm });

    const result = await runner.runStructured({ actor: ACTOR, feature: FEATURE, schema: SCHEMA, prompt: PROMPT, charge: true }, "corr-fail");

    expect(result.ok).toBe(false);
    expect(ledger.settle).not.toHaveBeenCalled();
    expect(ledger.release).toHaveBeenCalledWith(42, "provider_error", ACTOR.orgId);
  });
});

describe("AiGatewayRunnerHelper — no duplicate paid call (stream handoff does not re-invoke)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("invokeTextWithUsage is called exactly once when runTextWithUsage delegates to runText", async () => {
    const { runner, llm } = makeRunner();

    await runner.runTextWithUsage({ actor: ACTOR, feature: FEATURE, prompt: PROMPT }, "corr-once");

    expect(llm.invokeTextWithUsage).toHaveBeenCalledTimes(1);
  });

  it("invokeStructuredWithUsage is called exactly once when runStructuredWithUsage delegates to runStructured", async () => {
    const { runner, llm } = makeRunner();

    await runner.runStructuredWithUsage({ actor: ACTOR, feature: FEATURE, schema: SCHEMA, prompt: PROMPT }, "corr-once2");

    expect(llm.invokeStructuredWithUsage).toHaveBeenCalledTimes(1);
  });
});

describe("withTenantScopedTools — prompt injection: non-allowlisted tool cannot be invoked", () => {
  it("output tool set only contains keys that were in the input — no tool is created for unregistered names", () => {
    const inputTools = {
      readTicket: { description: "reads a ticket", inputSchema: z.object({}), execute: jest.fn() },
      createTicket: { description: "creates a ticket", inputSchema: z.object({}), execute: jest.fn() },
    };

    const result = withTenantScopedTools(inputTools, {} as never, "org_1");

    expect(Object.keys(result).sort()).toEqual(["createTicket", "readTicket"]);
    expect(result).not.toHaveProperty("deleteOrg");
    expect(result).not.toHaveProperty("dropDatabase");
    expect(result).not.toHaveProperty("grantAdminRole");
  });

  it("a key not registered in the tool set resolves to undefined — the AI SDK cannot dispatch it", () => {
    const inputTools = { readTicket: { description: "reads a ticket", inputSchema: z.object({}), execute: jest.fn() } };
    const result = withTenantScopedTools(inputTools, {} as never, "org_1");

    const injectedTool = (result as Record<string, unknown>)["deleteOrg"];
    expect(injectedTool).toBeUndefined();
  });

  it("tools with execute are wrapped in tenant transactions so each invocation is isolated", async () => {
    const { runInNewTenantTransaction } = jest.requireMock("../../../../../common/tenant/run-in-tenant-transaction") as { runInNewTenantTransaction: jest.Mock };
    runInNewTenantTransaction.mockClear();

    const mockExecute = jest.fn().mockResolvedValue({ ok: true });
    const inputTools = { myTool: { description: "tool", inputSchema: z.object({}), execute: mockExecute } };
    const result = withTenantScopedTools(inputTools, {} as never, "org_scope");

    await result["myTool"]?.execute?.({ arg: 1 } as never, {} as never);

    expect(runInNewTenantTransaction).toHaveBeenCalledWith(expect.anything(), "org_scope", expect.any(Function));
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });
});

describe("AiResponseCacheService — persistent response cache (criterion 10)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns cached result without calling the fetcher on a second call with the same params", async () => {
    const { AiResponseCacheService } = await import("../ai-response-cache.service");

    const stored = new Map<string, unknown>();
    const mockCache = {
      cachedVersionedForOrg: jest.fn().mockImplementation(
        async (_orgId: string, _ns: string, localKey: string, fetcher: () => Promise<unknown>) => {
          const hit = stored.get(localKey);
          if (hit !== undefined) return hit;
          const result = await fetcher();
          stored.set(localKey, result);
          return result;
        },
      ),
      invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
    };

    const svc = new AiResponseCacheService(mockCache as never);
    const params = { feature: "crm.score", tier: "fast", promptSystem: "sys", promptUser: "user" };
    const fetcher = jest.fn().mockResolvedValue({ ok: true, data: "response", model: "gpt-4o-mini", latencyMs: 100, correlationId: "c", usage: {} });

    const first = await svc.cachedInvoke("org_1", params, fetcher);
    const second = await svc.cachedInvoke("org_1", params, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });

  it("uses different cache keys for different prompts — no cross-prompt cache pollution", async () => {
    const { AiResponseCacheService } = await import("../ai-response-cache.service");

    const stored = new Map<string, unknown>();
    const mockCache = {
      cachedVersionedForOrg: jest.fn().mockImplementation(
        async (_orgId: string, _ns: string, localKey: string, fetcher: () => Promise<unknown>) => {
          const hit = stored.get(localKey);
          if (hit !== undefined) return hit;
          const result = await fetcher();
          stored.set(localKey, result);
          return result;
        },
      ),
      invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
    };

    const svc = new AiResponseCacheService(mockCache as never);
    const fetcherA = jest.fn().mockResolvedValue({ ok: true, data: "A" });
    const fetcherB = jest.fn().mockResolvedValue({ ok: true, data: "B" });

    await svc.cachedInvoke("org_1", { feature: "f", tier: "fast", promptSystem: "sys", promptUser: "user-A" }, fetcherA);
    await svc.cachedInvoke("org_1", { feature: "f", tier: "fast", promptSystem: "sys", promptUser: "user-B" }, fetcherB);

    expect(fetcherA).toHaveBeenCalledTimes(1);
    expect(fetcherB).toHaveBeenCalledTimes(1);
    expect(stored.size).toBe(2);
  });

  it("invalidate bumps the namespace version so stale entries are never served", async () => {
    const { AiResponseCacheService } = await import("../ai-response-cache.service");
    const mockCache = {
      cachedVersionedForOrg: jest.fn().mockResolvedValue({ ok: true, data: "cached" }),
      invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
    };

    const svc = new AiResponseCacheService(mockCache as never);
    await svc.invalidate("org_1");

    expect(mockCache.invalidateNamespaceForOrg).toHaveBeenCalledWith("org_1", "ai:responses:v1");
  });
});

describe("KbRagService — unauthorized document chunks never reach the model context", () => {
  beforeEach(() => jest.clearAllMocks());

  it("gateway is not called when no published public articles exist — no embedding or LLM cost incurred", async () => {
    const mockGateway = { invokeText: jest.fn() };
    const mockEmbeddings = {
      isConfigured: jest.fn().mockReturnValue(true),
      embedQuery: jest.fn(),
      toVectorLiteral: jest.fn((v: number[]) => `[${v.join(",")}]`),
    };
    const mockDb = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };

    const { KbRagService } = await import("../../services/kb-rag.service");
    const { DRIZZLE } = await import("../../../../../db/drizzle.constants");
    const { EmbeddingsService } = await import("../../providers/embeddings.service");
    const { AiGatewayService } = await import("../ai-gateway.service");
    const { Test } = await import("@nestjs/testing");

    const module = await Test.createTestingModule({
      providers: [
        KbRagService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: EmbeddingsService, useValue: mockEmbeddings },
        { provide: AiGatewayService, useValue: mockGateway },
      ],
    }).compile();

    const svc = module.get(KbRagService);
    const answer = await svc.answerQuestion({ orgId: "org_test", question: "What is X?" });

    expect(mockGateway.invokeText).not.toHaveBeenCalled();
    expect(mockEmbeddings.embedQuery).not.toHaveBeenCalled();
    expect(answer.hasContext).toBe(false);
  });

  it("gateway is not called when articles exist but vector search returns empty — predicates excluded all chunks", async () => {
    const mockGateway = { invokeText: jest.fn() };
    const mockEmbeddings = {
      isConfigured: jest.fn().mockReturnValue(true),
      embedQuery: jest.fn().mockResolvedValue(new Array(1536).fill(0.01)),
      toVectorLiteral: jest.fn((v: number[]) => `[${v.join(",")}]`),
    };
    const mockDb = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn()
        .mockResolvedValueOnce([{ id: 1 }])
        .mockResolvedValue([]),
    };

    const { KbRagService } = await import("../../services/kb-rag.service");
    const { DRIZZLE } = await import("../../../../../db/drizzle.constants");
    const { EmbeddingsService } = await import("../../providers/embeddings.service");
    const { AiGatewayService } = await import("../ai-gateway.service");
    const { Test } = await import("@nestjs/testing");

    const module = await Test.createTestingModule({
      providers: [
        KbRagService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: EmbeddingsService, useValue: mockEmbeddings },
        { provide: AiGatewayService, useValue: mockGateway },
      ],
    }).compile();

    const svc = module.get(KbRagService);
    const answer = await svc.answerQuestion({ orgId: "org_test", question: "What is X?" });

    expect(mockGateway.invokeText).not.toHaveBeenCalled();
    expect(answer.hasContext).toBe(false);
  });
});
