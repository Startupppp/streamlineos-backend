import { Test, type TestingModule } from "@nestjs/testing";
import { z } from "zod";
import { InsufficientAiCreditsException } from "../../../../../common/http/api-exceptions";
import {
  resetSpanExporter,
  runWithObservabilityContext,
  setSpanExporter,
  type FinishedSpan,
} from "../../../../../common/observability";
import { AuditService } from "../../../../../common/audit/audit.service";
import { AiGatewayService } from "../ai-gateway.service";
import { AI_CREDIT_LEDGER, type AiCreditLedger } from "../credit-ledger.interface";
import { LlmService } from "../../providers/llm.service";
import { EmbeddingsService } from "../../providers/embeddings.service";
import { AiUsageService } from "../../services/ai-usage.service";
import { AiConcurrencyLimiter } from "../ai-concurrency-limiter";
import { AI_CALL_SPAN_NAME } from "../../telemetry/ai-call-metrics";

const ACTOR = { orgId: "org_1", userId: "user_1" };
const PROMPT = { system: "You are helpful.", user: "Say hello" };
const FEATURE = "test.feature";
const Greeting = z.object({ message: z.string() });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Options {
  acquire?: jest.Mock;
  reserve?: jest.Mock;
  invokeTextWithUsage?: jest.Mock;
}

async function build(options: Options = {}) {
  const usage = { track: jest.fn().mockResolvedValue(undefined) };
  const llm = {
    isConfigured: jest.fn().mockReturnValue(true),
    invokeTextWithUsage:
      options.invokeTextWithUsage ??
      jest.fn().mockResolvedValue({
        text: "Hello!",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        model: "gpt-4o-mini",
      }),
    invokeStructuredWithUsage: jest.fn().mockResolvedValue({
      data: { message: "Hello!" },
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      model: "gpt-4o-mini",
    }),
  };
  const ledger: jest.Mocked<AiCreditLedger> = {
    reserve: options.reserve ?? jest.fn().mockResolvedValue({ reservationId: 42 }),
    settle: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  } as jest.Mocked<AiCreditLedger>;
  const limiter = {
    acquire: options.acquire ?? jest.fn().mockResolvedValue(true),
    release: jest.fn(),
  };
  const embeddings = {
    isConfigured: jest.fn().mockReturnValue(true),
    embedQueryRaw: jest.fn().mockResolvedValue([0.1, 0.2]),
    embedBatchRaw: jest.fn().mockResolvedValue([[0.1, 0.2]]),
    toVectorLiteral: jest.fn().mockReturnValue("[0.1,0.2]"),
  };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      AiGatewayService,
      { provide: LlmService, useValue: llm },
      { provide: EmbeddingsService, useValue: embeddings },
      { provide: AiUsageService, useValue: usage },
      { provide: AuditService, useValue: { log: jest.fn() } },
      { provide: AI_CREDIT_LEDGER, useValue: ledger },
      { provide: AiConcurrencyLimiter, useValue: limiter },
    ],
  }).compile();

  return { svc: module.get(AiGatewayService), usage, llm, ledger, limiter };
}

function capture(): FinishedSpan[] {
  const spans: FinishedSpan[] = [];
  setSpanExporter({ export: (span) => spans.push(span) });
  return spans;
}

function aiSpans(spans: FinishedSpan[]): FinishedSpan[] {
  return spans.filter((s) => s.name === AI_CALL_SPAN_NAME);
}

/** The object that actually reached the write site, not the one the test handed a mock. */
function trackedRow(usage: { track: jest.Mock }): Record<string, unknown> {
  const call: unknown = usage.track.mock.calls[0]?.[0];
  if (call === null || typeof call !== "object") throw new Error("track was never called");
  return call as Record<string, unknown>;
}

afterEach(() => resetSpanExporter());

/**
 * The seven `randomUUID()` sites. Each entry point minted its own id and passed
 * it explicitly, so the write-site default in `AiUsageService` could not rescue
 * it: every AI call and every `ai_usage_logs` row was an orphan that could not be
 * joined to the request, and per-tenant AI spend could not be attributed to one.
 */
describe("every gateway entry point joins the ambient request", () => {
  const CORRELATION = "req-ambient-1";

  it.each([
    [
      "invokeText",
      (svc: AiGatewayService) => svc.invokeText({ actor: ACTOR, feature: FEATURE, prompt: PROMPT }),
    ],
    [
      "invokeTextWithUsage",
      (svc: AiGatewayService) =>
        svc.invokeTextWithUsage({ actor: ACTOR, feature: FEATURE, prompt: PROMPT }),
    ],
    [
      "invokeStructured",
      (svc: AiGatewayService) =>
        svc.invokeStructured({ actor: ACTOR, feature: FEATURE, prompt: PROMPT, schema: Greeting }),
    ],
    [
      "invokeStructuredWithUsage",
      (svc: AiGatewayService) =>
        svc.invokeStructuredWithUsage({
          actor: ACTOR,
          feature: FEATURE,
          prompt: PROMPT,
          schema: Greeting,
        }),
    ],
    [
      "embedQueryWithCredit",
      (svc: AiGatewayService) =>
        svc.embedQueryWithCredit({ text: "hi", orgId: ACTOR.orgId, feature: FEATURE, charge: true }),
    ],
    [
      "embedBatchWithCredit",
      (svc: AiGatewayService) =>
        svc.embedBatchWithCredit({
          texts: ["hi"],
          orgId: ACTOR.orgId,
          feature: FEATURE,
          charge: true,
        }),
    ],
  ])("%s writes the request's correlation id onto the usage row", async (_name, invoke) => {
    const { svc, usage } = await build();
    await runWithObservabilityContext({ correlationId: CORRELATION }, () => invoke(svc));
    expect(trackedRow(usage)["correlationId"]).toBe(CORRELATION);
  });

  it("BITE — with no ambient context the id is minted, and it is a fresh uuid each call", async () => {
    const { svc, usage } = await build();
    await svc.invokeText({ actor: ACTOR, feature: FEATURE, prompt: PROMPT });
    await svc.invokeText({ actor: ACTOR, feature: FEATURE, prompt: PROMPT });
    const first = usage.track.mock.calls[0]?.[0] as { correlationId: string };
    const second = usage.track.mock.calls[1]?.[0] as { correlationId: string };
    expect(first.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.correlationId).not.toBe(first.correlationId);
  });

  it("the image entry points join too", async () => {
    const { svc, usage } = await build();
    await runWithObservabilityContext({ correlationId: CORRELATION }, () =>
      svc.invokeStructuredWithImage({
        actor: ACTOR,
        feature: FEATURE,
        prompt: PROMPT,
        schema: Greeting,
        images: [],
      }),
    );
    expect(trackedRow(usage)["correlationId"]).toBe(CORRELATION);
  });
});

describe("the phases reach the durable row, split three ways", () => {
  it("queue, application overhead and provider latency are separate numbers", async () => {
    const { svc, usage } = await build({
      acquire: jest.fn().mockImplementation(async () => {
        await sleep(40);
        return true;
      }),
      invokeTextWithUsage: jest.fn().mockImplementation(async () => {
        await sleep(60);
        return {
          text: "Hello!",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          model: "gpt-4o-mini",
        };
      }),
    });

    await svc.invokeText({ actor: ACTOR, feature: FEATURE, prompt: PROMPT });
    const timings = trackedRow(usage)["timings"] as {
      queueMs: number;
      providerMs: number;
      overheadMs: number;
    };

    expect(timings.queueMs).toBeGreaterThanOrEqual(30);
    expect(timings.providerMs).toBeGreaterThanOrEqual(50);
    // The 60 ms of provider time is not hiding in here.
    expect(timings.overheadMs).toBeLessThan(30);
  });

  it("the metadata written to ai_usage_logs carries every phase", async () => {
    const { svc, usage } = await build();
    await svc.invokeText({ actor: ACTOR, feature: FEATURE, prompt: PROMPT });
    const timings = trackedRow(usage)["timings"];
    expect(Object.keys(timings as object).sort()).toEqual(
      ["cacheHit", "overheadMs", "providerMs", "queueMs", "retries"].sort(),
    );
  });
});

describe("outcomes an operator must see, none of which produced a record before", () => {
  it("a concurrency rejection is recorded, and it never reached a provider", async () => {
    const spans = capture();
    const { svc, llm } = await build({ acquire: jest.fn().mockResolvedValue(false) });

    const result = await svc.invokeText({ actor: ACTOR, feature: FEATURE, prompt: PROMPT });

    expect(result.ok).toBe(false);
    expect(llm.invokeTextWithUsage).not.toHaveBeenCalled();
    expect(aiSpans(spans)[0]?.attributes["ai.outcome"]).toBe("concurrency_exceeded");
  });

  it("a wallet rejection is recorded as quota_exceeded, not as a provider failure", async () => {
    const spans = capture();
    const { svc } = await build({
      reserve: jest.fn().mockRejectedValue(new InsufficientAiCreditsException({ message: "no credits" })),
    });

    await svc.invokeText({ actor: ACTOR, feature: FEATURE, prompt: PROMPT, charge: true });
    expect(aiSpans(spans)[0]?.attributes["ai.outcome"]).toBe("quota_exceeded");
  });

  it("an oversized context is recorded before any credit is reserved", async () => {
    const spans = capture();
    const { svc, ledger } = await build();

    await svc.invokeText({
      actor: ACTOR,
      feature: FEATURE,
      prompt: { system: "s", user: "x".repeat(200) },
      maxContextChars: 100,
      charge: true,
    });

    expect(ledger.reserve).not.toHaveBeenCalled();
    expect(aiSpans(spans)[0]?.attributes["ai.outcome"]).toBe("context_too_large");
  });

  it("an in-flight dedupe hit is recorded as its own outcome", async () => {
    const spans = capture();
    const { svc } = await build({
      invokeTextWithUsage: jest.fn().mockImplementation(async () => {
        await sleep(60);
        return {
          text: "Hello!",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          model: "gpt-4o-mini",
        };
      }),
    });

    const first = svc.invokeText({ actor: ACTOR, feature: FEATURE, prompt: PROMPT, dedupe: true });
    await sleep(10);
    const second = svc.invokeText({ actor: ACTOR, feature: FEATURE, prompt: PROMPT, dedupe: true });
    await Promise.all([first, second]);

    const outcomes = aiSpans(spans).map((s) => s.attributes["ai.outcome"]);
    expect(outcomes).toContain("dedupe_hit");
    expect(outcomes).toContain("ok");
  });

  it("a client that hung up is a cancellation, not a provider failure", async () => {
    const spans = capture();
    const controller = new AbortController();
    const { svc } = await build({
      invokeTextWithUsage: jest.fn().mockImplementation(async () => {
        controller.abort();
        throw new Error("aborted");
      }),
    });

    await svc.invokeText({
      actor: ACTOR,
      feature: FEATURE,
      prompt: PROMPT,
      signal: controller.signal,
    });

    const span = aiSpans(spans)[0];
    expect(span?.attributes["ai.outcome"]).toBe("cancelled");
    expect(span?.status).toBe("ok");
  });

  it("a genuine provider failure is still an error, with the failure kind named", async () => {
    const spans = capture();
    const { svc } = await build({
      invokeTextWithUsage: jest.fn().mockRejectedValue(new Error("upstream 503")),
    });

    await svc.invokeText({ actor: ACTOR, feature: FEATURE, prompt: PROMPT });

    const span = aiSpans(spans)[0];
    expect(span?.attributes["ai.outcome"]).toBe("error");
    expect(span?.status).toBe("error");
  });
});

describe("retries are counted rather than folded into one latency number", () => {
  it("the provider's retry observer increments the metric", async () => {
    const spans = capture();
    const { svc } = await build({
      invokeTextWithUsage: jest.fn().mockImplementation((opts: { onRetry?: () => void }) => {
        opts.onRetry?.();
        opts.onRetry?.();
        return Promise.resolve({
          text: "Hello!",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          model: "gpt-4o-mini",
        });
      }),
    });

    await svc.invokeText({ actor: ACTOR, feature: FEATURE, prompt: PROMPT });
    expect(aiSpans(spans)[0]?.attributes["ai.retries"]).toBe(2);
  });

  it("a call that answered first time reports zero retries", async () => {
    const spans = capture();
    const { svc } = await build();
    await svc.invokeText({ actor: ACTOR, feature: FEATURE, prompt: PROMPT });
    expect(aiSpans(spans)[0]?.attributes["ai.retries"]).toBe(0);
  });
});
