jest.mock("ai", () => ({
  streamText: jest.fn(),
  tool: jest.fn((def: unknown) => def),
  stepCountIs: jest.fn(() => () => false),
}));
jest.mock("@composio/core", () => ({ Composio: jest.fn() }));
jest.mock("../workspace-copilot-tools", () => ({ WorkspaceCopilotTools: jest.fn() }));
jest.mock("../comms-copilot-tools", () => ({ CommsCopilotTools: jest.fn() }));
jest.mock("../../../calendar/calendar.service", () => ({ CalendarService: jest.fn() }));
jest.mock("../../../integrations/core/composio.gateway", () => ({ ComposioGateway: jest.fn() }));
jest.mock("../../../../common/ratelimit/rate-limit.service", () => ({ RateLimitService: jest.fn() }));
jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn().mockImplementation((db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  runInNewTenantTransaction: jest
    .fn()
    .mockImplementation((db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn(db)),
}));

import { streamText } from "ai";
import { ChatAssistantService } from "./chat-assistant.service";
import { type AiCreditLedger } from "../gateway/credit-ledger.interface";
import type { AiUsageService } from "./ai-usage.service";
import { humanSessionPrincipal } from "../../../../common/auth/principal";

const ACTOR = {
  userId: "user_1",
  orgId: "org_1",
  role: "ADMIN",
  permissions: [],
  isOrgOwner: false,
  sessionId: "sess_1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

const STUB_CONTEXT = {
  projectCount: 0,
  ticketCount: 0,
  todayAttendance: null,
  pendingLeaves: 0,
  recentPayrolls: [],
  myLeadsCount: 0,
  hotLeadsCount: 0,
  myOpenDealsCount: 0,
  topLeads: [],
};

function makeLedger(): jest.Mocked<AiCreditLedger> {
  return {
    reserve: jest.fn().mockResolvedValue({ reservationId: 42 }),
    settle: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  } as jest.Mocked<AiCreditLedger>;
}

function buildService() {
  const history = {
    append: jest.fn().mockResolvedValue(undefined),
    appendToConversation: jest.fn().mockResolvedValue(undefined),
  };
  const noop = { buildTools: jest.fn().mockReturnValue({}) };
  const usageSvc = { track: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AiUsageService>;

  const svc = new ChatAssistantService(
    {} as never,
    { ask: jest.fn(), summarize: jest.fn() } as never,
    history as never,
    noop as never,
    noop as never,
    noop as never,
    noop as never,
    noop as never,
    noop as never,
    noop as never,
    noop as never,
    { denyReason: jest.fn().mockResolvedValue(null) } as never,
    { get: jest.fn().mockReturnValue({ ask: jest.fn() }) } as never,
    usageSvc,
    makeLedger(),
  );

  jest.spyOn(svc as never, "fetchContext").mockResolvedValue(STUB_CONTEXT as never);
  return svc;
}

type StreamOpts = {
  onError?: (event: { error: unknown }) => void;
  abortSignal?: AbortSignal;
};

describe("ChatAssistantService — the breaker counts provider faults, not just setup faults", () => {
  beforeEach(() => jest.clearAllMocks());

  it("opens after five stream-level provider errors, which streamText never throws synchronously", async () => {
    let captured: ((event: { error: unknown }) => void) | undefined;
    (streamText as jest.Mock).mockImplementation((opts: StreamOpts) => {
      captured = opts.onError;
      return {};
    });

    const svc = buildService();

    for (let i = 0; i < 5; i += 1) {
      await svc.processChat([{ role: "user", content: "hi" }], ACTOR);
      captured?.({ error: new Error("upstream 503") });
    }

    const callsBefore = (streamText as jest.Mock).mock.calls.length;
    await expect(svc.processChat([{ role: "user", content: "hi" }], ACTOR)).rejects.toThrow(
      "temporarily unavailable",
    );
    expect((streamText as jest.Mock).mock.calls.length).toBe(callsBefore);
  });

  it("does not count a client abort as a provider fault", async () => {
    let captured: ((event: { error: unknown }) => void) | undefined;
    (streamText as jest.Mock).mockImplementation((opts: StreamOpts) => {
      captured = opts.onError;
      return {};
    });

    const svc = buildService();

    for (let i = 0; i < 8; i += 1) {
      await svc.processChat([{ role: "user", content: "hi" }], ACTOR);
      captured?.({ error: Object.assign(new Error("aborted"), { name: "AbortError" }) });
    }

    await expect(svc.processChat([{ role: "user", content: "hi" }], ACTOR)).resolves.toBeDefined();
  });

  it("a successful turn resets the failure count", async () => {
    let captured: ((event: { error: unknown }) => void) | undefined;
    let capturedFinish:
      | ((opts: { text: string; usage?: { inputTokens?: number; outputTokens?: number } }) => Promise<void>)
      | undefined;

    (streamText as jest.Mock).mockImplementation(
      (opts: StreamOpts & { onFinish?: typeof capturedFinish }) => {
        captured = opts.onError;
        capturedFinish = opts.onFinish;
        return {};
      },
    );

    const svc = buildService();

    for (let i = 0; i < 4; i += 1) {
      await svc.processChat([{ role: "user", content: "hi" }], ACTOR);
      captured?.({ error: new Error("upstream 503") });
    }

    await svc.processChat([{ role: "user", content: "hi" }], ACTOR);
    await capturedFinish?.({ text: "ok", usage: { inputTokens: 1, outputTokens: 1 } });

    for (let i = 0; i < 4; i += 1) {
      await svc.processChat([{ role: "user", content: "hi" }], ACTOR);
      captured?.({ error: new Error("upstream 503") });
    }

    await expect(svc.processChat([{ role: "user", content: "hi" }], ACTOR)).resolves.toBeDefined();
  });
});

describe("ChatAssistantService — circuit breaker Redis integration (item 2)", () => {
  beforeEach(() => jest.clearAllMocks());

  function buildServiceWithRedis(redis: unknown) {
    const history = {
      append: jest.fn().mockResolvedValue(undefined),
      appendToConversation: jest.fn().mockResolvedValue(undefined),
    };
    const noop = { buildTools: jest.fn().mockReturnValue({}) };
    const usageSvc = { track: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AiUsageService>;
    const ledger = {
      reserve: jest.fn().mockResolvedValue({ reservationId: 42 }),
      settle: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };

    const svc = new ChatAssistantService(
      {} as never,
      { ask: jest.fn(), summarize: jest.fn() } as never,
      history as never,
      noop as never,
      noop as never,
      noop as never,
      noop as never,
      noop as never,
      noop as never,
      noop as never,
      noop as never,
      { denyReason: jest.fn().mockResolvedValue(null) } as never,
      { get: jest.fn().mockReturnValue({ ask: jest.fn() }) } as never,
      usageSvc,
      ledger as never,
      redis as never,
    );

    jest.spyOn(svc as never, "fetchContext").mockResolvedValue(STUB_CONTEXT as never);
    return svc;
  }

  it("falls back to local state when Redis throws — fresh instance with no failures allows traffic (fail-open)", async () => {
    const throwingRedis = { get: jest.fn().mockRejectedValue(new Error("Redis unavailable")) };
    const svc = buildServiceWithRedis(throwingRedis);

    (streamText as jest.Mock).mockImplementation(() => ({}));
    await expect(svc.processChat([{ role: "user", content: "hi" }], ACTOR)).resolves.toBeDefined();
  });

  it("reads open state from Redis — blocks traffic when Redis opened_at key exists regardless of local state", async () => {
    const mockRedis = {
      get: jest.fn().mockResolvedValue(Date.now()),
      incr: jest.fn().mockResolvedValue(1),
      set: jest.fn().mockResolvedValue("OK"),
      del: jest.fn().mockResolvedValue(1),
    };
    const svc = buildServiceWithRedis(mockRedis);

    (streamText as jest.Mock).mockImplementation(() => ({}));
    await expect(svc.processChat([{ role: "user", content: "hi" }], ACTOR)).rejects.toThrow("temporarily unavailable");
  });
});
