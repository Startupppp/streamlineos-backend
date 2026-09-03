import { Controller, Post, Req, Res, UseInterceptors } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import type { Request, Response } from "express";
import type { Server } from "http";
import { request as httpRequest } from "http";
import { Test } from "@nestjs/testing";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModel } from "ai";
import { AiRequestAbortInterceptor } from "../ai-request-abort.interceptor";
import { respondWithAiTextStream } from "../ai-text-stream-route";
import { AiGatewayStreamHelper } from "../../gateway/ai-gateway-stream.helper";
import { AiConcurrencyLimiter } from "../../gateway/ai-concurrency-limiter";
import { computeTokenCharge } from "../../billing/ai-model-pricing.constants";
import type { AiCreditLedger } from "../../gateway/credit-ledger.interface";
import type { AiUsageService } from "../../services/ai-usage.service";

jest.mock("../../services/chat-assistant-model", () => ({
  CHAT_FEATURE: "chat.message",
  resolveChatModelId: () => "gemini-1.5-pro-latest",
  resolveChatModel: () => currentModel,
}));

interface ProviderProbe {
  deltasProduced: number;
  abortSignalSeen: AbortSignal | undefined;
}

let currentModel: LanguageModel;
let probe: ProviderProbe;

const ORG_ID = "org_probe";
const MODEL_ID = "gemini-1.5-pro-latest";
const CHUNKS = 200;
const CHUNK_DELAY_MS = 10;
const PROMPT_TOKENS = 120;

function usage(inputTotal: number, outputTotal: number) {
  return {
    inputTokens: { total: inputTotal, noCache: inputTotal, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: outputTotal, reasoning: 0 },
    totalTokens: inputTotal + outputTotal,
  };
}

/**
 * Stands in for a provider adapter and, like one, honours the abort signal the
 * SDK hands `doStream`. It counts the deltas it produced, because that is the
 * spend: a stream that keeps generating after the client left costs the org
 * money and is completely invisible from the response body, which by then
 * nobody is reading.
 */
function makeProviderModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async (options) => {
      probe.abortSignalSeen = options.abortSignal;
      return {
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
              probe.deltasProduced += 1;
              controller.enqueue({ type: "text-delta", id: "t", delta: `tok${i} ` });
            }
            controller.enqueue({ type: "text-end", id: "t" });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: usage(PROMPT_TOKENS, CHUNKS),
            });
            controller.close();
          },
        }),
      };
    },
  });
}

function makeLedger() {
  return {
    reserve: jest.fn().mockResolvedValue({ reservationId: 4242 }),
    settle: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<AiCreditLedger>;
}

let ledger: jest.Mocked<AiCreditLedger>;
let helper: AiGatewayStreamHelper;

@Controller("spend-probe")
@UseInterceptors(AiRequestAbortInterceptor)
class SpendProbeController {
  @Post("stream")
  async stream(@Req() req: Request, @Res() res: Response): Promise<void> {
    return respondWithAiTextStream(
      req,
      res,
      { feature: "blog.improve-writing", orgId: ORG_ID, route: "POST /spend-probe/stream" },
      async (signal) =>
        helper.run({
          actor: { orgId: ORG_ID, userId: "user_probe" },
          feature: "blog.improve-writing",
          prompt: { system: "sys", user: "user" },
          charge: true,
          signal,
        }),
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

jest.setTimeout(60_000);

/**
 * A streamed AI turn, over a real socket, through the real route helper, the
 * real gateway stream helper and the real `streamText` — with only the provider
 * adapter and the credit ledger doubled. Nothing below asserts on rendered text:
 * a stream whose reader has gone away still renders nothing while the provider
 * bills for every token, so the only honest assertion is on the ledger and on
 * what the provider produced.
 */
describe("cancelling a stream stops the spend, measured on the ledger", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SpendProbeController],
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
    probe = { deltasProduced: 0, abortSignalSeen: undefined };
    currentModel = makeProviderModel();
    ledger = makeLedger();
    helper = new AiGatewayStreamHelper(
      ledger,
      { track: jest.fn().mockResolvedValue(undefined) } as unknown as AiUsageService,
      new AiConcurrencyLimiter(),
    );
  });

  /**
   * The Stop button and an unmount are the same event on the wire: both abort
   * the client's `AbortController`, which tears the socket down. They are one
   * case here because the backend cannot tell them apart, and proving them
   * separately would prove the same thing twice.
   */
  it("a client-side abort (Stop, or the surface unmounting) stops the provider mid-stream", async () => {
    const controller = new AbortController();
    const pending = fetch(`${baseUrl}/spend-probe/stream`, {
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
    const producedAtAbort = probe.deltasProduced;
    await sleep(600);

    expect(producedAtAbort).toBeGreaterThan(0);
    expect(producedAtAbort).toBeLessThan(CHUNKS);
    expect(probe.deltasProduced).toBeLessThanOrEqual(producedAtAbort + 1);
    expect(probe.abortSignalSeen?.aborted).toBe(true);
  });

  it("and resolves the reservation instead of leaving it held", async () => {
    const controller = new AbortController();
    const pending = fetch(`${baseUrl}/spend-probe/stream`, {
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
    expect(ledger.release).toHaveBeenCalledWith(4242, "stream_aborted_no_settle", ORG_ID);
  });

  /**
   * The case nothing on the client can help with: the tab is gone, so no Stop
   * handler and no unmount teardown runs and the browser sends no cancel of any
   * kind — the socket simply dies. Driven with a raw request whose socket is
   * destroyed, because `fetch` always aborts cleanly and so cannot express it.
   */
  it("a socket destroyed with no client-side abort at all still stops the provider", async () => {
    await new Promise<void>((resolve) => {
      const url = new URL(`${baseUrl}/spend-probe/stream`);
      const body = "{}";
      const req = httpRequest(
        {
          host: url.hostname.replace(/^\[|\]$/g, ""),
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (res) => {
          res.on("data", () => undefined);
          setTimeout(() => {
            res.socket?.destroy();
            resolve();
          }, 150).unref();
        },
      );
      req.on("error", () => resolve());
      req.end(body);
      setTimeout(resolve, 5_000).unref();
    });

    await sleep(200);
    const producedAtDrop = probe.deltasProduced;
    await sleep(600);

    expect(producedAtDrop).toBeGreaterThan(0);
    expect(producedAtDrop).toBeLessThan(CHUNKS);
    expect(probe.deltasProduced).toBeLessThanOrEqual(producedAtDrop + 1);
    expect(probe.abortSignalSeen?.aborted).toBe(true);
    expect(ledger.settle).not.toHaveBeenCalled();
    expect(ledger.release).toHaveBeenCalledWith(4242, "stream_aborted_no_settle", ORG_ID);
  });

  /**
   * Without this the three cancellation assertions are free: a stream that never
   * produced anything and never settled would satisfy every one of them.
   */
  it("(anti-vacuous) a stream nobody cancels runs to the end and settles the measured tokens", async () => {
    const response = await fetch(`${baseUrl}/spend-probe/stream`, { method: "POST" });
    const text = await response.text();
    await sleep(300);

    const expected = computeTokenCharge(MODEL_ID, PROMPT_TOKENS, CHUNKS);

    expect(text.length).toBeGreaterThan(0);
    expect(probe.deltasProduced).toBe(CHUNKS);
    expect(probe.abortSignalSeen?.aborted).toBe(false);
    expect(ledger.release).not.toHaveBeenCalled();
    expect(ledger.settle).toHaveBeenCalledWith(
      4242,
      expect.objectContaining({
        orgId: ORG_ID,
        actualMilli: expected.milliCredits,
        promptTokens: PROMPT_TOKENS,
        completionTokens: CHUNKS,
      }),
    );
  });
});
