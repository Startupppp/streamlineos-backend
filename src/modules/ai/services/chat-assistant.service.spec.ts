jest.mock("ai", () => ({
  streamText: jest.fn(),
  tool: jest.fn((def: unknown) => def),
  stepCountIs: jest.fn(() => () => false),
}));
jest.mock("@composio/core", () => ({ Composio: jest.fn() }));
jest.mock("../workspace-copilot-tools", () => ({ WorkspaceCopilotTools: jest.fn() }));
jest.mock("../comms-copilot-tools", () => ({ CommsCopilotTools: jest.fn() }));
jest.mock("../../calendar/calendar.service", () => ({ CalendarService: jest.fn() }));
jest.mock("../../integrations/composio.gateway", () => ({ ComposioGateway: jest.fn() }));
jest.mock("../../../common/ratelimit/rate-limit.service", () => ({ RateLimitService: jest.fn() }));

import { BadRequestException } from "@nestjs/common";
import { streamText } from "ai";
import { ChatAssistantService } from "./chat-assistant.service";
import { AI_CREDIT_LEDGER, type AiCreditLedger } from "../gateway/credit-ledger.interface";
import type { AiUsageService } from "./ai-usage.service";

const ACTOR = {
  userId: "user_1",
  orgId: "org_1",
  branchId: null,
  role: "ADMIN",
  permissions: [],
  enabledModules: [],
  plan: "PROFESSIONAL",
  isPlatformAdmin: false,
  isOrgOwner: false,
  sessionId: "sess_1",
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

function makeFakeStream(onFinishCb?: (opts: { text: string }) => Promise<void>) {
  return {
    _onFinish: onFinishCb,
    triggerFinish: async (text: string) => {
      if (onFinishCb) await onFinishCb({ text });
    },
  };
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
    let capturedOnFinish: ((opts: { text: string }) => Promise<void>) | undefined;

    (streamText as jest.Mock).mockImplementation((opts: { onFinish?: (o: { text: string }) => Promise<void> }) => {
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

  it("throws BadRequestException and does NOT call streamText when credits are exhausted", async () => {
    const ledger = makeLedger({
      reserve: jest.fn().mockRejectedValue(new BadRequestException("Insufficient AI credits")),
    });

    (streamText as jest.Mock).mockImplementation(() => ({}));

    const { svc } = buildService(ledger);

    await expect(
      svc.processChat([{ role: "user", content: "hello" }], ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);

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
    expect(ledger.release).toHaveBeenCalledWith(42, "stream_setup_error");
  });
});
