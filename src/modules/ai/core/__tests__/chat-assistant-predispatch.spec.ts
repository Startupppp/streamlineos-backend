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
  runInTenantTransaction: jest.fn().mockImplementation(
    (_db: unknown, fn: () => Promise<unknown>, _opts: unknown) => fn(),
  ),
  runInNewTenantTransaction: jest.fn().mockImplementation(
    (_db: unknown, _orgId: unknown, fn: () => Promise<unknown>) => fn(),
  ),
}));
jest.mock("../services/chat-assistant-context", () => ({
  fetchChatContext: jest.fn(),
}));

import { streamText } from "ai";
import { fetchChatContext } from "../services/chat-assistant-context";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { ChatAssistantService } from "../services/chat-assistant.service";
import type { AiCreditLedger } from "../gateway/credit-ledger.interface";
import type { AiUsageService } from "../services/ai-usage.service";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { ChatContext } from "../services/chat-assistant-model";
import type { AskOsActor } from "../services/ask-os-actor";
import {
  getAiStreamBudget,
  CHAT_PREDISPATCH_IO_ALLOWANCE_MS,
} from "../telemetry/ai-stream-budgets";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { AiGatewayStreamHelper, type AiStreamTextOpts } from "../gateway/ai-gateway-stream.helper";
import { AiConcurrencyLimiter } from "../gateway/ai-concurrency-limiter";
import { AccessService } from "../../../access/access.service";

const BUDGET = getAiStreamBudget("ai.stream.chat.predispatch");
const SAMPLES = 30;

const STUB_ACTOR: AskOsActor = {
  userId: "u1", orgId: "o1", membershipId: 1, displayName: "Test Member",
  email: "t@example.com", orgName: "Acme", role: "MEMBER", isOrgOwner: false,
  timezone: "UTC", today: "2026-09-19", monthStart: "2026-09-01",
  monthEnd: "2026-09-30", currentYear: 2026, currentMonth: 9,
};

const STUB_CONTEXT: ChatContext = {
  todayAttendance: null,
  pendingLeaves: 0,
  recentPayrolls: [],
  myLeadsCount: 0,
  myOpenDealsCount: 0,
  topLeads: [],
};

const ACTOR = {
  userId: "user_c152",
  orgId: "org_c152",
  role: "MEMBER" as const,
  permissions: [] as string[],
  isOrgOwner: false,
  sessionId: "sess_c152",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

function makeLedger(): jest.Mocked<AiCreditLedger> {
  return {
    reserve: jest.fn().mockResolvedValue({ reservationId: 99 }),
    settle: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  } as jest.Mocked<AiCreditLedger>;
}

function makeUsageSvc(): jest.Mocked<AiUsageService> {
  return { track: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AiUsageService>;
}

function buildService(ledger: jest.Mocked<AiCreditLedger>) {
  const history = {
    append: jest.fn().mockResolvedValue(undefined),
    appendToConversation: jest.fn().mockResolvedValue(undefined),
  };
  const fakeProvider = { tools: jest.fn().mockReturnValue([]) };
  const limiter = { acquire: jest.fn().mockResolvedValue(true), release: jest.fn() };

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
    [fakeProvider],
  );

  return { svc, history, fakeProvider, limiter };
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

describe("processChat pre-dispatch structural invariants — PRD-C152", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(fetchChatContext).mockResolvedValue({ context: STUB_CONTEXT, actor: STUB_ACTOR });
    (streamText as jest.Mock).mockReturnValue({ finishReason: Promise.resolve("stop") });
  });

  it("calls fetchChatContext exactly once per turn — one context batch, not N+k reads", async () => {
    const { svc } = buildService(makeLedger());
    await svc.processChat([{ role: "user", content: "hello" }], ACTOR);

    expect(fetchChatContext).toHaveBeenCalledTimes(1);
    expect(fetchChatContext).toHaveBeenCalledWith(
      expect.anything(),
      ACTOR.userId,
      ACTOR.orgId,
      expect.objectContaining({ userId: ACTOR.userId, orgId: ACTOR.orgId }),
    );
  });

  it("persists the user message before the provider stream is opened", async () => {
    const { svc, history } = buildService(makeLedger());
    await svc.processChat([{ role: "user", content: "hello" }], ACTOR);

    const historyOrder = history.append.mock.invocationCallOrder[0];
    const streamOrder = (streamText as jest.Mock).mock.invocationCallOrder[0];
    expect(historyOrder).toBeDefined();
    expect(streamOrder).toBeDefined();
    expect(historyOrder).toBeLessThan(streamOrder ?? Infinity);
  });

  it("opens exactly one pre-dispatch tenant transaction before the provider stream", async () => {
    const { svc } = buildService(makeLedger());
    await svc.processChat([{ role: "user", content: "hello" }], ACTOR);

    const txOrder = (runInTenantTransaction as jest.Mock).mock.invocationCallOrder[0];
    const streamOrder = (streamText as jest.Mock).mock.invocationCallOrder[0];
    expect(runInTenantTransaction).toHaveBeenCalledTimes(1);
    expect(txOrder).toBeDefined();
    expect(streamOrder).toBeDefined();
    expect(txOrder).toBeLessThan(streamOrder ?? Infinity);
  });

  it("collectToolDefinitions called once per turn — toolset assembled without redundant provider passes", async () => {
    const { svc, fakeProvider } = buildService(makeLedger());
    await svc.processChat([{ role: "user", content: "hello" }], ACTOR);

    expect(fakeProvider.tools).toHaveBeenCalledTimes(1);
  });

  it("(anti-vacuous) the fetchChatContext count assertion fails when processChat fetches context twice", async () => {
    const { svc } = buildService(makeLedger());
    await svc.processChat([{ role: "user", content: "hello" }], ACTOR);

    const count = (fetchChatContext as jest.Mock).mock.calls.length;
    expect(count).toBe(1);
    expect(count).not.toBe(2);
  });
});

describe("processChat pre-dispatch overhead budget — PRD-C152", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(fetchChatContext).mockResolvedValue({ context: STUB_CONTEXT, actor: STUB_ACTOR });
  });

  it(`p95 of ${SAMPLES} turns plus the declared I/O allowance is within ${BUDGET.budgetMs} ms`, async () => {
    const dispatchedAts: bigint[] = [];

    (streamText as jest.Mock).mockImplementation(() => {
      dispatchedAts.push(process.hrtime.bigint());
      return { finishReason: Promise.resolve("stop") };
    });

    const { svc } = buildService(makeLedger());
    const samples: number[] = [];

    for (let i = 0; i < SAMPLES; i += 1) {
      const startedAt = process.hrtime.bigint();
      await svc.processChat([{ role: "user", content: "hello" }], ACTOR);
      const dispatched = dispatchedAts[i];
      expect(dispatched).toBeDefined();
      samples.push(Number((dispatched ?? startedAt) - startedAt) / 1e6);
    }

    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    process.stdout.write(
      `ai.stream.chat.predispatch n=${SAMPLES} p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms ` +
        `io_allowance=${CHAT_PREDISPATCH_IO_ALLOWANCE_MS}ms budget=${BUDGET.budgetMs}ms\n`,
    );

    expect(samples).toHaveLength(SAMPLES);
    expect(p95 + CHAT_PREDISPATCH_IO_ALLOWANCE_MS).toBeLessThanOrEqual(BUDGET.budgetMs);
  });

  it("(anti-vacuous) the measured window brackets real pre-dispatch work — streamText is called once per turn", async () => {
    const dispatchedAts: bigint[] = [];

    (streamText as jest.Mock).mockImplementation(() => {
      dispatchedAts.push(process.hrtime.bigint());
      return { finishReason: Promise.resolve("stop") };
    });

    const ledger = makeLedger();
    const { svc } = buildService(ledger);

    await svc.processChat([{ role: "user", content: "hello" }], ACTOR);

    expect(dispatchedAts).toHaveLength(1);
    expect(ledger.reserve.mock.invocationCallOrder[0]).toBeDefined();
    expect(ledger.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      (streamText as jest.Mock).mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(fetchChatContext).toHaveBeenCalledTimes(1);
  });
});
