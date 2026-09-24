jest.mock("ai", () => ({
  streamText: jest.fn(),
  tool: jest.fn((def: unknown) => def),
  stepCountIs: jest.fn(() => () => false),
}));
jest.mock("@composio/core", () => ({ Composio: jest.fn() }));
jest.mock("../tools/workspace-copilot-tools", () => ({ WorkspaceCopilotTools: jest.fn() }));
jest.mock("../tools/comms-copilot-tools", () => ({ CommsCopilotTools: jest.fn() }));
jest.mock("../../../calendar/calendar.service", () => ({ CalendarService: jest.fn() }));
jest.mock("../../../integrations/core/composio.gateway", () => ({ ComposioGateway: jest.fn() }));
jest.mock("../../../../common/ratelimit/rate-limit.service", () => ({ RateLimitService: jest.fn() }));
jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn().mockImplementation((db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  runInNewTenantTransaction: jest.fn().mockImplementation((db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn(db)),
}));

import { HttpStatus } from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../../common/http/api-exceptions";
import { streamText } from "ai";
import { runInNewTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { ChatAssistantService } from "./chat-assistant.service";
import { type AiCreditLedger } from "../gateway/credit-ledger.interface";
import type { AiUsageService } from "./ai-usage.service";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { AiGatewayStreamHelper, type AiStreamTextOpts } from "../gateway/ai-gateway-stream.helper";
import { AiConcurrencyLimiter } from "../gateway/ai-concurrency-limiter";
import { AccessService } from "../../../access/access.service";

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

function makeLedger(overrides: Partial<AiCreditLedger> = {}): jest.Mocked<AiCreditLedger> {
  return {
    reserve: overrides.reserve ?? jest.fn().mockResolvedValue({ reservationId: 42 }),
    settle: overrides.settle ?? jest.fn().mockResolvedValue(undefined),
    release: overrides.release ?? jest.fn().mockResolvedValue(undefined),
  } as jest.Mocked<AiCreditLedger>;
}

function makeUsageSvc(): jest.Mocked<AiUsageService> {
  return { track: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AiUsageService>;
}

const STUB_CONTEXT = {
  todayAttendance: null, pendingLeaves: 0,
  recentPayrolls: [], myLeadsCount: 0, myOpenDealsCount: 0, topLeads: [],
};

const STUB_ASK_OS_ACTOR = {
  userId: "user_1", orgId: "org_1", membershipId: 1, displayName: "Test Member",
  email: "member@example.com", orgName: "Acme", role: "MEMBER", isOrgOwner: false,
  timezone: "UTC", today: "2026-09-19", monthStart: "2026-09-01",
  monthEnd: "2026-09-30", currentYear: 2026, currentMonth: 9,
};

function buildService(
  ledger: jest.Mocked<AiCreditLedger>,
  usageSvc?: jest.Mocked<AiUsageService>,
  storedOldestFirst: ReadonlyArray<{ role: string; content: string }> = [],
) {
  const history = {
    append: jest.fn().mockResolvedValue(undefined),
    appendToConversation: jest.fn().mockResolvedValue(undefined),
    listMessages: jest.fn().mockResolvedValue({
      messages: [...storedOldestFirst]
        .reverse()
        .map((m, index) => ({ id: index, role: m.role, content: m.content, createdAt: "2026-09-19T00:00:00.000Z" })),
      nextCursor: null,
    }),
  };

  const limiterStub = { acquire: jest.fn().mockResolvedValue(true), release: jest.fn() };

  const streamHelper = new AiGatewayStreamHelper(
    ledger,
    usageSvc ?? makeUsageSvc(),
    limiterStub as unknown as AiConcurrencyLimiter,
    null,
  );
  const gateway = Object.assign(Object.create(AiGatewayService.prototype), {
    streamAgenticTurn: (opts: AiStreamTextOpts) => streamHelper.run(opts),
  }) as unknown as AiGatewayService;

  const access = {
    getAccessSnapshot: jest.fn().mockResolvedValue({
      membershipId: 1,
      scopes: {},
      modules: {},
      isOrgOwner: false,
      canManageOrganizationMembership: false,
      mfa: { enforced: false, satisfied: true },
      version: 0,
    }),
  };

  const svc = new ChatAssistantService(
    {} as never,
    gateway,
    history as never,
    access as unknown as AccessService,
    [],
  );

  jest.spyOn(svc as never, "fetchContext").mockResolvedValue({ context: STUB_CONTEXT, actor: STUB_ASK_OS_ACTOR } as never);

  return { svc, history, ledger };
}

function buildServiceWithLimiter(
  ledger: jest.Mocked<AiCreditLedger>,
  limiter: { acquire: jest.Mock; release: jest.Mock },
) {
  const history = {
    append: jest.fn().mockResolvedValue(undefined),
    appendToConversation: jest.fn().mockResolvedValue(undefined),
  };

  const streamHelper = new AiGatewayStreamHelper(
    ledger,
    makeUsageSvc(),
    limiter as unknown as AiConcurrencyLimiter,
    null,
  );
  const gateway = Object.assign(Object.create(AiGatewayService.prototype), {
    streamAgenticTurn: (opts: AiStreamTextOpts) => streamHelper.run(opts),
  }) as unknown as AiGatewayService;

  const access = {
    getAccessSnapshot: jest.fn().mockResolvedValue({
      membershipId: 1,
      scopes: {},
      modules: {},
      isOrgOwner: false,
      canManageOrganizationMembership: false,
      mfa: { enforced: false, satisfied: true },
      version: 0,
    }),
  };

  const svc = new ChatAssistantService(
    {} as never,
    gateway,
    history as never,
    access as unknown as AccessService,
    [],
  );

  jest.spyOn(svc as never, "fetchContext").mockResolvedValue({ context: STUB_CONTEXT, actor: STUB_ASK_OS_ACTOR } as never);

  return { svc, history };
}

describe("ChatAssistantService — credit charging", () => {
  beforeEach(() => jest.clearAllMocks());

  it("reserves credits before calling streamText", async () => {
    const ledger = makeLedger();
    const callOrder: string[] = [];

    ledger.reserve.mockImplementation(async () => {
      callOrder.push("reserve");
      return { reservationId: 42 };
    });

    (streamText as jest.Mock).mockImplementation(() => {
      callOrder.push("stream");
      return {};
    });

    const { svc } = buildService(ledger);
    await svc.processChat([{ role: "user", content: "hello" }], ACTOR);

    expect(callOrder[0]).toBe("reserve");
    expect(callOrder[1]).toBe("stream");
    expect(ledger.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org_1", userId: "user_1", feature: "chat.message" }),
    );
  });

  it("settles ledger inside onFinish callback", async () => {
    const ledger = makeLedger();
    let capturedOnFinish: ((opts: { text: string; usage?: { inputTokens?: number; outputTokens?: number } }) => Promise<void>) | undefined;

    (streamText as jest.Mock).mockImplementation((opts: { onFinish?: typeof capturedOnFinish }) => {
      capturedOnFinish = opts.onFinish;
      return {};
    });

    const { svc } = buildService(ledger);
    await svc.processChat([{ role: "user", content: "hi" }], ACTOR);

    expect(capturedOnFinish).toBeDefined();
    await capturedOnFinish?.({ text: "Hello!" });

    await new Promise((r) => setTimeout(r, 10));
    expect(ledger.settle).toHaveBeenCalledWith(42, expect.objectContaining({ model: expect.any(String) }));
  });

  it("throws 402 and does NOT call streamText when credits are exhausted", async () => {
    const ledger = makeLedger({
      reserve: jest.fn().mockRejectedValue(new InsufficientAiCreditsException()),
    });

    (streamText as jest.Mock).mockImplementation(() => ({}));

    const { svc } = buildService(ledger);

    const error: unknown = await svc
      .processChat([{ role: "user", content: "hello" }], ACTOR)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InsufficientAiCreditsException);
    expect(
      error instanceof InsufficientAiCreditsException ? error.getStatus() : null,
    ).toBe(HttpStatus.PAYMENT_REQUIRED);
    expect(streamText).not.toHaveBeenCalled();
  });

  it("releases ledger reservation when streamText setup throws", async () => {
    const ledger = makeLedger();
    (streamText as jest.Mock).mockImplementation(() => {
      throw new Error("Stream setup failed");
    });

    const { svc } = buildService(ledger);

    await expect(
      svc.processChat([{ role: "user", content: "hello" }], ACTOR),
    ).rejects.toThrow("Stream setup failed");

    await new Promise((r) => setTimeout(r, 10));
    expect(ledger.release).toHaveBeenCalledWith(42, "stream_setup_error", "org_1");
  });
});

describe("ChatAssistantService — abort signal propagation (criterion 9)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("passes abortSignal to streamText when a signal is provided", async () => {
    const ledger = makeLedger();
    let capturedAbortSignal: AbortSignal | undefined;

    (streamText as jest.Mock).mockImplementation((opts: { abortSignal?: AbortSignal }) => {
      capturedAbortSignal = opts.abortSignal;
      return {};
    });

    const controller = new AbortController();
    const { svc } = buildService(ledger);
    await svc.processChat([{ role: "user", content: "hello" }], ACTOR, undefined, undefined, controller.signal);

    expect(capturedAbortSignal).toBeDefined();
    expect(capturedAbortSignal).toBe(controller.signal);
  });

  it("omits abortSignal from streamText when no signal is provided", async () => {
    const ledger = makeLedger();
    let streamTextOpts: Record<string, unknown> = {};

    (streamText as jest.Mock).mockImplementation((opts: Record<string, unknown>) => {
      streamTextOpts = opts;
      return {};
    });

    const { svc } = buildService(ledger);
    await svc.processChat([{ role: "user", content: "hello" }], ACTOR);

    expect(streamTextOpts["abortSignal"]).toBeUndefined();
  });

  it("settle called once with actual tokens when onFinish fires after abort (partial output path)", async () => {
    const ledger = makeLedger();
    let capturedOnFinish:
      | ((opts: { text: string; usage?: { inputTokens?: number; outputTokens?: number } }) => Promise<void>)
      | undefined;

    (streamText as jest.Mock).mockImplementation((opts: {
      onFinish?: typeof capturedOnFinish;
      abortSignal?: AbortSignal;
    }) => {
      capturedOnFinish = opts.onFinish;
      opts.abortSignal?.addEventListener("abort", () => {
        void capturedOnFinish?.({ text: "partial", usage: { inputTokens: 30, outputTokens: 10 } });
      }, { once: true });
      return {};
    });

    const controller = new AbortController();
    const { svc } = buildService(ledger);
    await svc.processChat([{ role: "user", content: "hi" }], ACTOR, undefined, undefined, controller.signal);

    controller.abort();
    await new Promise((r) => setTimeout(r, 30));

    expect(streamText).toHaveBeenCalledTimes(1);
    expect(ledger.settle).toHaveBeenCalledTimes(1);
    expect(ledger.release).not.toHaveBeenCalled();
    expect(ledger.settle).toHaveBeenCalledWith(42, expect.objectContaining({ actualMilli: expect.any(Number) }));
  });

  it("releases reservation when SDK rejects finishReason without calling onFinish (abort before any output — v7 confirmed path)", async () => {
    const ledger = makeLedger();

    let rejectFinish!: (reason: unknown) => void;
    const finishReason = new Promise<string>((_, reject) => { rejectFinish = reject; });

    (streamText as jest.Mock).mockImplementation(({ abortSignal }: { abortSignal?: AbortSignal }) => {
      abortSignal?.addEventListener("abort", () => {
        rejectFinish(new DOMException("signal aborted", "AbortError"));
      }, { once: true });
      return { finishReason };
    });

    const controller = new AbortController();
    const { svc } = buildService(ledger);
    await svc.processChat([{ role: "user", content: "hi" }], ACTOR, undefined, undefined, controller.signal);

    controller.abort();
    await new Promise((r) => setTimeout(r, 30));

    expect(ledger.settle).not.toHaveBeenCalled();
    expect(ledger.release).toHaveBeenCalledWith(42, "stream_aborted_no_settle", "org_1");
    expect(ledger.release).toHaveBeenCalledTimes(1);
  });
});

describe("ChatAssistantService — TTFT and app overhead tracking (criterion 8)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("passes ttftMs and appOverheadMs to usageSvc.track via onFinish", async () => {
    const ledger = makeLedger();
    const usageSvc = makeUsageSvc();
    let capturedOnChunk: (() => void) | undefined;
    let capturedOnFinish:
      | ((opts: { text: string; usage?: { inputTokens?: number; outputTokens?: number } }) => Promise<void>)
      | undefined;

    (streamText as jest.Mock).mockImplementation((opts: {
      onChunk?: () => void;
      onFinish?: typeof capturedOnFinish;
    }) => {
      capturedOnChunk = opts.onChunk;
      capturedOnFinish = opts.onFinish;
      return {};
    });

    const { svc } = buildService(ledger, usageSvc);
    await svc.processChat([{ role: "user", content: "hello" }], ACTOR);

    capturedOnChunk?.();
    await new Promise((r) => setTimeout(r, 5));
    await capturedOnFinish?.({ text: "response", usage: { inputTokens: 10, outputTokens: 5 } });
    await new Promise((r) => setTimeout(r, 10));

    expect(usageSvc.track).toHaveBeenCalledTimes(1);
    const trackArgs = (usageSvc.track as jest.Mock).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(typeof trackArgs["ttftMs"]).toBe("number");
    expect((trackArgs["ttftMs"] as number)).toBeGreaterThanOrEqual(0);
    expect(typeof trackArgs["appOverheadMs"]).toBe("number");
    expect((trackArgs["appOverheadMs"] as number)).toBeGreaterThanOrEqual(0);
  });

  it("ttftMs remains undefined when onChunk never fires", async () => {
    const ledger = makeLedger();
    const usageSvc = makeUsageSvc();
    let capturedOnFinish:
      | ((opts: { text: string; usage?: { inputTokens?: number; outputTokens?: number } }) => Promise<void>)
      | undefined;

    (streamText as jest.Mock).mockImplementation((opts: { onFinish?: typeof capturedOnFinish }) => {
      capturedOnFinish = opts.onFinish;
      return {};
    });

    const { svc } = buildService(ledger, usageSvc);
    await svc.processChat([{ role: "user", content: "hello" }], ACTOR);
    await capturedOnFinish?.({ text: "", usage: { inputTokens: 0, outputTokens: 0 } });
    await new Promise((r) => setTimeout(r, 10));

    expect(usageSvc.track).toHaveBeenCalledTimes(1);
    const trackArgs = (usageSvc.track as jest.Mock).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(trackArgs["ttftMs"]).toBeUndefined();
  });
});

describe("ChatAssistantService — circuit breaker (criterion 9)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("opens after 5 consecutive provider failures and rejects with ServiceUnavailableException before calling streamText", async () => {
    const ledger = makeLedger();
    (streamText as jest.Mock).mockImplementation(() => {
      throw new Error("provider down");
    });

    const { svc } = buildService(ledger);

    for (let i = 0; i < 5; i++) {
      await expect(svc.processChat([{ role: "user", content: "hi" }], ACTOR)).rejects.toThrow("provider down");
    }

    const callsBefore = (streamText as jest.Mock).mock.calls.length;
    await expect(svc.processChat([{ role: "user", content: "hi" }], ACTOR)).rejects.toThrow("temporarily unavailable");
    expect((streamText as jest.Mock).mock.calls.length).toBe(callsBefore);
  });
});

describe("ChatAssistantService — streaming transaction isolation", () => {
  beforeEach(() => jest.clearAllMocks());

  it("resolves before onFinish fires, then onFinish opens its own tenant transaction", async () => {
    const callOrder: string[] = [];
    let capturedOnFinish:
      | ((opts: { text: string; usage?: { inputTokens?: number; outputTokens?: number } }) => Promise<void>)
      | undefined;

    (streamText as jest.Mock).mockImplementation(
      (opts: { onFinish?: typeof capturedOnFinish }) => {
        capturedOnFinish = opts.onFinish;
        callOrder.push("stream-setup");
        return {};
      },
    );

    const ledger = makeLedger();
    const { svc } = buildService(ledger);
    await svc.processChat([{ role: "user", content: "hi" }], ACTOR);
    callOrder.push("handler-resolved");

    expect(capturedOnFinish).toBeDefined();
    await capturedOnFinish?.({ text: "assistant reply", usage: { inputTokens: 10, outputTokens: 5 } });
    callOrder.push("onFinish-complete");

    expect(callOrder).toEqual(["stream-setup", "handler-resolved", "onFinish-complete"]);
    expect(runInNewTenantTransaction as jest.Mock).toHaveBeenCalledWith(
      expect.anything(),
      ACTOR.orgId,
      expect.any(Function),
    );
  });
});

describe("ChatAssistantService — settle/release determinism (item 1)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("finishReason resolving BEFORE onFinish does not release — only onFinish settles", async () => {
    const ledger = makeLedger();
    let capturedOnFinish:
      | ((opts: { text: string; usage?: { inputTokens?: number; outputTokens?: number } }) => Promise<void>)
      | undefined;
    let finishResolve!: (v: string) => void;
    const finishReason = new Promise<string>((resolve) => { finishResolve = resolve; });

    (streamText as jest.Mock).mockImplementation((opts: { onFinish?: typeof capturedOnFinish }) => {
      capturedOnFinish = opts.onFinish;
      return { finishReason };
    });

    const { svc } = buildService(ledger);
    await svc.processChat([{ role: "user", content: "hi" }], ACTOR);

    finishResolve("stop");
    await new Promise((r) => setTimeout(r, 10));

    expect(ledger.settle).not.toHaveBeenCalled();
    expect(ledger.release).not.toHaveBeenCalled();

    await capturedOnFinish?.({ text: "reply", usage: { inputTokens: 10, outputTokens: 5 } });
    await new Promise((r) => setTimeout(r, 10));

    expect(ledger.settle).toHaveBeenCalledTimes(1);
    expect(ledger.release).not.toHaveBeenCalled();
  });

  it("finishReason resolving AFTER onFinish does not double-charge — settle exactly once", async () => {
    const ledger = makeLedger();
    let capturedOnFinish:
      | ((opts: { text: string; usage?: { inputTokens?: number; outputTokens?: number } }) => Promise<void>)
      | undefined;
    let finishResolve!: (v: string) => void;
    const finishReason = new Promise<string>((resolve) => { finishResolve = resolve; });

    (streamText as jest.Mock).mockImplementation((opts: { onFinish?: typeof capturedOnFinish }) => {
      capturedOnFinish = opts.onFinish;
      return { finishReason };
    });

    const { svc } = buildService(ledger);
    await svc.processChat([{ role: "user", content: "hi" }], ACTOR);

    await capturedOnFinish?.({ text: "reply", usage: { inputTokens: 10, outputTokens: 5 } });
    await new Promise((r) => setTimeout(r, 10));

    expect(ledger.settle).toHaveBeenCalledTimes(1);
    expect(ledger.release).not.toHaveBeenCalled();

    finishResolve("stop");
    await new Promise((r) => setTimeout(r, 10));

    expect(ledger.settle).toHaveBeenCalledTimes(1);
    expect(ledger.release).not.toHaveBeenCalled();
  });
});

describe("ChatAssistantService — output token cap and history bound (12.3 criterion 4)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("passes maxOutputTokens: 2048 to streamText", async () => {
    let capturedMaxOutputTokens: number | undefined;
    (streamText as jest.Mock).mockImplementation((opts: { maxOutputTokens?: number }) => {
      capturedMaxOutputTokens = opts.maxOutputTokens;
      return {};
    });
    const { svc } = buildService(makeLedger());
    await svc.processChat([{ role: "user", content: "hello" }], ACTOR);
    expect(capturedMaxOutputTokens).toBe(2048);
  });

  it("replays only the last 20 stored messages when the conversation is longer than 20, and prepends an omission marker for the 30 dropped turns", async () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      role: "user" as const,
      content: `q${i}`,
    }));
    let capturedMessages: { role: string; content: string }[] = [];
    (streamText as jest.Mock).mockImplementation((opts: { messages?: typeof capturedMessages }) => {
      capturedMessages = opts.messages ?? [];
      return {};
    });
    const { svc } = buildService(makeLedger(), undefined, messages);
    await svc.processChat([], ACTOR, 1);
    expect(capturedMessages).toHaveLength(21);
    expect(capturedMessages[0]?.content).toContain("30 earlier messages omitted");
    expect(capturedMessages[1]).toEqual({ role: "user", content: "q30" });
    expect(capturedMessages[20]).toEqual({ role: "user", content: "q49" });
  });

  it("replays all stored messages when the conversation is at or below the 20-message cap", async () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: "user" as const,
      content: `q${i}`,
    }));
    let capturedMessages: { role: string; content: string }[] = [];
    (streamText as jest.Mock).mockImplementation((opts: { messages?: typeof capturedMessages }) => {
      capturedMessages = opts.messages ?? [];
      return {};
    });
    const { svc } = buildService(makeLedger(), undefined, messages);
    await svc.processChat([], ACTOR, 1);
    expect(capturedMessages).toHaveLength(10);
  });

  it("drops whole messages rather than cutting content mid-message when the char budget is exhausted, and prepends an omission marker for the dropped turns", async () => {
    const messages = Array.from({ length: 10 }, () => ({
      role: "user" as const,
      content: "x".repeat(5_000),
    }));
    let capturedMessages: { role: string; content: string }[] = [];
    (streamText as jest.Mock).mockImplementation((opts: { messages?: typeof capturedMessages }) => {
      capturedMessages = opts.messages ?? [];
      return {};
    });
    const { svc } = buildService(makeLedger(), undefined, messages);
    await svc.processChat([], ACTOR, 1);
    const [markerMessage, ...contentMessages] = capturedMessages;
    expect(markerMessage?.content).toMatch(/\d+ earlier messages? omitted from context/);
    expect(contentMessages.length).toBeGreaterThan(0);
    expect(contentMessages.length).toBeLessThan(10);
    for (const msg of contentMessages)
      expect(msg.content.length).toBe(5_000);
  });
});

describe("ChatAssistantService — per-org concurrency cap (12.3 criterion 4)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("throws ServiceUnavailableException without calling streamText or reserving credits when org concurrency is exceeded", async () => {
    const ledger = makeLedger();
    const limiter = { acquire: jest.fn().mockResolvedValue(false), release: jest.fn() };
    (streamText as jest.Mock).mockImplementation(() => ({}));

    const { svc } = buildServiceWithLimiter(ledger, limiter);

    await expect(
      svc.processChat([{ role: "user", content: "hi" }], ACTOR),
    ).rejects.toThrow("Too many concurrent AI requests for this organization");

    expect(streamText).not.toHaveBeenCalled();
    expect(ledger.reserve).not.toHaveBeenCalled();
  });

  it("releases the concurrency slot in onFinish so subsequent requests are not blocked", async () => {
    const ledger = makeLedger();
    const limiter = { acquire: jest.fn().mockResolvedValue(true), release: jest.fn() };
    let capturedOnFinish: ((opts: { text: string; usage?: { inputTokens?: number; outputTokens?: number } }) => Promise<void>) | undefined;
    (streamText as jest.Mock).mockImplementation((opts: { onFinish?: typeof capturedOnFinish }) => {
      capturedOnFinish = opts.onFinish;
      return {};
    });

    const { svc } = buildServiceWithLimiter(ledger, limiter);

    await svc.processChat([{ role: "user", content: "hi" }], ACTOR);

    expect(limiter.release).not.toHaveBeenCalled();

    await capturedOnFinish?.({ text: "reply" });
    await new Promise((r) => setTimeout(r, 10));

    expect(limiter.release).toHaveBeenCalledWith("org_1");
  });

  it("releases the concurrency slot when streamText throws — slot does not leak on setup error", async () => {
    const ledger = makeLedger();
    const limiter = { acquire: jest.fn().mockResolvedValue(true), release: jest.fn() };
    (streamText as jest.Mock).mockImplementation(() => {
      throw new Error("provider setup failed");
    });

    const { svc } = buildServiceWithLimiter(ledger, limiter);

    await expect(
      svc.processChat([{ role: "user", content: "hi" }], ACTOR),
    ).rejects.toThrow("provider setup failed");

    expect(limiter.release).toHaveBeenCalledWith("org_1");
  });

  it("releases the concurrency slot when the credit reservation is rejected — an out-of-credit org does not leak a slot per request", async () => {
    const ledger = makeLedger({
      reserve: jest.fn().mockRejectedValue(
        new InsufficientAiCreditsException({ message: "out of credits" }),
      ),
    });
    const limiter = { acquire: jest.fn().mockResolvedValue(true), release: jest.fn() };
    (streamText as jest.Mock).mockImplementation(() => ({}));

    const { svc } = buildServiceWithLimiter(ledger, limiter);

    await expect(
      svc.processChat([{ role: "user", content: "hi" }], ACTOR),
    ).rejects.toBeInstanceOf(InsufficientAiCreditsException);

    expect(limiter.acquire).toHaveBeenCalledWith("org_1");
    expect(limiter.release).toHaveBeenCalledWith("org_1");
    expect(streamText).not.toHaveBeenCalled();
  });

});

describe("ChatAssistantService — a confirmation token never reaches the persisted transcript (A-19)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("persists the model's prose verbatim and appends nothing else, so a reloaded conversation cannot replay a proposal token", async () => {
    let capturedOnFinish:
      | ((opts: { text: string; usage?: { inputTokens?: number; outputTokens?: number } }) => Promise<void>)
      | undefined;
    (streamText as jest.Mock).mockImplementation(
      (opts: { onFinish?: typeof capturedOnFinish }) => {
        capturedOnFinish = opts.onFinish;
        return {};
      },
    );

    const { svc, history } = buildService(makeLedger());
    await svc.processChat(
      [{ role: "user", content: "Send a mail to someone@example.com saying hello" }],
      ACTOR,
    );
    const prose = "I've prepared that email. Confirm below and I'll send it.";
    await capturedOnFinish?.({ text: prose, usage: { inputTokens: 10, outputTokens: 5 } });

    const assistantAppends = (history.append.mock.calls as unknown[][]).filter(
      (call) => call[3] === "assistant",
    );
    expect(assistantAppends).toHaveLength(1);
    expect(assistantAppends[0]?.[4]).toBe(prose);
  });

  it("persists the user turn and the assistant turn only, so no directive payload is written as a third row", async () => {
    let capturedOnFinish:
      | ((opts: { text: string; usage?: { inputTokens?: number; outputTokens?: number } }) => Promise<void>)
      | undefined;
    (streamText as jest.Mock).mockImplementation(
      (opts: { onFinish?: typeof capturedOnFinish }) => {
        capturedOnFinish = opts.onFinish;
        return {};
      },
    );

    const { svc, history } = buildService(makeLedger());
    await svc.processChat([{ role: "user", content: "Clock me in" }], ACTOR);
    await capturedOnFinish?.({ text: "You're clocked in.", usage: { inputTokens: 4, outputTokens: 3 } });

    expect((history.append.mock.calls as unknown[][]).map((call) => call[3])).toEqual([
      "user",
      "assistant",
    ]);
  });
});

describe("the history budget charges the system prompt and the tool manifest, not history alone", () => {
  beforeEach(() => jest.clearAllMocks());

  it("keeps the newest message even when it alone exceeds the budget, marking it truncated rather than sending the model a marker with no question in it", async () => {
    const messages = [{ role: "user" as const, content: "q".repeat(60_000) }];
    let capturedMessages: { role: string; content: string }[] = [];
    (streamText as jest.Mock).mockImplementation((opts: { messages?: typeof capturedMessages }) => {
      capturedMessages = opts.messages ?? [];
      return {};
    });
    const { svc } = buildService(makeLedger(), undefined, messages);

    await svc.processChat([], ACTOR, 1);

    const turn = capturedMessages.at(-1);
    expect(turn?.content).toContain("qqq");
    expect(turn?.content).toContain("[message truncated to fit the context budget]");
  });

  it("no omission marker when all messages fit — short conversation with budget to spare", async () => {
    const messages = Array.from({ length: 3 }, (_, i) => ({
      role: "user" as const,
      content: `turn ${i}`,
    }));
    let capturedMessages: { role: string; content: string }[] = [];
    (streamText as jest.Mock).mockImplementation((opts: { messages?: typeof capturedMessages }) => {
      capturedMessages = opts.messages ?? [];
      return {};
    });
    const { svc } = buildService(makeLedger(), undefined, messages);
    await svc.processChat([], ACTOR, 1);
    expect(capturedMessages).toHaveLength(3);
    expect(capturedMessages[0]?.content).toBe("turn 0");
  });

  it("omission marker is singular when exactly one message is omitted", async () => {
    const messages = Array.from({ length: 21 }, (_, i) => ({
      role: "user" as const,
      content: `m${i}`,
    }));
    let capturedMessages: { role: string; content: string }[] = [];
    (streamText as jest.Mock).mockImplementation((opts: { messages?: typeof capturedMessages }) => {
      capturedMessages = opts.messages ?? [];
      return {};
    });
    const { svc } = buildService(makeLedger(), undefined, messages);
    await svc.processChat([], ACTOR, 1);
    expect(capturedMessages[0]?.content).toContain("1 earlier message omitted from context");
    expect(capturedMessages[0]?.content).not.toContain("messages omitted");
  });

  it("prompt overhead reduces available history budget: 7 messages of 4_000 chars each exceed the effective budget once the prompt length and MANIFEST_CHARS_ESTIMATE are subtracted from MAX_CONTEXT_CHARS", async () => {
    const messages = Array.from({ length: 7 }, () => ({
      role: "user" as const,
      content: "b".repeat(4_000),
    }));
    let capturedMessages: { role: string; content: string }[] = [];
    (streamText as jest.Mock).mockImplementation((opts: { messages?: typeof capturedMessages }) => {
      capturedMessages = opts.messages ?? [];
      return {};
    });
    const { svc } = buildService(makeLedger(), undefined, messages);
    await svc.processChat([], ACTOR, 1);
    expect(capturedMessages[0]?.content).toMatch(/\d+ earlier messages? omitted from context/);
  });

  it("MANIFEST_CHARS_ESTIMATE of 20_000 represents 62 tools at approximately 320 chars per tool for description and schema overhead combined — verify the constant bites by checking that a chat with 10 large messages does not pass them all through", async () => {
    const messages = Array.from({ length: 10 }, () => ({
      role: "user" as const,
      content: "a".repeat(4_000),
    }));
    let capturedMessages: { role: string; content: string }[] = [];
    (streamText as jest.Mock).mockImplementation((opts: { messages?: typeof capturedMessages }) => {
      capturedMessages = opts.messages ?? [];
      return {};
    });
    const { svc } = buildService(makeLedger(), undefined, messages);
    await svc.processChat([], ACTOR, 1);
    const nonMarker = capturedMessages.filter((m) => !m.content.includes("omitted"));
    expect(nonMarker.length).toBeLessThan(10);
  });
});
