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
                controller.enqueue({ type: "finish", finishReason: "tool-calls", usage });
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
              controller.enqueue({ type: "finish", finishReason: "stop", usage });
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
            controller.enqueue({ type: "finish", finishReason: "stop", usage });
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
jest.mock("../workspace-copilot-tools", () => ({ WorkspaceCopilotTools: jest.fn() }));
jest.mock("../comms-copilot-tools", () => ({ CommsCopilotTools: jest.fn() }));
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

interface StreamTextOpts {
  onAbort?: () => void;
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
    ledger,
    null,
    { acquire: jest.fn().mockResolvedValue(true), release: jest.fn() } as never,
  );

  jest.spyOn(svc as never, "fetchContext").mockResolvedValue(STUB_CONTEXT as never);
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

  it("releases the reservation and never settles when the turn is aborted mid-step-two", async () => {
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
    opts.onAbort?.();
    await opts.onFinish?.({ text: "", usage: {} });
    await new Promise((r) => setTimeout(r, 10));

    expect(ledger.release).toHaveBeenCalledWith(42, "stream_aborted_no_settle", "org_1");
    expect(ledger.settle).not.toHaveBeenCalled();
  });

  it("releases once, however many times the SDK notifies", async () => {
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
    opts.onAbort?.();
    opts.onAbort?.();
    await opts.onFinish?.({ text: "partial", usage: { inputTokens: 30, outputTokens: 10 } });
    await new Promise((r) => setTimeout(r, 10));

    expect(ledger.release).toHaveBeenCalledTimes(1);
    expect(ledger.settle).not.toHaveBeenCalled();
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
