/**
 * pipeAiUiMessageStream — tool events and credit settlement
 *
 * The text-only pipe silently discards every event that is not a text-delta.
 * ChatAssistantService runs multi-step tool calls; those events never reaching
 * the client means tool progress is invisible. pipeAiUiMessageStream routes the
 * SDK's full stream through pipeUIMessageStreamToResponse, which emits all event
 * types as SSE.
 *
 * This spec proves three things:
 *
 *  1. The UIMessageStream format is on the wire (x-vercel-ai-ui-message-stream: v1
 *     + content-type: text/event-stream + SSE body).
 *  2. Tool-call events appear in the SSE body — proven by the presence of a
 *     controlled toolCallId the text-only stream cannot produce.
 *  3. Credit settlement (release on abort, settle on completion) is unaffected
 *     by switching from pipeAiTextStream to pipeAiUiMessageStream, because the
 *     settlement callbacks live in streamText, not in the pipe.
 */
import { Controller, Post, Req, Res, UseInterceptors } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import type { Request, Response } from "express";
import type { Server } from "http";
import { Test } from "@nestjs/testing";
import { MockLanguageModelV4 } from "ai/test";
import { streamText, tool, type LanguageModel } from "ai";
import { z } from "zod";
import { AiRequestAbortInterceptor } from "../ai-request-abort.interceptor";
import { pipeAiUiMessageStream, pipeAiTextStream } from "../ai-stream-response";
import { createStreamAbortSignal, rethrowStreamRouteError } from "..";
import { AiGatewayStreamHelper } from "../../gateway/ai-gateway-stream.helper";
import { AiConcurrencyLimiter } from "../../gateway/ai-concurrency-limiter";
import type { AiCreditLedger } from "../../gateway/credit-ledger.interface";
import type { AiUsageService } from "../../services/ai-usage.service";

jest.mock("../../services/chat-assistant-model", () => ({
  CHAT_FEATURE: "chat.message",
  resolveChatModelId: () => "gemini-1.5-pro-latest",
  resolveChatModel: () => activeModel,
}));

const ORG_ID = "org_ui_probe";
const TOOL_CALL_ID = "call_probe_abc123";
const CHUNKS = 200;
const CHUNK_DELAY_MS = 10;
const PROMPT_TOKENS = 40;

let activeModel: LanguageModel;
let streamHelper: AiGatewayStreamHelper;
let ledger: jest.Mocked<AiCreditLedger>;

function usage(inputTotal: number, outputTotal: number) {
  return {
    inputTokens: { total: inputTotal, noCache: inputTotal, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: outputTotal, text: outputTotal, reasoning: 0 },
  };
}

function makeToolCallModel(): LanguageModel {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t" });
          controller.enqueue({ type: "text-delta", id: "t", delta: "Let me check." });
          controller.enqueue({ type: "text-end", id: "t" });
          controller.enqueue({
            type: "tool-call",
            toolCallId: TOOL_CALL_ID,
            toolName: "probe",
            input: "{}",
          });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage: usage(PROMPT_TOKENS, 5),
          });
          controller.close();
        },
      }),
    }),
  });
}

function makeSlowTextModel(): LanguageModel {
  return new MockLanguageModelV4({
    doStream: async (options) => ({
      stream: new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t" });
          for (let i = 0; i < CHUNKS; i += 1) {
            await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS));
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
            usage: usage(PROMPT_TOKENS, CHUNKS),
          });
          controller.close();
        },
      }),
    }),
  });
}

const probeTool = tool({
  description: "a probe tool used only in tests",
  inputSchema: z.object({}),
  execute: async () => ({ ok: true }),
});

@Controller("ui-probe")
@UseInterceptors(AiRequestAbortInterceptor)
class UiProbeController {
  @Post("ui-format")
  async uiFormat(@Req() req: Request, @Res() res: Response): Promise<void> {
    const abort = createStreamAbortSignal(req, res, 30_000);
    try {
      const stream = streamText({
        model: activeModel,
        messages: [{ role: "user", content: "test" }],
        tools: { probe: probeTool },
        abortSignal: abort.signal,
      });
      await pipeAiUiMessageStream(res, stream, { feature: "test.ui", orgId: ORG_ID });
    } catch (error) {
      rethrowStreamRouteError(error, { route: "POST /ui-probe/ui-format" });
    } finally {
      abort.dispose();
    }
  }

  @Post("text-format")
  async textFormat(@Req() req: Request, @Res() res: Response): Promise<void> {
    const abort = createStreamAbortSignal(req, res, 30_000);
    try {
      const stream = streamText({
        model: activeModel,
        messages: [{ role: "user", content: "test" }],
        tools: { probe: probeTool },
        abortSignal: abort.signal,
      });
      await pipeAiTextStream(res, stream, { feature: "test.ui", orgId: ORG_ID });
    } catch (error) {
      rethrowStreamRouteError(error, { route: "POST /ui-probe/text-format" });
    } finally {
      abort.dispose();
    }
  }

  @Post("spend")
  async spend(@Req() req: Request, @Res() res: Response): Promise<void> {
    const abort = createStreamAbortSignal(req, res, 60_000);
    try {
      const { stream } = await streamHelper.run({
        actor: { orgId: ORG_ID, userId: "user_settle_test" },
        feature: "test.ui.spend",
        prompt: { system: "sys", user: "user" },
        charge: true,
        signal: abort.signal,
      });
      await pipeAiUiMessageStream(res, stream, { feature: "test.ui.spend", orgId: ORG_ID });
    } catch (error) {
      rethrowStreamRouteError(error, { route: "POST /ui-probe/spend" });
    } finally {
      abort.dispose();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

jest.setTimeout(60_000);

describe("pipeAiUiMessageStream surfaces tool events and preserves credit settlement", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [UiProbeController],
      providers: [AiRequestAbortInterceptor],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    const server: Server = app.getHttpServer();
    server.closeAllConnections();
    await app.close();
  });

  beforeEach(() => {
    ledger = {
      reserve: jest.fn().mockResolvedValue({ reservationId: 9090 }),
      settle: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AiCreditLedger>;
    streamHelper = new AiGatewayStreamHelper(
      ledger,
      { track: jest.fn().mockResolvedValue(undefined) } as unknown as AiUsageService,
      new AiConcurrencyLimiter(),
    );
  });

  it("produces SSE format with the x-vercel-ai-ui-message-stream: v1 header", async () => {
    activeModel = makeToolCallModel();

    const response = await fetch(`${baseUrl}/ui-probe/ui-format`, { method: "POST" });

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
  });

  it("carries tool-call events in the body that the text-only stream would drop", async () => {
    activeModel = makeToolCallModel();

    const response = await fetch(`${baseUrl}/ui-probe/ui-format`, { method: "POST" });
    const body = await response.text();

    expect(body).toContain("data: ");
    expect(body).toContain(TOOL_CALL_ID);
  });

  it("(bite) pipeAiTextStream omits the UIMessageStream header and the toolCallId is absent from the body", async () => {
    activeModel = makeToolCallModel();

    const response = await fetch(`${baseUrl}/ui-probe/text-format`, { method: "POST" });
    const body = await response.text();

    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBeNull();
    expect(body).not.toContain(TOOL_CALL_ID);
    expect(body).toContain("Let me check.");
  });

  it("abort releases the reservation without settling — credit semantics survive the pipe switch", async () => {
    activeModel = makeSlowTextModel();

    const controller = new AbortController();
    const pending = fetch(`${baseUrl}/ui-probe/spend`, {
      method: "POST",
      signal: controller.signal,
    })
      .then(async (r) => {
        const reader = r.body?.getReader();
        if (!reader) return;
        for (;;) if ((await reader.read()).done) break;
      })
      .catch(() => undefined);

    await sleep(120);
    controller.abort();
    await pending;
    await sleep(600);

    expect(ledger.reserve).toHaveBeenCalledTimes(1);
    expect(ledger.settle).not.toHaveBeenCalled();
    expect(ledger.release).toHaveBeenCalledWith(9090, "stream_aborted_no_settle", ORG_ID);
  });

  it("(anti-vacuous) a non-cancelled UI stream settles the measured tokens, not releases them", async () => {
    activeModel = makeToolCallModel();

    const response = await fetch(`${baseUrl}/ui-probe/spend`, { method: "POST" });
    await response.text();
    await sleep(300);

    expect(ledger.release).not.toHaveBeenCalled();
    expect(ledger.settle).toHaveBeenCalledTimes(1);
  });
});
