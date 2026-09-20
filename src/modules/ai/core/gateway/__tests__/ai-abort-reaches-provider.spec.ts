import { ChatOpenAI } from "@langchain/openai";
import { from, lastValueFrom } from "rxjs";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import type { ZodType } from "zod";
import { AiGatewayService } from "../ai-gateway.service";
import { AiConcurrencyLimiter } from "../ai-concurrency-limiter";
import { LlmService } from "../../providers/llm.service";
import { EmbeddingsService } from "../../providers/embeddings.service";
import { AiUsageService } from "../../services/ai-usage.service";
import { AuditService } from "../../../../../common/audit/audit.service";
import { AiRequestAbortInterceptor } from "../../streaming/ai-request-abort.interceptor";
import { runWithAiRequestAbort } from "../../streaming/ai-request-abort";
import type { AiCreditLedger } from "../credit-ledger.interface";

jest.mock("@langchain/openai");

const ACTOR = { orgId: "org_1", userId: "user_1" };

interface InvokeCall {
  options: { signal?: AbortSignal } | undefined;
}

/**
 * Records what the LangChain client — the provider adapter itself — was handed.
 * Asserting on what the test passed the gateway proves nothing: the signal
 * option existed on every one of these types already and still reached no
 * provider fetch, because nothing on a `@NoTenantTransaction()` route supplied
 * one.
 */
function stubProviderClient(behaviour: (options: InvokeCall["options"]) => Promise<unknown>) {
  const calls: InvokeCall[] = [];
  const MockedChatOpenAI = jest.mocked(ChatOpenAI);
  MockedChatOpenAI.mockImplementation(() => {
    const client = {
      invoke: (_messages: unknown, options?: { signal?: AbortSignal }) => {
        calls.push({ options });
        return behaviour(options);
      },
      withStructuredOutput: () => client,
    };
    return client as unknown as ChatOpenAI;
  });
  return calls;
}

/**
 * The hang-up is driven from inside the provider stub, so the call is provably
 * already in flight when it happens. Aborting from the test body instead races
 * the gateway's own pre-dispatch guard and would prove only that an
 * already-dead caller is refused.
 */
function hangsUpWhileTheProviderIsWorking(hangUp: () => void) {
  return (options: InvokeCall["options"]): Promise<unknown> =>
    new Promise((_resolve, reject) => {
      const signal = options?.signal;
      signal?.addEventListener(
        "abort",
        () => reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted")),
        { once: true },
      );
      queueMicrotask(hangUp);
    });
}

function answersWhenNotAborted(options: InvokeCall["options"]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const signal = options?.signal;
    if (signal?.aborted === true) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      return;
    }
    const timer = setTimeout(
      () =>
        resolve({
          content: "answer",
          usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        }),
      50,
    );
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      },
      { once: true },
    );
  });
}

function makeLedger() {
  return {
    reserve: jest.fn().mockResolvedValue({ reservationId: 42 }),
    settle: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<AiCreditLedger>;
}

function makeUsage() {
  return { track: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AiUsageService>;
}

function makeGateway(ledger: jest.Mocked<AiCreditLedger>, usage: jest.Mocked<AiUsageService>) {
  const audit = { log: jest.fn() } as unknown as jest.Mocked<AuditService>;
  const embeddings = new EmbeddingsService();
  const gateway = new AiGatewayService(
    new LlmService(),
    embeddings,
    usage,
    audit,
    ledger,
    new AiConcurrencyLimiter(),
  );
  return { gateway, embeddings };
}

function textOpts() {
  return {
    actor: ACTOR,
    feature: "blog.improve-writing",
    prompt: { system: "sys", user: "user" },
    charge: true,
  };
}

describe("a client hang-up reaches the provider adapter and stops the spend", () => {
  const previousKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-key";
  });

  afterAll(() => {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  });

  it("hands the ambient request signal to the LangChain client, with no call site passing one", async () => {
    const calls = stubProviderClient(answersWhenNotAborted);
    const { gateway } = makeGateway(makeLedger(), makeUsage());
    const controller = new AbortController();

    const result = await runWithAiRequestAbort(controller.signal, () =>
      gateway.invokeText(textOpts()),
    );

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options?.signal).toBe(controller.signal);
  });

  it("the signal the provider received is the one that aborts — not a detached copy", async () => {
    const controller = new AbortController();
    const calls = stubProviderClient(hangsUpWhileTheProviderIsWorking(() => controller.abort()));
    const { gateway } = makeGateway(makeLedger(), makeUsage());

    await runWithAiRequestAbort(controller.signal, () => gateway.invokeText(textOpts()));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.options?.signal?.aborted).toBe(true);
  });

  it("releases the reservation and settles NO charge when the caller hangs up mid-call", async () => {
    const controller = new AbortController();
    stubProviderClient(hangsUpWhileTheProviderIsWorking(() => controller.abort()));
    const ledger = makeLedger();
    const { gateway } = makeGateway(ledger, makeUsage());

    const result = await runWithAiRequestAbort(controller.signal, () =>
      gateway.invokeText(textOpts()),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.kind).toBe("cancelled");
    expect(ledger.reserve).toHaveBeenCalledTimes(1);
    expect(ledger.settle).not.toHaveBeenCalled();
    expect(ledger.release).toHaveBeenCalledWith(42, "cancelled", "org_1");
  });

  it("records the turn as cancelled and bills zero milli-credits", async () => {
    const controller = new AbortController();
    stubProviderClient(hangsUpWhileTheProviderIsWorking(() => controller.abort()));
    const ledger = makeLedger();
    const usage = makeUsage();
    const { gateway } = makeGateway(ledger, usage);

    await runWithAiRequestAbort(controller.signal, () => gateway.invokeText(textOpts()));

    const tracked = usage.track.mock.calls.at(-1)?.[0];
    expect(tracked?.outcome).toBe("cancelled");
    expect(tracked?.creditsMilli ?? 0).toBe(0);
  });

  it("a caller who already left never reserves credits and never reaches the provider", async () => {
    const calls = stubProviderClient(answersWhenNotAborted);
    const ledger = makeLedger();
    const { gateway } = makeGateway(ledger, makeUsage());
    const controller = new AbortController();
    controller.abort();

    const result = await runWithAiRequestAbort(controller.signal, () =>
      gateway.invokeText(textOpts()),
    );

    expect(result.ok === false && result.kind).toBe("cancelled");
    expect(ledger.reserve).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("carries the same guarantee onto the embedding leg", async () => {
    const ledger = makeLedger();
    const { gateway, embeddings } = makeGateway(ledger, makeUsage());
    const embedSpy = jest.spyOn(embeddings, "embedQueryRaw");
    const controller = new AbortController();
    controller.abort();

    const result = await gateway.embedQueryWithCredit({
      text: "question",
      orgId: "org_1",
      feature: "kb.public-embedding",
      charge: true,
      signal: controller.signal,
    });

    expect(result.ok === false && result.kind).toBe("cancelled");
    expect(ledger.reserve).not.toHaveBeenCalled();
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it("a structured call gets the same signal, so JSON surfaces cancel too", async () => {
    const calls = stubProviderClient(answersWhenNotAborted);
    const { gateway } = makeGateway(makeLedger(), makeUsage());
    const controller = new AbortController();

    await runWithAiRequestAbort(controller.signal, () =>
      gateway.invokeStructured({
        ...textOpts(),
        schema: {
          parse: (value: unknown) => value,
        } as unknown as ZodType<unknown>,
      }),
    );

    expect(calls[0]?.options?.signal).toBe(controller.signal);
  });
});

describe("the interceptor turns a real disconnect into that signal", () => {
  const previousKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-key";
  });

  afterAll(() => {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  });

  function makeStream() {
    const listeners = new Set<() => void>();
    return {
      on: (_event: "close", listener: () => void) => listeners.add(listener),
      off: (_event: "close", listener: () => void) => listeners.delete(listener),
      emitClose: () => {
        for (const l of [...listeners]) l();
      },
    };
  }

  it("a response that closes unfinished aborts the provider call and releases the reservation", async () => {
    const req = { ...makeStream(), complete: true };
    const res = { ...makeStream(), writableEnded: false };
    const calls = stubProviderClient(hangsUpWhileTheProviderIsWorking(() => res.emitClose()));
    const ledger = makeLedger();
    const { gateway } = makeGateway(ledger, makeUsage());

    const context = {
      getType: () => "http",
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext;

    let settled: unknown;
    const handler = {
      handle: () =>
        from(
          gateway.invokeText(textOpts()).then((r) => {
            settled = r;
            return r;
          }),
        ),
    } as unknown as CallHandler;

    await lastValueFrom(new AiRequestAbortInterceptor().intercept(context, handler));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.options?.signal?.aborted).toBe(true);
    expect(settled).toMatchObject({ ok: false, kind: "cancelled" });
    expect(ledger.settle).not.toHaveBeenCalled();
    expect(ledger.release).toHaveBeenCalledWith(42, "cancelled", "org_1");
  });

  it("a healthy request whose body was already drained is NOT cancelled", async () => {
    const calls = stubProviderClient(answersWhenNotAborted);
    const ledger = makeLedger();
    const { gateway } = makeGateway(ledger, makeUsage());

    const req = { ...makeStream(), complete: true };
    const res = { ...makeStream(), writableEnded: false };

    const context = {
      getType: () => "http",
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext;

    const handler = {
      handle: () => from(gateway.invokeText(textOpts())),
    } as unknown as CallHandler;

    const observable = new AiRequestAbortInterceptor().intercept(context, handler);
    const done = lastValueFrom(observable);

    req.emitClose();
    const result = await done;

    expect(calls[0]?.options?.signal?.aborted).toBe(false);
    expect(result).toMatchObject({ ok: true });
    expect(ledger.settle).toHaveBeenCalledTimes(1);
  });
});
