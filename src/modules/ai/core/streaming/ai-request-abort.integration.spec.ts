import { Body, Controller, Post, Res, UseInterceptors } from "@nestjs/common";
import type { Response } from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { AiRequestAbortInterceptor } from "./ai-request-abort.interceptor";
import { getAiRequestAbortSignal } from "./ai-request-abort";

interface Observed {
  present: boolean;
  abortedAtStart: boolean;
  abortedAtEnd: boolean;
}

const observed: Observed[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function onceAborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal === undefined) return;
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

let notifyHandlerEntered: (() => void) | undefined;
let notifyObserved: (() => void) | undefined;

@Controller("probe")
@UseInterceptors(AiRequestAbortInterceptor)
class ProbeController {
  @Post("buffered")
  async buffered(@Body() _body: unknown): Promise<{ ok: true }> {
    const signal = getAiRequestAbortSignal();
    const abortedAtStart = signal?.aborted === true;
    notifyHandlerEntered?.();
    await Promise.race([sleep(150), onceAborted(signal)]);
    observed.push({
      present: signal !== undefined,
      abortedAtStart,
      abortedAtEnd: signal?.aborted === true,
    });
    notifyObserved?.();
    return { ok: true };
  }

  @Post("streamed")
  async streamed(@Body() _body: unknown, @Res() res: Response): Promise<void> {
    const signal = getAiRequestAbortSignal();
    const abortedAtStart = signal?.aborted === true;
    await sleep(50);
    observed.push({
      present: signal !== undefined,
      abortedAtStart,
      abortedAtEnd: signal?.aborted === true,
    });
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("streamed body");
  }
}

/**
 * Mocked controller specs call the handler directly and never build a real
 * request, so they cannot see the thing that was actually broken: Express drains
 * the body before the handler runs, and the request stream is already closed by
 * then. This boots a real HTTP server and hangs a real socket up.
 */
describe("AiRequestAbortInterceptor against a real HTTP server", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [AiRequestAbortInterceptor],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    observed.length = 0;
    notifyHandlerEntered = undefined;
    notifyObserved = undefined;
  });

  it("establishes a signal that a healthy buffered request never aborts", async () => {
    const response = await fetch(`${baseUrl}/probe/buffered`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "hello" }),
    });
    await response.json();

    expect(observed).toEqual([{ present: true, abortedAtStart: false, abortedAtEnd: false }]);
  });

  it("aborts the in-flight signal when a real client hangs up mid-request", async () => {
    const controller = new AbortController();
    const entered = new Promise<void>((resolve) => {
      notifyHandlerEntered = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      notifyObserved = resolve;
    });

    const pending = fetch(`${baseUrl}/probe/buffered`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "hello" }),
      signal: controller.signal,
    }).catch(() => undefined);

    await entered;
    controller.abort();
    await pending;
    await finished;

    expect(observed).toHaveLength(1);
    expect(observed[0]?.present).toBe(true);
    expect(observed[0]?.abortedAtStart).toBe(false);
    expect(observed[0]?.abortedAtEnd).toBe(true);
  });

  it("leaves a handler that writes the response itself working, and unaborted", async () => {
    const response = await fetch(`${baseUrl}/probe/streamed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "hello" }),
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toBe("streamed body");
    expect(observed).toEqual([{ present: true, abortedAtStart: false, abortedAtEnd: false }]);
  });
});
