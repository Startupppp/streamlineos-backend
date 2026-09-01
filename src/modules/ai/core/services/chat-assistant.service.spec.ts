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
  projectCount: 0, ticketCount: 0, todayAttendance: null, pendingLeaves: 0,
  recentPayrolls: [], myLeadsCount: 0, hotLeadsCount: 0, myOpenDealsCount: 0, topLeads: [],
};

function buildService(ledger: jest.Mocked<AiCreditLedger>, usageSvc?: jest.Mocked<AiUsageService>) {
  const history = {
    append: jest.fn().mockResolvedValue(undefined),
    appendToConversation: jest.fn().mockResolvedValue(undefined),
  };

  const toolAccess = { denyReason: jest.fn().mockResolvedValue(null) };
  const moduleRef = { get: jest.fn().mockReturnValue({ ask: jest.fn() }) };
  const noop = { buildTools: jest.fn().mockReturnValue({}) };

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
    toolAccess as never,
    moduleRef as never,
    usageSvc ?? makeUsageSvc(),
    ledger,
  );

  jest.spyOn(svc as never, "fetchContext").mockResolvedValue(STUB_CONTEXT as never);

  return { svc, history, ledger };
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
