/**
 * Cancelling a TOOL-USING chat turn must release the reservation and record
 * `cancelled`, not settle it and record `ok`.
 *
 * THE DEFECT. `processChat` detected cancellation in exactly one place:
 *
 *     void Promise.resolve(stream.finishReason).catch(() => { … release … });
 *
 * That only fires if `finishReason` REJECTS. Measured in the backend's own
 * `ai@7.0.51`, `dist/index.js:9209-9221`, the transform's `flush` rejects the
 * result promises only when `recordedSteps.length === 0`:
 *
 *     if (recordedSteps.length === 0 || recordedNoOutputError != null) {
 *       … self.rejectResultPromises(error); return;
 *     }
 *     const finishReason = recordedFinishReason ?? "other";
 *     self._finishReason.resolve(finishReason);
 *
 * `ChatAssistantService` is the ONLY `streamText` in the repo with `tools` plus
 * `stopWhen: stepCountIs(10)`, and a tool call ends a step. So once the model
 * has called one tool, an abort takes the RESOLVE branch, the `.catch` never
 * runs, and `flush` goes on to notify `onEnd` — which `dist/index.js:8785`
 * aliases from `onFinish`. `onFinish` then set `resolved = true` (permanently
 * disarming `releaseReservation`), called `breaker.recordSuccess()` on a
 * cancelled turn, and recorded `finish("ok")` and `settleStream` with the null
 * usage `flush` substitutes when no `finish` part ever arrived — so the
 * reservation moved to SETTLED with actualMilli 0 instead of RELEASED
 * `cancelled`, and `ai_usage_logs` never emitted `cancelled` for the surface
 * most likely to be cancelled.
 *
 * `ai-cancellation-stops-the-spend.spec.ts` cannot see this: it exercises
 * `AiGatewayStreamHelper`, which passes no tools, so it sits on the rejecting
 * branch and passes either way.
 *
 * THE FIX is `onAbort`, which the SDK notifies from the abort path
 * (`dist/index.js:9296-9304`) BEFORE it closes the controller and runs `flush`.
 * It does exactly what the `finishReason.catch` does, so the resolve branch and
 * the reject branch now have the same handler, and `onFinish`'s existing
 * `if (resolved) return` guard makes the ordering safe. `onFinish` is
 * deliberately NOT gated on `signal.aborted`: when the provider really did
 * deliver usage before the abort, the org is charged for what it produced —
 * `chat-assistant.service.spec.ts` pins that partial-output path.
 */
import { z } from "zod";

/* --------------------------------------------------------------- CONTROL */

/**
 * The SDK behaviour the defect rests on, asserted against the real `ai` package
 * rather than described. Without this, the service test below would be a fake
 * agreeing with itself.
 */
describe("ai@7 resolves finishReason on an abort once a step has been recorded", () => {
  jest.setTimeout(30_000);

  interface RealAi {
    streamText: typeof import("ai").streamText;
    stepCountIs: typeof import("ai").stepCountIs;
    tool: typeof import("ai").tool;
  }
  interface RealAiTest {
    MockLanguageModelV4: typeof import("ai/test").MockLanguageModelV4;
  }

  const realAi = jest.requireActual<RealAi>("ai");
  const { MockLanguageModelV4 } = jest.requireActual<RealAiTest>("ai/test");

  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
  };

  /**
   * Call 1 answers with a tool call, which ENDS A STEP. Call 2 streams prose
   * slowly so the test can abort in the middle of it.
   */
  function twoStepModel() {
    let call = 0;
    return new MockLanguageModelV4({
      doStream: async (options: { abortSignal?: AbortSignal }) => {
        call += 1;
        const isFirst = call === 1;
        return {
          stream: new ReadableStream({
            async start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              if (isFirst) {
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: "call-1",
                  toolName: "probe",
                  input: "{}",
                });
                controller.enqueue({
                  type: "finish",
                  finishReason: { unified: "tool-calls", raw: "tool-calls" },
                  usage,
                });
                controller.close();
                return;
              }
              controller.enqueue({ type: "text-start", id: "t" });
              for (let i = 0; i < 50; i += 1) {
                await new Promise((r) => setTimeout(r, 10));
                if (options.abortSignal?.aborted === true) {
                  controller.close();
                  return;
                }
                controller.enqueue({ type: "text-delta", id: "t", delta: `tok${i} ` });
              }
              controller.enqueue({ type: "text-end", id: "t" });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage,
              });
              controller.close();
            },
          }),
        };
      },
    });
  }

  function oneStepModel() {
    return new MockLanguageModelV4({
      doStream: async (options: { abortSignal?: AbortSignal }) => ({
        stream: new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t" });
            for (let i = 0; i < 50; i += 1) {
              await new Promise((r) => setTimeout(r, 10));
              if (options.abortSignal?.aborted === true) {
                controller.close();
                return;
              }
              controller.enqueue({ type: "text-delta", id: "t", delta: `tok${i} ` });
            }
            controller.enqueue({ type: "text-end", id: "t" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage,
            });
            controller.close();
          },
        }),
      }),
    });
  }

  async function drainThenAbort(
    stream: { textStream: AsyncIterable<string> },
    abort: AbortController,
  ): Promise<void> {
    try {
      for await (const _chunk of stream.textStream) {
        abort.abort();
      }
    } catch {
      /* the text stream itself may end in an abort; the assertion is on finishReason */
    }
  }

  it("MULTI-STEP (the chat shape: tools + stepCountIs) — finishReason RESOLVES and onFinish fires", async () => {
    const abort = new AbortController();
    let onFinishFired = false;
    let onAbortFired = false;

    const stream = realAi.streamText({
      model: twoStepModel(),
      messages: [{ role: "user", content: "hi" }],
      tools: {
        probe: realAi.tool({
          description: "a tool whose call ends step one",
          inputSchema: z.object({}),
          execute: async () => ({ ok: true }),
        }),
      },
      stopWhen: realAi.stepCountIs(10),
      abortSignal: abort.signal,
      onAbort: () => {
        onAbortFired = true;
      },
      onFinish: () => {
        onFinishFired = true;
      },
    });

    await drainThenAbort(stream, abort);

    await expect(stream.finishReason).resolves.toBeDefined();
    expect(onAbortFired).toBe(true);
    expect(onFinishFired).toBe(true);
  });

  it("SINGLE-STEP (the gateway shape: no tools) — finishReason REJECTS, which is why the .catch was enough there", async () => {
    const abort = new AbortController();

    const stream = realAi.streamText({
      model: oneStepModel(),
      messages: [{ role: "user", content: "hi" }],
      abortSignal: abort.signal,
    });

    await drainThenAbort(stream, abort);

    await expect(stream.finishReason).rejects.toBeDefined();
  });
});

/* --------------------------------------------------------------- SERVICE */

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
  runInTenantTransaction: jest
    .fn()
    .mockImplementation((db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  runInNewTenantTransaction: jest
    .fn()
    .mockImplementation((db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn(db)),
}));

import { streamText } from "ai";
import { ChatAssistantService } from "./chat-assistant.service";
import type { AiCreditLedger } from "../gateway/credit-ledger.interface";
import type { AiUsageService } from "./ai-usage.service";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { AiGatewayStreamHelper, type AiStreamTextOpts } from "../gateway/ai-gateway-stream.helper";
import { AiConcurrencyLimiter } from "../gateway/ai-concurrency-limiter";
import { AccessService } from "../../../access/access.service";

// Annotated, deliberately. Without the annotation tsc never excess-property-checks
// this literal, which is how `permissions: []` -- a shape §5 bans and
// CurrentUserContext does not have -- survived here while the identical key was
// caught in two sibling specs. The annotation is what keeps it caught.
const ACTOR: CurrentUserContext = {
  userId: "user_1",
  orgId: "org_1",
  role: "ADMIN",
  isOrgOwner: false,
  sessionId: "sess_1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

const STUB_CONTEXT = {
  todayAttendance: null,
  pendingLeaves: 0,
  recentPayrolls: [],
  myLeadsCount: 0,
  myOpenDealsCount: 0,
  topLeads: [],
};

const STUB_ASK_OS_ACTOR = {
  userId: "user_1", orgId: "org_1", membershipId: 1, displayName: "Test Member",
  email: "member@example.com", orgName: "Acme", role: "MEMBER", isOrgOwner: false,
  timezone: "UTC", today: "2026-09-19", monthStart: "2026-09-01",
  monthEnd: "2026-09-30", currentYear: 2026, currentMonth: 9,
};

interface StreamTextOpts {
  onAbort?: (event?: {
    steps?: ReadonlyArray<{ usage?: { inputTokens?: number; outputTokens?: number } }>;
  }) => void;
  onFinish?: (opts: {
    text: string;
    usage?: { inputTokens?: number; outputTokens?: number };
  }) => Promise<void> | void;
}

function makeLedger(): jest.Mocked<AiCreditLedger> {
  return {
    reserve: jest.fn().mockResolvedValue({ reservationId: 42 }),
    settle: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  } as jest.Mocked<AiCreditLedger>;
}

function buildService(ledger: jest.Mocked<AiCreditLedger>) {
  const history = {
    append: jest.fn().mockResolvedValue(undefined),
    appendToConversation: jest.fn().mockResolvedValue(undefined),
  };
  const usageSvc = { track: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AiUsageService>;
  const limiterStub = { acquire: jest.fn().mockResolvedValue(true), release: jest.fn() };

  const streamHelper = new AiGatewayStreamHelper(
    ledger,
    usageSvc,
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
  return svc;
}

describe("ChatAssistantService — cancelling a tool-using turn", () => {
  beforeEach(() => jest.clearAllMocks());

  it("wires onAbort, the only callback the resolving branch reaches", async () => {
    let opts: StreamTextOpts = {};
    (streamText as jest.Mock).mockImplementation((o: StreamTextOpts) => {
      opts = o;
      return {};
    });

    await buildService(makeLedger()).processChat([{ role: "user", content: "hi" }], ACTOR);

    expect(typeof opts.onAbort).toBe("function");
  });

  it("settles the tokens the completed steps already burned when the turn is aborted mid-step-two", async () => {
    const ledger = makeLedger();
    let opts: StreamTextOpts = {};
    (streamText as jest.Mock).mockImplementation((o: StreamTextOpts) => {
      opts = o;
      // The resolving branch: `finishReason` is a value, not a rejection.
      return { finishReason: Promise.resolve("other") };
    });

    const controller = new AbortController();
    await buildService(ledger).processChat(
      [{ role: "user", content: "hi" }],
      ACTOR,
      undefined,
      undefined,
      controller.signal,
    );

    // Exactly the order the SDK uses: notify onAbort, close the controller,
    // then flush notifies onEnd (= onFinish) with the null usage it substitutes.
    controller.abort();
    opts.onAbort?.({
      steps: [
        { usage: { inputTokens: 900, outputTokens: 120 } },
        { usage: { inputTokens: 1_100, outputTokens: 80 } },
      ],
    });
    await opts.onFinish?.({ text: "", usage: {} });
    await new Promise((r) => setTimeout(r, 10));

    expect(ledger.settle).toHaveBeenCalledTimes(1);
    expect(ledger.settle).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ promptTokens: 2_000, completionTokens: 200 }),
    );
    expect(ledger.release).not.toHaveBeenCalled();
  });

  it("releases rather than settling when the client leaves before any step completed", async () => {
    const ledger = makeLedger();
    let opts: StreamTextOpts = {};
    (streamText as jest.Mock).mockImplementation((o: StreamTextOpts) => {
      opts = o;
      return { finishReason: Promise.resolve("other") };
    });

    const controller = new AbortController();
    await buildService(ledger).processChat(
      [{ role: "user", content: "hi" }],
      ACTOR,
      undefined,
      undefined,
      controller.signal,
    );

    controller.abort();
    opts.onAbort?.({ steps: [] });
    await new Promise((r) => setTimeout(r, 10));

    expect(ledger.settle).not.toHaveBeenCalled();
    expect(ledger.release).toHaveBeenCalledWith(42, "stream_aborted_no_settle", "org_1");
  });

  it("resolves the reservation exactly once, however many times the SDK notifies", async () => {
    const ledger = makeLedger();
    let opts: StreamTextOpts = {};
    (streamText as jest.Mock).mockImplementation((o: StreamTextOpts) => {
      opts = o;
      return { finishReason: Promise.resolve("other") };
    });

    const controller = new AbortController();
    await buildService(ledger).processChat(
      [{ role: "user", content: "hi" }],
      ACTOR,
      undefined,
      undefined,
      controller.signal,
    );

    controller.abort();
    opts.onAbort?.({ steps: [{ usage: { inputTokens: 30, outputTokens: 10 } }] });
    opts.onAbort?.({ steps: [{ usage: { inputTokens: 30, outputTokens: 10 } }] });
    await opts.onFinish?.({ text: "partial", usage: { inputTokens: 30, outputTokens: 10 } });
    await new Promise((r) => setTimeout(r, 10));

    expect(ledger.settle).toHaveBeenCalledTimes(1);
    expect(ledger.release).not.toHaveBeenCalled();
  });

  /**
   * The control on the fix. A turn that was never aborted must still settle with
   * the tokens the provider reported — `onFinish` is not gated on
   * `signal.aborted`, so the partial-output path pinned by
   * `chat-assistant.service.spec.ts` keeps charging for what was produced.
   */
  it("still settles a turn that finishes normally", async () => {
    const ledger = makeLedger();
    let opts: StreamTextOpts = {};
    (streamText as jest.Mock).mockImplementation((o: StreamTextOpts) => {
      opts = o;
      return { finishReason: Promise.resolve("stop") };
    });

    await buildService(ledger).processChat([{ role: "user", content: "hi" }], ACTOR);

    await opts.onFinish?.({ text: "done", usage: { inputTokens: 30, outputTokens: 10 } });
    await new Promise((r) => setTimeout(r, 10));

    expect(ledger.settle).toHaveBeenCalledTimes(1);
    expect(ledger.release).not.toHaveBeenCalled();
  });
});
