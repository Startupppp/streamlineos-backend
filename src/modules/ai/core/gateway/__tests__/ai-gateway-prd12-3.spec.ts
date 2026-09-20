jest.mock("../../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn().mockImplementation((db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  runInNewTenantTransaction: jest.fn().mockImplementation((db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn(db)),
}));

import { BadRequestException } from "@nestjs/common";
import { AiGatewayRunnerHelper } from "../ai-gateway-runner.helper";
import { AiGatewayCreditHelper } from "../ai-gateway-credit.helper";
import { computeTokenCharge } from "../../billing/ai-model-pricing.constants";
import { buildAskOsToolset, isToolAvailable } from "../../registry/ask-os-tool-registry";
import type { AskOsToolDefinition } from "../../registry/ask-os-tool.types";
import type { AccessSnapshot } from "../../../../access/access.types";
import type { AskOsActor } from "../../services/ask-os-actor";
import type { CurrentUserContext } from "../../../../../common/auth/backend-claims";
import type { Db } from "../../../../../db/drizzle.module";
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

describe("buildAskOsToolset — permission-gated toolset", () => {
  const mockDb: Db = Object.create(null);
  const mockActor: AskOsActor = {
    userId: "user_1",
    orgId: "org_1",
    membershipId: 1,
    displayName: "Test",
    email: "t@test.com",
    orgName: "Test Org",
    role: "MEMBER",
    isOrgOwner: false,
    timezone: "UTC",
    today: "2026-09-20",
    monthStart: "2026-09-01",
    monthEnd: "2026-09-30",
    currentYear: 2026,
    currentMonth: 9,
  };
  const mockCaller: CurrentUserContext = {
    userId: "user_1",
    orgId: "org_1",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "sess_1",
    tokenScopes: null,
    principal: { kind: "human-session", membershipId: 1, isOrgOwner: false },
  };

  function makeSnapshot(
    overrides: Partial<{ scopes: Record<string, "all" | "team" | "own" | "none">; modules: Record<string, boolean> }> = {},
  ): AccessSnapshot {
    return {
      membershipId: 1,
      scopes: overrides.scopes ?? {},
      modules: overrides.modules ?? {},
      isOrgOwner: false,
      canManageOrganizationMembership: false,
      mfa: { enforced: false, satisfied: true },
      version: 1,
    };
  }

  function makeDef(key: string, overrides: { permission?: string; module?: string } = {}): AskOsToolDefinition {
    return {
      key,
      description: `tool ${key}`,
      input: z.object({}),
      ...overrides,
      run: jest.fn().mockResolvedValue({ kind: "data" as const, data: { ok: true } }),
    };
  }

  beforeEach(() => jest.clearAllMocks());

  it("output toolset only contains keys present in definitions — unregistered names are absent", () => {
    const snapshot = makeSnapshot();
    const defs = [makeDef("readTicket"), makeDef("createTicket")];

    const result = buildAskOsToolset({ db: mockDb, actor: mockActor, caller: mockCaller, snapshot, definitions: defs });

    expect(Object.keys(result).sort()).toEqual(["createTicket", "readTicket"]);
    expect(result).not.toHaveProperty("deleteOrg");
    expect(result).not.toHaveProperty("dropDatabase");
  });

  it("a key not in definitions resolves to undefined — the AI SDK cannot dispatch it", () => {
    const snapshot = makeSnapshot();
    const defs = [makeDef("readTicket")];

    const result = buildAskOsToolset({ db: mockDb, actor: mockActor, caller: mockCaller, snapshot, definitions: defs });

    expect((result as Record<string, unknown>)["deleteOrg"]).toBeUndefined();
  });

  it("tool whose module is disabled in snapshot is excluded", () => {
    const snapshot = makeSnapshot({ modules: { BUILD: false } });
    const defs = [makeDef("readTicket"), makeDef("createSprint", { module: "BUILD" })];

    const result = buildAskOsToolset({ db: mockDb, actor: mockActor, caller: mockCaller, snapshot, definitions: defs });

    expect(Object.keys(result)).toEqual(["readTicket"]);
    expect(result).not.toHaveProperty("createSprint");
  });

  it("tool with permission absent from snapshot scopes is excluded", () => {
    const snapshot = makeSnapshot({ scopes: {} });
    const defs = [makeDef("readTicket"), makeDef("approveExpense", { permission: "finance:expenses:approve" })];

    const result = buildAskOsToolset({ db: mockDb, actor: mockActor, caller: mockCaller, snapshot, definitions: defs });

    expect(Object.keys(result)).toEqual(["readTicket"]);
    expect(result).not.toHaveProperty("approveExpense");
  });

  it("tool execute is wrapped in runInNewTenantTransaction — each invocation is isolated", async () => {
    const { runInNewTenantTransaction } = jest.requireMock("../../../../../common/tenant/run-in-tenant-transaction") as { runInNewTenantTransaction: jest.Mock };
    runInNewTenantTransaction.mockClear();

    const snapshot = makeSnapshot();
    const run = jest.fn().mockResolvedValue({ kind: "data" as const, data: { ok: true } });
    const defs: AskOsToolDefinition[] = [{ key: "myTool", description: "tool", input: z.object({}), run }];

    const result = buildAskOsToolset({ db: mockDb, actor: mockActor, caller: mockCaller, snapshot, definitions: defs });
    await result["myTool"]?.execute?.({}, { toolCallId: "tc1", messages: [], context: undefined });

    expect(runInNewTenantTransaction).toHaveBeenCalledWith(mockDb, "org_1", expect.any(Function));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("isToolAvailable — no permission or module on definition means always available", () => {
    const snapshot = makeSnapshot();
    expect(isToolAvailable(makeDef("freeTool"), snapshot)).toBe(true);
  });

  it("isToolAvailable — scope 'none' means excluded", () => {
    const snapshot = makeSnapshot({ scopes: { "hr:leave:approve": "none" } });
    expect(isToolAvailable(makeDef("approveLeave", { permission: "hr:leave:approve" }), snapshot)).toBe(false);
  });
});

describe("KbRagService — unauthorized document chunks never reach the model context", () => {
  beforeEach(() => jest.clearAllMocks());

  it("gateway is not called when no published public articles exist — no embedding or LLM cost incurred", async () => {
    const mockGateway = {
      invokeText: jest.fn(),
      embedQueryWithCredit: jest.fn(),
      isEmbeddingConfigured: jest.fn().mockReturnValue(true),
    };
    const mockDb = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
    };
    const mockLedger = { reserve: jest.fn(), settle: jest.fn(), release: jest.fn() };
    const mockUsageSvc = { track: jest.fn() };

    const { KbRagService } = await import("../../services/kb-rag.service");
    const { KbRagRetrievalService } = await import("../../services/kb-rag-retrieval.service");
    const { DRIZZLE } = await import("../../../../../db/drizzle.constants");
    const { AiGatewayService } = await import("../ai-gateway.service");
    const { AI_CREDIT_LEDGER } = await import("../credit-ledger.interface");
    const { AiUsageService } = await import("../../services/ai-usage.service");
    const { AiConcurrencyLimiter } = await import("../ai-concurrency-limiter");
    const { Test } = await import("@nestjs/testing");

    const module = await Test.createTestingModule({
      providers: [
        KbRagService,
        KbRagRetrievalService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AiGatewayService, useValue: mockGateway },
        { provide: AI_CREDIT_LEDGER, useValue: mockLedger },
        { provide: AiUsageService, useValue: mockUsageSvc },
        { provide: AiConcurrencyLimiter, useValue: { acquire: jest.fn().mockResolvedValue(true), release: jest.fn() } },
      ],
    }).compile();

    const svc = module.get(KbRagService);
    const answer = await svc.answerQuestion({ orgId: "org_test", question: "What is X?" });

    expect(mockGateway.invokeText).not.toHaveBeenCalled();
    expect(mockGateway.embedQueryWithCredit).not.toHaveBeenCalled();
    expect(answer.hasContext).toBe(false);
  });

  it("gateway is not called when articles exist but vector search returns empty — predicates excluded all chunks", async () => {
    const mockGateway = {
      invokeText: jest.fn(),
      embedQueryWithCredit: jest.fn().mockResolvedValue({ ok: true, vector: new Array(4).fill(0.01), vectorLiteral: "[0.01,0.01,0.01,0.01]" }),
      isEmbeddingConfigured: jest.fn().mockReturnValue(true),
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
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
    };
    const mockLedger = { reserve: jest.fn(), settle: jest.fn(), release: jest.fn() };
    const mockUsageSvc = { track: jest.fn() };

    const { KbRagService } = await import("../../services/kb-rag.service");
    const { KbRagRetrievalService } = await import("../../services/kb-rag-retrieval.service");
    const { DRIZZLE } = await import("../../../../../db/drizzle.constants");
    const { AiGatewayService } = await import("../ai-gateway.service");
    const { AI_CREDIT_LEDGER } = await import("../credit-ledger.interface");
    const { AiUsageService } = await import("../../services/ai-usage.service");
    const { AiConcurrencyLimiter } = await import("../ai-concurrency-limiter");
    const { Test } = await import("@nestjs/testing");

    const module = await Test.createTestingModule({
      providers: [
        KbRagService,
        KbRagRetrievalService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AiGatewayService, useValue: mockGateway },
        { provide: AI_CREDIT_LEDGER, useValue: mockLedger },
        { provide: AiUsageService, useValue: mockUsageSvc },
        { provide: AiConcurrencyLimiter, useValue: { acquire: jest.fn().mockResolvedValue(true), release: jest.fn() } },
      ],
    }).compile();

    const svc = module.get(KbRagService);
    const answer = await svc.answerQuestion({ orgId: "org_test", question: "What is X?" });

    expect(mockGateway.invokeText).not.toHaveBeenCalled();
    expect(answer.hasContext).toBe(false);
  });
});
